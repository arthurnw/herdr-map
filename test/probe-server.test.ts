import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildFleet, fleetPanes, StatusClock } from "../shared/model.ts";
import type { ProbeInput, ProbeOutput } from "../probe/usage.ts";
import {
  createUsageWatcher,
  isDue,
  markUsage,
  probeCommand,
  probeScript,
  RECENT_MS,
  RETRY_MS,
  runProbe,
  sessionRefs,
  type SessionRef,
} from "../server/probe.ts";
import { snapshotFixture } from "./fixtures.ts";

test("runs the probe with a local node, reading its script from stdin", () => {
  assert.deepEqual(probeCommand({ node: "/usr/local/bin/node" }), ["/usr/local/bin/node", ["--input-type=module-typescript", "-"]]);
});

test("runs the probe over ssh with each argument quoted", () => {
  assert.deepEqual(probeCommand({ ssh: "mini", node: "/opt/homebrew/bin/node" }), [
    "ssh",
    ["-o", "BatchMode=yes", "mini", `'/opt/homebrew/bin/node' '--input-type=module-typescript' '-'`],
  ]);
});

test("the script is the probe source plus a call carrying the input as JSON", () => {
  const script = probeScript({ refs: [{ pane: "w1:p1", kind: "pi", sessionKind: "path", session: "/it's/a path.jsonl" }] });
  assert.match(script, /export function probe\(/);
  assert.ok(script.trimEnd().endsWith(`probe({"refs":[{"pane":"w1:p1","kind":"pi","sessionKind":"path","session":"/it's/a path.jsonl"}]})));`));
});

test("runProbe runs the script in a child Node and parses its output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-map-probe-"));
  const path = join(dir, "pi.jsonl");
  const line = JSON.stringify({
    type: "message",
    message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 3, cacheRead: 40_000, cacheWrite: 0, cost: { total: 0.42 } } },
  });
  writeFileSync(path, `${line}\n`);
  const out = await runProbe(
    { node: process.execPath },
    { refs: [{ pane: "w1:p1", kind: "pi", sessionKind: "path", session: path }], roots: { pi: dir } },
  );
  assert.deepEqual(out.results[0].usage, { model: "claude-opus-5-5", contextTokens: 40_003, contextWindow: 1_000_000, costUsd: 0.42 });
});

test("runProbe rejects when the node executable is missing", async () => {
  await assert.rejects(runProbe({ node: "/nonexistent/node" }, { refs: [] }), /ENOENT/);
});

function fixtureFleet() {
  const snap = snapshotFixture();
  snap.panes[0].agent_session = { source: "herdr:claude", agent: "claude", kind: "id", value: "s-claude" };
  snap.panes[2].agent_session = { source: "herdr:pi", agent: "pi", kind: "path", value: "/pi/s.jsonl" };
  const fleet = buildFleet(snap, new StatusClock().observe(snap.agents, 1000));
  return { snap, fleet };
}

test("sessionRefs lists agents whose session herdr knows, with their status", () => {
  const { snap, fleet } = fixtureFleet();
  const refs = sessionRefs(snap, fleet);
  assert.deepEqual(
    refs.map((r) => [r.pane, r.kind, r.sessionKind, r.session, r.status]),
    [
      ["w1:p1", "claude", "id", "s-claude", "working"],
      ["w2:p1", "pi", "path", "/pi/s.jsonl", "blocked"],
    ],
  );
  assert.deepEqual(sessionRefs(undefined, undefined), []);
});

test("markUsage sets usage on the matching agents", () => {
  const { fleet } = fixtureFleet();
  markUsage(fleet, new Map([["w2:p1", { contextTokens: 5, updatedAt: 1 }]]));
  const pi = fleetPanes(fleet).find((p) => p.id === "w2:p1")!;
  assert.deepEqual(pi.agent!.usage, { contextTokens: 5, updatedAt: 1 });
});

const ref = (status: SessionRef["status"], since: number): SessionRef => ({ pane: "w1:p1", kind: "claude", sessionKind: "id", session: "s", status, since });

test("isDue reads new agents, working ones, and ones whose status just changed", () => {
  const now = 10 * RECENT_MS;
  assert.equal(isDue(ref("idle", 0), undefined, now), true, "never read");
  assert.equal(isDue(ref("working", 0), { session: "s", triedAt: now - 1 }, now), true);
  assert.equal(isDue(ref("done", now - 1000), { session: "s", triedAt: now - 1 }, now), true, "just finished");
  assert.equal(isDue(ref("idle", 0), { session: "s", triedAt: now - 1 }, now), false, "idle for a while");
  assert.equal(isDue(ref("idle", 0), { session: "s", triedAt: now - RETRY_MS, error: "transcript not found" }, now), true, "retry");
});

test("the watcher round-trips cursors, keeps numbers, and survives probe errors", async () => {
  const inputs: ProbeInput[] = [];
  const outputs: (ProbeOutput | Error)[] = [
    { results: [{ pane: "w1:p1", cursor: { path: "/t", offset: 10, tally: {} }, usage: { contextTokens: 100 } }], bytesRead: 10 },
    new Error("ssh: connect to host mini port 22: Connection refused"),
    { results: [{ pane: "w1:p1", cursor: { path: "/t", offset: 20, tally: {} }, usage: { contextTokens: 100 } }], bytesRead: 10 },
  ];
  let changes = 0;
  const logs: string[] = [];
  const w = createUsageWatcher({
    probe: { node: "node" },
    intervalMs: 1000,
    refs: () => [ref("working", Date.now())],
    onChange: () => changes++,
    run: async (input) => {
      inputs.push(input);
      const out = outputs.shift()!;
      if (out instanceof Error) throw out;
      return out;
    },
    log: (l) => logs.push(l),
  });
  await w.round();
  assert.equal(w.usage().get("w1:p1")!.contextTokens, 100);
  assert.equal(changes, 1);
  await w.round();
  assert.match(w.error()!, /Connection refused/);
  assert.equal(w.usage().get("w1:p1")!.contextTokens, 100, "numbers stay through a failed run");
  assert.equal(logs.length, 1);
  await w.round();
  assert.equal(w.error(), undefined);
  assert.equal(inputs[2].refs[0].cursor!.offset, 10, "the last good cursor is sent back");
  assert.equal(changes, 3, "the error appearing and clearing both count as changes; unchanged numbers don't");
});

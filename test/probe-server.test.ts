import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildFleet, fleetPanes, StatusClock } from "../shared/model.ts";
import type { ProbeInput, ProbeOutput } from "../probe/usage.ts";
import {
  bundleProbe,
  CLAUDE_IDLE_MS,
  createUsageWatcher,
  isDue,
  markActivity,
  markUsage,
  probeCommand,
  probeScript,
  RECENT_MS,
  RETRY_MS,
  readTranscript,
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

test("isDue sends an idle Claude Code agent once a minute, and other idle agents only once", () => {
  const now = 10 * RECENT_MS;
  const read = { session: "s", triedAt: now - CLAUDE_IDLE_MS };
  assert.equal(isDue(ref("idle", 0), { ...read, triedAt: now - CLAUDE_IDLE_MS + 1 }, now), false);
  assert.equal(isDue(ref("idle", 0), read, now), true, "its session may have moved");
  assert.equal(isDue(ref("done", 0), read, now), true);
  assert.equal(isDue({ ...ref("idle", 0), kind: "codex" }, read, now), false);
  assert.equal(isDue({ ...ref("idle", 0), kind: "pi", sessionKind: "path" }, read, now), false);
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
    probe: { node: "node", herdr: "/usr/local/bin/herdr" },
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
  assert.equal(inputs[0].herdr, "/usr/local/bin/herdr");
  assert.equal(inputs[0].refs[0].status, "working");
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

test("the watcher names the sessions of Claude Code panes left out of a run", async () => {
  const inputs: ProbeInput[] = [];
  const idle = { ...ref("idle", 0), pane: "w2:p1", session: "s-idle" };
  const w = createUsageWatcher({
    probe: { node: "node" },
    intervalMs: 1000,
    refs: () => [ref("working", Date.now()), idle],
    onChange: () => undefined,
    run: async (input) => {
      inputs.push(input);
      return {
        results: input.refs.map((r) => ({ pane: r.pane, cursor: { path: "/t", offset: 0, tally: {}, claude: { session: `${r.session}-moved`, resolvedAt: 0, grewAt: 0 } } })),
        bytesRead: 0,
      };
    },
  });
  await w.round();
  assert.equal(inputs[0].claimed, undefined, "every pane is in the first run");
  await w.round();
  assert.deepEqual(inputs[1].refs.map((r) => r.pane), ["w1:p1"]);
  assert.deepEqual(inputs[1].claimed, ["s-idle", "s-idle-moved"]);
});

test("bundleProbe merges Node imports and drops imports between probe files", () => {
  const out = bundleProbe([
    'import { a, b } from "node:fs";\nimport { x, type Y } from "./other.ts";\nexport const one = 1;',
    'import {\n  b,\n  c,\n} from "node:fs";\nimport type { Z } from "./usage.ts";\nimport { join } from "node:path";\nexport const two = 2;',
  ]);
  assert.equal(out, 'import { a, b, c } from "node:fs";\nimport { join } from "node:path";\nexport const one = 1;\nexport const two = 2;');
  assert.throws(() => bundleProbe(['import { z } from "zod";']), /only import Node built-ins/);
  assert.throws(() => bundleProbe(['import fs from "node:fs";']), /unsupported probe import/);
});

test("the joined probe reads a Claude subagent through stdin, and its transcript as text", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-map-probe-"));
  const dir = join(root, "projects", "-repos-w1");
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(join(dir, "s1.jsonl"), `${JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Look around", subagent_type: "Explore" } }], usage: { input_tokens: 5 } } })}\n`);
  writeFileSync(join(dir, "s1", "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Look around", toolUseId: "toolu_1" }));
  const sub = join(dir, "s1", "subagents", "agent-a1.jsonl");
  writeFileSync(sub, `${JSON.stringify({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Looking." }], usage: { input_tokens: 40, output_tokens: 2 } } })}\n`);
  const out = await runProbe(
    { node: process.execPath },
    { refs: [{ pane: "w1:p1", kind: "claude", sessionKind: "id", session: "s1", cwd: "/repos/w1", status: "working" }], roots: { claude: root }, herdr: "/nonexistent/herdr" },
  );
  const s = out.results[0].subagents![0];
  assert.deepEqual([s.status, s.type, s.tokens, s.path], ["running", "Explore", 42, sub]);
  assert.deepEqual(await readTranscript({ node: process.execPath }, { path: sub, kind: "claude" }), { text: "Looking.", truncated: false });
});

test("markActivity sets subagents without their transcript paths", () => {
  const { fleet } = fixtureFleet();
  const activity = {
    subagents: [{ id: "a1", status: "running" as const, path: "/t/agent-a1.jsonl" }, { id: "c1", status: "done" as const, parent: "a1", fromOrdinal: 3 }],
    tasks: { done: 1, total: 3 },
  };
  markActivity(fleet, new Map([["w1:p1", activity]]));
  const agent = fleetPanes(fleet).find((p) => p.id === "w1:p1")!.agent!;
  assert.deepEqual(agent.subagents, [{ id: "a1", status: "running", transcript: true }, { id: "c1", status: "done", parent: "a1" }]);
  assert.deepEqual(agent.tasks, { done: 1, total: 3 });
});

test("isDue keeps reading an idle agent while one of its subagents runs", () => {
  const now = 10 * RECENT_MS;
  const read = { session: "s", triedAt: now - 1 };
  const idle = { ...ref("idle", 0), kind: "pi", sessionKind: "path" };
  assert.equal(isDue(idle, { ...read, activity: { subagents: [{ id: "a", status: "running" }] } }, now), true);
  assert.equal(isDue(idle, { ...read, activity: { subagents: [{ id: "a", status: "done" }] } }, now), false);
});

test("the watcher keeps each agent's subagents and reads only transcripts the probe reported", async () => {
  const reads: unknown[] = [];
  let subagents = [{ id: "a1", status: "running" as const, path: "/t/agent-a1.jsonl" }, { id: "a2", status: "running" as const }];
  let changes = 0;
  const w = createUsageWatcher({
    probe: { node: "node" },
    intervalMs: 1000,
    refs: () => [ref("working", Date.now())],
    onChange: () => changes++,
    run: async () => ({ results: [{ pane: "w1:p1", cursor: { path: "/t", offset: 0, tally: {} }, subagents }], bytesRead: 0 }),
    read: async (req) => {
      reads.push(req);
      return { text: "Looking.", truncated: false };
    },
  });
  await w.round();
  assert.equal(changes, 1);
  assert.equal(w.activity().get("w1:p1")!.subagents!.length, 2);
  assert.deepEqual(await w.transcript("w1:p1", "a1"), { text: "Looking.", truncated: false });
  assert.deepEqual(reads, [{ path: "/t/agent-a1.jsonl", kind: "claude" }]);
  await assert.rejects(w.transcript("w1:p1", "a2"), /no transcript/);
  await assert.rejects(w.transcript("w1:p1", "nope"), /no such subagent/);
  await assert.rejects(w.transcript("w9:p9", "a1"), /no such subagent/);
  await w.round();
  assert.equal(changes, 1, "the same subagents are no change");
  subagents = [];
  await w.round();
  assert.equal(changes, 2);
  assert.equal(w.activity().size, 0, "an agent whose subagents are gone has none");
});

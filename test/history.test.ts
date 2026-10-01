import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { agentHistory, HISTORY_CHARS, keepEnd, type HistoryOutput } from "../probe/reply.ts";
import { historyLine } from "../probe/subagents.ts";
import type { Context } from "../server/context.ts";
import { createUsageWatcher, readHistory } from "../server/probe.ts";
import { createRouter } from "../server/router.ts";
import { readRoutes } from "../server/routes/read.ts";
import { transcriptRoutes } from "../server/routes/transcript.ts";
import { buildFleet, StatusClock, type SnapPane } from "../shared/model.ts";
import { historyParts } from "../web/history.ts";
import { snapshotFixture } from "./fixtures.ts";

// Synthetic transcript lines, shaped like each agent's own records.
const lines = (...ls: unknown[]) => ls.map((l) => `${JSON.stringify(l)}\n`).join("");
const tempDir = () => mkdtempSync(join(tmpdir(), "herdr-map-history-"));
function transcript(...ls: unknown[]): string {
  const path = join(tempDir(), "s.jsonl");
  writeFileSync(path, lines(...ls));
  return path;
}
const history = (kind: string, ...ls: unknown[]) => agentHistory({ ref: { pane: "w1:p1", kind, sessionKind: "path", session: "" }, path: transcript(...ls) });

const text = (t: string) => ({ type: "text", text: t });
const claudeUser = (content: unknown, extra = {}) => ({ type: "user", isSidechain: false, message: { role: "user", content }, ...extra });
const claudeSays = (block: unknown, extra = {}) => ({
  type: "assistant",
  isSidechain: false,
  message: { id: "m", role: "assistant", model: "claude-opus-5-5", content: [block] },
  ...extra,
});

test("Claude: prompts, replies, and one line per tool call, without what the user didn't write", () => {
  const out = history(
    "claude",
    { type: "permission-mode", permissionMode: "default" },
    claudeUser("<local-command-caveat>Caveat: local commands.</local-command-caveat>", { isMeta: true }),
    claudeUser("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>"),
    claudeUser("<local-command-stdout>Set model to opus</local-command-stdout>"),
    claudeUser("<bash-input>ls -la | grep x > out</bash-input>"),
    claudeUser("<bash-stdout>out</bash-stdout><bash-stderr></bash-stderr>"),
    claudeUser("Fix the parser.\n\nIt drops the last line."),
    claudeSays({ type: "thinking", thinking: "Synthetic thinking.", signature: "sig" }),
    claudeSays(text("Looking at parse.ts.")),
    claudeSays({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/parse.ts" } }),
    claudeUser([{ type: "tool_result", tool_use_id: "t1", content: "synthetic file body" }]),
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [text("A subagent's words.")] } },
    { type: "user", isSidechain: true, message: { role: "user", content: "A subagent's prompt." } },
    claudeUser("<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>"),
    claudeUser([text("<system-reminder>Synthetic reminder.</system-reminder>"), text("Also check the tests.")]),
    claudeUser("Synthetic summary of an earlier conversation.", { isCompactSummary: true }),
    claudeSays(text("API Error: 500"), { isApiErrorMessage: true }),
    { type: "assistant", isSidechain: false, message: { role: "assistant", model: "<synthetic>", content: [text("No response requested.")] } },
    { type: "system", subtype: "turn_duration", durationMs: 1000 },
    claudeSays(text("Fixed: the loop stopped one line early.")),
  );
  assert.equal(
    out.text,
    [
      "› /model opus",
      "› ! ls -la | grep x > out",
      "› Fix the parser.\n  \n  It drops the last line.",
      "Looking at parse.ts.",
      "→ Read /repo/parse.ts",
      "› Also check the tests.",
      "Fixed: the loop stopped one line early.",
    ].join("\n\n"),
  );
  assert.equal(out.truncated, false);
  assert.ok(out.path?.endsWith("s.jsonl"));
});

test("Pi: user and assistant messages and tool calls, without thinking, tool results, or other entries", () => {
  const msg = (role: string, content: unknown) => ({ type: "message", message: { role, content } });
  const out = history(
    "pi",
    { type: "session", version: 3, cwd: "/repos/w5" },
    { type: "model_change", provider: "local", modelId: "house-model" },
    msg("user", [text("Rename the flag.")]),
    msg("assistant", [{ type: "thinking", thinking: "Synthetic thinking." }, text("Searching."), { type: "toolCall", id: "c1", name: "bash", arguments: { command: "rg   oldFlag\n src" } }]),
    msg("toolResult", [text("synthetic output")]),
    msg("system", "Synthetic system note."),
    { type: "custom", customType: "synthetic-extension", data: { text: "not shown" } },
    msg("assistant", [text("Renamed in 3 files.")]),
  );
  assert.equal(out.text, ["› Rename the flag.", "Searching.\n→ bash rg oldFlag src", "Renamed in 3 files."].join("\n\n"));
});

test("Codex: prompts, answers, and tool calls, without injected context, reasoning, or tool output", () => {
  const item = (payload: unknown) => ({ type: "response_item", payload });
  const input = (...ts: string[]) => ts.map((t) => ({ type: "input_text", text: t }));
  const out = history(
    "codex",
    { type: "session_meta", payload: { id: "t", cwd: "/repos/w2" } },
    item({ type: "message", role: "developer", content: input("<permissions instructions>synthetic</permissions instructions>") }),
    item({ type: "message", role: "user", content: input("# AGENTS.md instructions for /repos/w2\n\nsynthetic", "<environment_context>synthetic</environment_context>") }),
    { type: "event_msg", payload: { type: "user_message", message: "Run the tests." } },
    item({ type: "message", role: "user", content: input("Run the tests.") }),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "Synthetic reasoning." }] }),
    item({ type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) }),
    item({ type: "function_call_output", output: "synthetic output" }),
    item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "All 12 pass." }] }),
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "All 12 pass." } },
  );
  assert.equal(out.text, ["› Run the tests.", "→ exec_command npm test", "All 12 pass."].join("\n\n"));
});

test("long histories keep their newest entries, and a read from the middle of a file says so", () => {
  assert.deepEqual(keepEnd(["aaa", "bbb", "ccc"], 8), { text: "bbb\n\nccc", cut: true });
  assert.deepEqual(keepEnd(["aaa", "bbb"], 8), { text: "aaa\n\nbbb", cut: false });
  assert.deepEqual(keepEnd(["abcdef"], 4), { text: "cdef", cut: true });
  assert.deepEqual(keepEnd([], 4), { text: "", cut: false });

  const turns = Array.from({ length: 40 }, (_, i) => [claudeUser(`Prompt ${i}.`), claudeSays(text(`${"word ".repeat(400)}reply ${i}.`))]).flat();
  const out = history("claude", ...turns);
  assert.equal(out.truncated, true);
  assert.ok(out.text!.length <= HISTORY_CHARS);
  assert.ok(out.text!.endsWith("reply 39."), "the newest reply is kept");
  assert.ok(!out.text!.includes("Prompt 0."), "the oldest turns are dropped");
  const path = transcript(...turns);
  const tail = agentHistory({ ref: { pane: "w1:p1", kind: "claude", sessionKind: "id", session: "s" }, path, bytes: 4096 });
  assert.equal(tail.truncated, true, "only the end of the file was read");
  assert.ok(tail.text!.endsWith("reply 39."));
});

test("history is read only from a transcript path, for agents it can read", () => {
  const ref = { pane: "w1:p1", kind: "claude", sessionKind: "id", session: "s" };
  assert.deepEqual(agentHistory({ ref, path: "/etc/passwd" }), { error: "not a transcript path" });
  assert.deepEqual(agentHistory({ ref: { ...ref, kind: "gemini" }, path: transcript() }), { error: "no transcript reader for gemini sessions" });
  assert.equal(historyLine("claude", { type: "summary", summary: "x" }), undefined);
});

test("the joined probe returns history through stdin, and the watcher asks for it like a reply", async () => {
  const path = transcript({ type: "message", message: { role: "user", content: [text("Go.")] } }, { type: "message", message: { role: "assistant", content: [text("Done.")] } });
  const ref = { pane: "w1:p1", kind: "pi", sessionKind: "path", session: path };
  assert.deepEqual(await readHistory({ node: process.execPath }, { ref }), { text: "› Go.\n\nDone.", truncated: false, path });

  const asked: unknown[] = [];
  const w = createUsageWatcher({
    probe: { node: "node" },
    intervalMs: 1000,
    refs: () => [{ ...ref, status: "idle", since: 0 }],
    onChange: () => undefined,
    history: async (req) => (asked.push(req), { text: "x" }),
  });
  assert.deepEqual(await w.history("w9:p9"), { error: "herdr reports no session for this agent" });
  assert.deepEqual(await w.history("w1:p1"), { text: "x" });
  assert.deepEqual(asked, [{ ref: { ...ref, status: "idle", cursor: undefined, cwd: undefined } }]);
});

test("history text splits into prompts, tool calls, and message paragraphs", () => {
  assert.deepEqual(historyParts("› Fix it.\n  \n  Please.\n\nLooking.\n\n→ Read a.ts\n\n→ Grep b\n\nFirst paragraph.\n\nSecond.\n→ bash ls"), [
    { kind: "prompt", text: "Fix it.\n\nPlease." },
    { kind: "text", text: "Looking." },
    { kind: "tool", text: "→ Read a.ts\n→ Grep b" },
    { kind: "text", text: "First paragraph." },
    { kind: "text", text: "Second." },
    { kind: "tool", text: "→ bash ls" },
  ]);
  assert.deepEqual(historyParts(""), []);
});

// Routes

async function serve(t: TestContext, history: (pane: string) => Promise<HistoryOutput>, panes?: (p: SnapPane[]) => void) {
  const snap = snapshotFixture();
  panes?.(snap.panes);
  const fleet = buildFleet(snap, new StatusClock().observe(snap.agents, 1000));
  const asked: string[] = [];
  const poller = {
    state: () => ({ fleet }),
    pane: (id: string) => snap.panes.find((p) => p.pane_id === id),
    history: (pane: string) => (asked.push(pane), history(pane)),
  };
  // A stand-in herdr that prints its arguments, for the read route.
  const bin = join(tempDir(), "herdr");
  writeFileSync(bin, '#!/bin/sh\necho "$*"\n');
  chmodSync(bin, 0o755);
  const ctx = { herdr: { bin }, poller } as unknown as Context;
  const server = createServer(createRouter([...readRoutes(ctx), ...transcriptRoutes(ctx)], (_req, res) => res.end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { get, asked };
}

test("GET /api/history returns an agent's history, and reads only agents in the fleet", async (t) => {
  const { get, asked } = await serve(t, async (pane) => (pane === "w1:p1" ? { text: "› Go.", truncated: true, path: "/t/s.jsonl" } : { error: "transcript not found" }));
  assert.deepEqual(await get("/api/history?pane=w1:p1"), { status: 200, body: { text: "› Go.", kind: "claude", truncated: true } });
  assert.deepEqual(await get("/api/history?pane=w2:p1"), { status: 404, body: { error: "transcript not found" } });
  for (const pane of ["w1:p2", "w9:p9", "/etc/passwd", "", "../w1:p1"]) {
    assert.equal((await get(`/api/history?pane=${encodeURIComponent(pane)}`)).status, 404, `${pane} isn't an agent in the fleet`);
  }
  assert.deepEqual(await get("/api/history?path=/t/s.jsonl"), { status: 404, body: { error: "no such agent" } });
  assert.deepEqual(asked, ["w1:p1", "w2:p1"], "only fleet agents reach the probe");
});

test("GET /api/history with the probe off is a 404", async (t) => {
  const { get } = await serve(t, async () => ({ error: "the usage probe is off" }));
  assert.deepEqual(await get("/api/history?pane=w1:p1"), { status: 404, body: { error: "the usage probe is off" } });
});

test("GET /api/read flags panes whose preview falls back to the screen", async (t) => {
  const { get } = await serve(
    t,
    async () => ({}),
    (panes) => {
      panes.find((p) => p.pane_id === "w1:p1")!.scroll = { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 50 };
      panes.find((p) => p.pane_id === "w2:p1")!.scroll = { max_offset_from_bottom: 900, offset_from_bottom: 0, viewport_rows: 50 };
    },
  );
  assert.deepEqual((await get("/api/read?pane=w1:p1&source=recent&lines=1000")).body, { text: "pane read w1:p1 --source visible --lines 1000\n", history: true });
  assert.deepEqual((await get("/api/read?pane=w2:p1&source=recent&lines=1000")).body, { text: "pane read w2:p1 --source recent --lines 1000\n" });
  assert.deepEqual((await get("/api/read?pane=w1:p1")).body, { text: "pane read w1:p1 --source visible --lines 60\n" }, "a hover read is never flagged");
});

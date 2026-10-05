import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentTool } from "../probe/subagents.ts";
import { probe, readLines, type Tally } from "../probe/usage.ts";
import type { JsonValue } from "./fixtures.ts";

// Synthetic transcript lines, shaped like each agent's own records.
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const lines = (...ls: JsonValue[]) => ls.map((l) => `${JSON.stringify(l)}\n`).join("");
const read = (kind: string, ...ls: JsonValue[]) => currentTool(readLines(kind, lines(...ls), {}));

const usage = { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 5 };
const claudeCall = (at: number, msg: string, id: string, name: string, input: JsonValue, sidechain = false) => ({
  type: "assistant",
  isSidechain: sidechain,
  timestamp: iso(at),
  message: { id: msg, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }], usage },
});
const claudeText = (at: number, msg: string, text: string) => ({
  type: "assistant",
  isSidechain: false,
  timestamp: iso(at),
  message: { id: msg, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], usage },
});
const claudeResult = (at: number, id: string, sidechain = false) => ({
  type: "user",
  isSidechain: sidechain,
  timestamp: iso(at),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Synthetic output." }] },
  toolUseResult: { stdout: "Synthetic output." },
});

test("Claude: a tool_use without a tool_result is the current tool, with its main argument", () => {
  assert.deepEqual(read("claude", claudeCall(T0, "msg_1", "toolu_1", "Bash", { command: "npm test", description: "Run tests" })), {
    tool: "Bash",
    summary: "npm test",
    startedAt: T0,
  });
});

test("Claude: a call with its result is done", () => {
  assert.equal(read("claude", claudeCall(T0, "msg_1", "toolu_1", "Bash", { command: "npm test" }), claudeResult(T0 + 5000, "toolu_1")), undefined);
});

test("Claude: of parallel calls, the latest one still running is current", () => {
  const msg = "msg_1";
  const tally = readLines(
    "claude",
    lines(
      claudeCall(T0, msg, "toolu_a", "Read", { file_path: "/repos/w1/a.ts" }),
      claudeCall(T0 + 10, msg, "toolu_b", "Grep", { pattern: "needle" }),
      claudeResult(T0 + 500, "toolu_b"),
    ),
    {},
  );
  assert.deepEqual(currentTool(tally), { tool: "Read", summary: "/repos/w1/a.ts", startedAt: T0 });
});

test("Claude: subagents' sidechain calls are ignored, and don't close the main thread's", () => {
  assert.equal(read("claude", claudeCall(T0, "msg_s", "toolu_s", "Bash", { command: "ls" }, true)), undefined);
  const c = read(
    "claude",
    claudeCall(T0, "msg_1", "toolu_1", "Agent", { description: "Map the auth code", prompt: "Synthetic." }),
    claudeCall(T0 + 100, "msg_s", "toolu_s", "Bash", { command: "ls" }, true),
    claudeResult(T0 + 200, "toolu_s", true),
  );
  assert.deepEqual(c, { tool: "Agent", summary: "Map the auth code", startedAt: T0 });
});

test("Claude: a new response closes calls an interrupt left without a result", () => {
  assert.equal(read("claude", claudeCall(T0, "msg_1", "toolu_1", "Bash", { command: "sleep 100" }), claudeText(T0 + 9000, "msg_2", "Stopped.")), undefined);
});

test("Claude: the open call is kept in the tally across reads", () => {
  const tally: Tally = {};
  readLines("claude", lines(claudeCall(T0, "msg_1", "toolu_1", "Bash", { command: "npm test" })), tally);
  const carried: Tally = JSON.parse(JSON.stringify(tally));
  assert.equal(currentTool(carried)?.tool, "Bash");
  readLines("claude", lines(claudeResult(T0 + 1000, "toolu_1")), carried);
  assert.equal(currentTool(carried), undefined);
  assert.equal(carried.open, undefined);
});

const codex = (at: number, type: string, payload: JsonValue) => ({ timestamp: iso(at), type, payload });

test("Codex: a function call without output is current, and its output ends it", () => {
  const call = codex(T0, "response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm run lint" }), call_id: "call_1" });
  assert.deepEqual(read("codex", call), { tool: "exec_command", summary: "npm run lint", startedAt: T0 });
  assert.equal(read("codex", call, codex(T0 + 100, "response_item", { type: "function_call_output", call_id: "call_1", output: "ok" })), undefined);
});

test("Codex: code-mode exec shows the tool and command it calls", () => {
  const input = 'const r = await tools.exec_command({"cmd":"git diff --stat","yield_time_ms":1000});\ntext(r.output);';
  const call = codex(T0, "response_item", { type: "custom_tool_call", status: "completed", call_id: "call_2", name: "exec", input });
  assert.deepEqual(read("codex", call), { tool: "exec_command", summary: "git diff --stat", startedAt: T0 });
  assert.equal(read("codex", call, codex(T0 + 100, "response_item", { type: "custom_tool_call_output", call_id: "call_2", output: [] })), undefined);
});

test("Codex: the end of a turn closes calls left open", () => {
  const call = codex(T0, "response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "make"] }), call_id: "call_3" });
  assert.deepEqual(read("codex", call), { tool: "shell", summary: "bash -lc make", startedAt: T0 });
  assert.equal(read("codex", call, codex(T0 + 100, "event_msg", { type: "turn_aborted", reason: "interrupted" })), undefined);
});

const pi = (at: number, message: JsonValue) => ({ type: "message", id: `e${at}`, timestamp: iso(at), message });

test("Pi: a tool call without a result is current, and its result ends it", () => {
  const call = pi(T0, {
    role: "assistant",
    content: [
      { type: "toolCall", id: "tc_1", name: "read", arguments: { path: "/repos/w5/a.ts" } },
      { type: "toolCall", id: "tc_2", name: "bash", arguments: { command: "npm test" } },
    ],
    usage: { input: 10, output: 5 },
  });
  assert.deepEqual(read("pi", call), { tool: "bash", summary: "npm test", startedAt: T0 });
  assert.deepEqual(read("pi", call, pi(T0 + 50, { role: "toolResult", toolCallId: "tc_2", toolName: "bash", content: [] })), {
    tool: "read",
    summary: "/repos/w5/a.ts",
    startedAt: T0,
  });
  assert.equal(
    read("pi", call, pi(T0 + 50, { role: "toolResult", toolCallId: "tc_2", toolName: "bash", content: [] }), pi(T0 + 60, { role: "user", content: [{ type: "text", text: "stop" }] })),
    undefined,
  );
});

test("probe reports the current tool with an agent's activity", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-map-current-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines(pi(T0, { role: "assistant", content: [{ type: "toolCall", id: "tc_1", name: "bash", arguments: { command: "npm test" } }], usage: { input: 10 } })));
  const out = probe({ refs: [{ pane: "w1:p1", kind: "pi", sessionKind: "path", session: path }], roots: { pi: dir } }, { now: () => T0 + 1000 });
  assert.deepEqual(out.results[0].current, { tool: "bash", summary: "npm test", startedAt: T0 });
});

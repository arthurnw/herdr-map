import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  activity,
  codexHead,
  piTokens,
  SUBAGENT_ACTIVE_MS,
  SUBAGENT_KEEP_MS,
  subagentTranscript,
  taskProgress,
  type SubagentContext,
} from "../probe/subagents.ts";
import { advance, probe, readLines, type Cursor, type Roots, type Tally } from "../probe/usage.ts";

// Synthetic transcript lines, shaped like each agent's own records.
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const lines = (...ls: unknown[]) => ls.map((l) => `${typeof l === "string" ? l : JSON.stringify(l)}\n`).join("");

const claudeAssistant = (at: number, content: unknown[], usage = { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 5 }) => ({
  type: "assistant",
  isSidechain: false,
  timestamp: iso(at),
  message: { role: "assistant", model: "claude-opus-5-5", content, usage },
});
const claudeResult = (at: number, id: string, text: string, toolUseResult?: unknown) => ({
  type: "user",
  isSidechain: false,
  timestamp: iso(at),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  toolUseResult,
});
const agentCall = (id: string, description: string, type = "Explore") => ({ type: "tool_use", id, name: "Agent", input: { description, subagent_type: type, prompt: "Synthetic task." } });
const notification = (at: number, toolUseId: string, status: string, usage = "<usage><subagent_tokens>4200</subagent_tokens><tool_uses>7</tool_uses><duration_ms>60000</duration_ms></usage>") => ({
  type: "queue-operation",
  operation: "enqueue",
  timestamp: iso(at),
  content: `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n${usage}\n</task-notification>`,
});

function tempDir() {
  return mkdtempSync(join(tmpdir(), "herdr-map-subagents-"));
}

function ctxFor(roots: Partial<Roots>, now = NOW, budget = 1 << 20): SubagentContext {
  return { roots: { claude: "", codex: "", pi: "", ...roots }, now, budget, maxLine: 1 << 20, heads: new Map() };
}

function touch(path: string, ms: number) {
  utimesSync(path, ms / 1000, ms / 1000);
}

/** A Claude Code session with one subagent's files. Returns the parent cursor. */
function claudeSession(root: string, parentLines: string, sub?: { id: string; toolUseId: string; lines: string; lastAt: number }): Cursor {
  const dir = join(root, "projects", "-repos-w1");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "s1.jsonl");
  writeFileSync(path, parentLines);
  if (sub) {
    const subs = join(dir, "s1", "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, `agent-${sub.id}.meta.json`), JSON.stringify({ agentType: "Explore", description: "Find the parser", toolUseId: sub.toolUseId, spawnDepth: 1 }));
    touch(join(subs, `agent-${sub.id}.meta.json`), sub.lastAt - 60_000);
    writeFileSync(join(subs, `agent-${sub.id}.jsonl`), sub.lines);
    touch(join(subs, `agent-${sub.id}.jsonl`), sub.lastAt);
  }
  const cursor: Cursor = { path, offset: 0, tally: {} };
  advance(cursor, "claude", 1 << 20, 1 << 20, 1 << 20);
  return cursor;
}

const claudeRef = { pane: "w1:p1", kind: "claude", sessionKind: "id", session: "s1" };

const subLines = (at: number) =>
  lines(
    { type: "user", isSidechain: true, agentId: "a1", timestamp: iso(at - 50_000), message: { role: "user", content: "Find the parser." } },
    claudeAssistant(at - 40_000, [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "parse" } }]),
    claudeAssistant(at - 30_000, [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/repo/parse.ts" } }]),
    claudeAssistant(at - 20_000, [{ type: "text", text: "The parser is in parse.ts." }], { input_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, output_tokens: 20 }),
  );

test("Claude: a subagent is running from its meta file until the parent hears back", () => {
  const root = tempDir();
  const cursor = claudeSession(root, lines(claudeAssistant(NOW - 60_000, [agentCall("toolu_1", "Find the parser")])), {
    id: "a1",
    toolUseId: "toolu_1",
    lines: subLines(NOW),
    lastAt: NOW - 20_000,
  });
  const a = activity(claudeRef, cursor, ctxFor({ claude: root }));
  assert.equal(a.subagents?.length, 1);
  const s = a.subagents![0];
  assert.equal(s.status, "running");
  assert.equal(s.type, "Explore");
  assert.equal(s.description, "Find the parser");
  assert.equal(s.startedAt, NOW - 60_000, "the tool call's time");
  assert.equal(s.tokens, 3021, "the latest turn's context and output");
  assert.equal(s.toolCalls, 2);
  assert.match(s.path!, /subagents\/agent-a1\.jsonl$/);
});

test("Claude: a background subagent's task notification marks it done, with its own numbers", () => {
  const root = tempDir();
  const cursor = claudeSession(
    root,
    lines(
      claudeAssistant(NOW - 120_000, [agentCall("toolu_1", "Find the parser")]),
      claudeResult(NOW - 119_000, "toolu_1", "Async agent launched successfully.", { isAsync: true, status: "async_launched", agentId: "a1" }),
      notification(NOW - 10_000, "toolu_1", "completed"),
    ),
    { id: "a1", toolUseId: "toolu_1", lines: subLines(NOW - 10_000), lastAt: NOW - 11_000 },
  );
  const s = activity(claudeRef, cursor, ctxFor({ claude: root })).subagents![0];
  assert.deepEqual([s.status, s.endedAt, s.tokens, s.toolCalls], ["done", NOW - 10_000, 4200, 7]);
});

test("Claude: failed and killed notifications, and a foreground subagent's result", () => {
  for (const [status, want] of [
    ["failed", "failed"],
    ["killed", "stopped"],
  ]) {
    const t: Tally = {};
    readLines("claude", lines(claudeAssistant(NOW - 5000, [agentCall("toolu_1", "x")]), notification(NOW, "toolu_1", status)), t);
    assert.equal(t.subs!.toolu_1.status, want);
  }
  const t: Tally = {};
  readLines(
    "claude",
    lines(
      claudeAssistant(NOW - 5000, [agentCall("toolu_2", "Draft")]),
      claudeResult(NOW, "toolu_2", "Done.", { status: "completed", totalTokens: 13_635, totalToolUseCount: 6, totalDurationMs: 38_000 }),
    ),
    t,
  );
  assert.deepEqual(t.subs!.toolu_2, { type: "Explore", description: "Draft", status: "done", startedAt: NOW - 5000, endedAt: NOW, tokens: 13_635, toolCalls: 6, at: NOW });
});

test("Claude: a background shell task's notification isn't taken for a subagent", () => {
  const t: Tally = {};
  readLines("claude", lines(notification(NOW, "toolu_bash", "completed", "")), t);
  assert.equal(t.subs, undefined);
});

test("Claude: a notification split across two reads is applied once it's complete", () => {
  const root = tempDir();
  const first = lines(claudeAssistant(NOW - 120_000, [agentCall("toolu_1", "Find the parser")]));
  const note = JSON.stringify(notification(NOW - 10_000, "toolu_1", "completed"));
  const cursor = claudeSession(root, first + note.slice(0, 80), { id: "a1", toolUseId: "toolu_1", lines: subLines(NOW - 10_000), lastAt: NOW - 11_000 });
  assert.equal(activity(claudeRef, cursor, ctxFor({ claude: root })).subagents![0].status, "running");
  appendFileSync(cursor.path, `${note.slice(80)}\n`);
  advance(cursor, "claude", 1 << 20, 1 << 20, 1 << 20);
  assert.equal(activity(claudeRef, cursor, ctxFor({ claude: root })).subagents![0].status, "done");
});

test("Claude: a subagent that stopped before the part of the parent that was read counts as done", () => {
  const root = tempDir();
  const cursor = claudeSession(root, lines(claudeAssistant(NOW - 60_000, [{ type: "text", text: "Later work." }])), {
    id: "a1",
    toolUseId: "toolu_old",
    lines: subLines(NOW - 120_000),
    lastAt: NOW - 120_000,
  });
  const s = activity(claudeRef, cursor, ctxFor({ claude: root })).subagents![0];
  assert.deepEqual([s.status, s.endedAt], ["done", NOW - 120_000]);
});

test("Claude: silent running subagents and long-finished ones are dropped, and a resumed one runs again", () => {
  const root = tempDir();
  const stale = claudeSession(root, lines(claudeAssistant(NOW - SUBAGENT_ACTIVE_MS - 120_000, [agentCall("toolu_1", "x")])), {
    id: "a1",
    toolUseId: "toolu_1",
    lines: subLines(NOW),
    lastAt: NOW - SUBAGENT_ACTIVE_MS - 1000,
  });
  assert.deepEqual(activity(claudeRef, stale, ctxFor({ claude: root })), {});

  const root2 = tempDir();
  const parent = lines(claudeAssistant(NOW - 3_600_000, [agentCall("toolu_1", "x")]), notification(NOW - SUBAGENT_KEEP_MS - 1000, "toolu_1", "completed"));
  const old = claudeSession(root2, parent, { id: "a1", toolUseId: "toolu_1", lines: subLines(NOW), lastAt: NOW - SUBAGENT_KEEP_MS - 2000 });
  assert.deepEqual(activity(claudeRef, old, ctxFor({ claude: root2 })), {});

  const root3 = tempDir();
  const resumed = claudeSession(root3, lines(claudeAssistant(NOW - 120_000, [agentCall("toolu_1", "x")]), notification(NOW - 60_000, "toolu_1", "completed")), {
    id: "a1",
    toolUseId: "toolu_1",
    lines: subLines(NOW),
    lastAt: NOW - 1000,
  });
  assert.equal(activity(claudeRef, resumed, ctxFor({ claude: root3 })).subagents![0].status, "running");
});

test("Claude: a subagent transcript is read only from where the last run stopped", () => {
  const root = tempDir();
  const cursor = claudeSession(root, lines(claudeAssistant(NOW - 60_000, [agentCall("toolu_1", "x")])), {
    id: "a1",
    toolUseId: "toolu_1",
    lines: subLines(NOW),
    lastAt: NOW - 20_000,
  });
  const ctx = ctxFor({ claude: root });
  activity(claudeRef, cursor, ctx);
  const firstRead = (1 << 20) - ctx.budget;
  assert.ok(firstRead > 0);
  const child = cursor.subagents!.children.a1;
  appendFileSync(child.path, lines(claudeAssistant(NOW, [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "ls" } }])));
  touch(child.path, NOW - 1000);
  const ctx2 = ctxFor({ claude: root });
  const s = activity(claudeRef, cursor, ctx2).subagents![0];
  assert.equal(s.toolCalls, 3);
  assert.ok((1 << 20) - ctx2.budget < firstRead, "only the new line is read");
});

test("Claude: TodoWrite replaces the list; task tools build it one task at a time", () => {
  const todo = (...states: string[]) =>
    claudeAssistant(NOW, [{ type: "tool_use", id: `todo-${states.join()}`, name: "TodoWrite", input: { todos: states.map((status, i) => ({ content: `Step ${i + 1}`, activeForm: `Doing step ${i + 1}`, status })) } }]);
  const t: Tally = {};
  readLines("claude", lines(todo("pending", "pending", "pending"), todo("completed", "in_progress", "pending")), t);
  assert.deepEqual(taskProgress(t.tasks), { done: 1, total: 3, current: "Step 2" });

  const create = (id: string, subject: string) => claudeAssistant(NOW, [{ type: "tool_use", id, name: "TaskCreate", input: { subject, description: "…", activeForm: `${subject}ing` } }]);
  const update = (taskId: string, status: string) => claudeAssistant(NOW, [{ type: "tool_use", id: `u-${taskId}-${status}`, name: "TaskUpdate", input: { taskId, status } }]);
  const t2: Tally = {};
  readLines(
    "claude",
    lines(
      create("c1", "Draft"),
      claudeResult(NOW, "c1", "Task #1 created successfully: Draft", { task: { id: "1", subject: "Draft" } }),
      create("c2", "Deploy"),
      // Without the task in the result, its ID comes from the text.
      claudeResult(NOW, "c2", "Task #2 created successfully: Deploy", {}),
      create("c3", "Test"),
      claudeResult(NOW, "c3", "Task #3 created successfully: Test", { task: { id: "3" } }),
      update("1", "completed"),
      update("2", "in_progress"),
      update("3", "deleted"),
      // An update for a task created before the part that was read.
      update("9", "pending"),
    ),
    t2,
  );
  assert.deepEqual(taskProgress(t2.tasks), { done: 1, total: 3, current: "Deploy" });
  assert.deepEqual(t2.tasks!.pending, {});
  assert.equal(taskProgress({ items: [] }), undefined);
});

test("Codex: update_plan gives the task list", () => {
  const t: Tally = {};
  const plan = { explanation: "x", plan: [{ step: "Read", status: "completed" }, { step: "Write", status: "in_progress" }, { step: "Ship", status: "pending" }] };
  readLines("codex", lines({ type: "response_item", payload: { type: "function_call", name: "update_plan", arguments: JSON.stringify(plan), call_id: "c1" } }), t);
  assert.deepEqual(taskProgress(t.tasks), { done: 1, total: 3, current: "Write" });
});

/** A Codex rollout in today's folder whose first line names its parent thread. */
function codexRollout(root: string, id: string, source: unknown, rest: unknown[], lastAt: number, extra = {}) {
  const d = new Date(NOW);
  const dir = join(root, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-30T11-00-00-${id}.jsonl`);
  writeFileSync(path, lines({ type: "session_meta", ordinal: 0, payload: { id, timestamp: iso(NOW - 600_000), source, base_instructions: { text: "x".repeat(5000) }, ...extra } }, ...rest));
  touch(path, lastAt);
  return path;
}
const spawn = (parent: string, path: string, depth = 1) => ({ subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_path: path, agent_nickname: "Noether", agent_role: null } } });
const ev = (ordinal: number, at: number, payload: unknown) => ({ timestamp: iso(at), ordinal, type: "event_msg", payload });
const tool = (ordinal: number, at: number, name = "exec") => ({ timestamp: iso(at), ordinal, type: "response_item", payload: { type: "custom_tool_call", name, input: "tools.exec_command({cmd: 'ls'})" } });
const tokens = (ordinal: number, at: number, total: number) => ev(ordinal, at, { type: "token_count", info: { last_token_usage: { input_tokens: total - 100, output_tokens: 100, total_tokens: total } } });

test("Codex: child threads of the parent, nested ones, and guardian reviews", () => {
  const root = tempDir();
  const parent = "01a0f000-0000-7000-8000-00000000a000";
  // Copied history from the parent comes first, including a finished task; only ordinals from 3 count.
  const child = codexRollout(
    root,
    "01a0f000-0000-7000-8000-00000000a001",
    spawn(parent, "/root/typed_results_prereview"),
    [ev(1, NOW - 900_000, { type: "task_complete" }), tool(2, NOW - 900_000), ev(3, NOW - 300_000, { type: "task_started" }), tool(4, NOW - 200_000), tokens(5, NOW - 200_000, 25_000)],
    NOW - 200_000,
    { subagent_history_start_ordinal: 3 },
  );
  codexRollout(
    root,
    "01a0f000-0000-7000-8000-00000000a002",
    spawn("01a0f000-0000-7000-8000-00000000a001", "/root/typed_results_prereview/lint", 2),
    [ev(1, NOW - 100_000, { type: "task_started" }), tool(2, NOW - 90_000), tool(3, NOW - 80_000), ev(4, NOW - 60_000, { type: "task_complete", duration_ms: 40_000 })],
    NOW - 60_000,
  );
  codexRollout(root, "01a0f000-0000-7000-8000-00000000a003", { subagent: { other: "guardian" } }, [ev(1, NOW - 5000, { type: "task_started" })], NOW - 5000, {
    parent_thread_id: parent,
  });
  // Another agent's subagent and an ordinal session aren't this parent's.
  codexRollout(root, "01a0f000-0000-7000-8000-00000000b001", spawn("01a0f000-0000-7000-8000-00000000b000", "/root/other"), [], NOW - 1000);
  codexRollout(root, "01a0f000-0000-7000-8000-00000000b002", "cli", [], NOW - 1000);

  const cursor: Cursor = { path: "/parent.jsonl", offset: 0, tally: {} };
  const ref = { pane: "w2:p4", kind: "codex", sessionKind: "id", session: parent };
  const a = activity(ref, cursor, ctxFor({ codex: root }));
  assert.deepEqual(a.reviews, { running: 1, done: 0 });
  const [top, nested] = a.subagents!;
  assert.deepEqual(
    [top.status, top.description, top.name, top.parent, top.tokens, top.toolCalls, top.startedAt, top.path, top.fromOrdinal],
    ["running", "typed results prereview", "Noether", undefined, 25_000, 1, NOW - 300_000, child, 3],
  );
  assert.deepEqual([nested.status, nested.parent, nested.toolCalls, nested.endedAt! - nested.startedAt!], ["done", "01a0f000-0000-7000-8000-00000000a001", 2, 40_000]);
  assert.deepEqual(Object.keys(cursor.subagents!.children).sort(), ["01a0f000-0000-7000-8000-00000000a001", "01a0f000-0000-7000-8000-00000000a002", "01a0f000-0000-7000-8000-00000000a003"]);
});

test("Codex: the head of a rollout that isn't a subagent's is ignored", () => {
  const root = tempDir();
  const path = codexRollout(root, "01a0f000-0000-7000-8000-00000000c001", "vscode", [], NOW);
  assert.equal(codexHead(path), undefined);
  const guardian = codexRollout(root, "01a0f000-0000-7000-8000-00000000c002", { subagent: { other: "guardian" } }, [], NOW, { session_id: "p1" });
  assert.deepEqual(codexHead(guardian), { id: "01a0f000-0000-7000-8000-00000000c002", parent: "p1", guardian: true, role: undefined, nickname: undefined, task: undefined, startedAt: NOW - 600_000, from: undefined });
});

// Pi: the parent session file's `Agent` tool calls and results and `subagents:record` entries.
const piCall = (at: number, id: string, description: string) => ({
  type: "message",
  timestamp: iso(at),
  message: { role: "assistant", content: [{ type: "toolCall", id, name: "Agent", arguments: { description, subagent_type: "reviewer", prompt: "Review." } }], usage: { input: 1, output: 1 } },
});
const piResult = (at: number, id: string, details: unknown, text = "Agent started in background.") => ({
  type: "message",
  timestamp: iso(at),
  message: { role: "toolResult", toolCallId: id, toolName: "Agent", content: [{ type: "text", text }], details },
});
const piRecord = (at: number, agentId: string, status: string) => ({
  type: "custom",
  customType: "subagents:record",
  timestamp: iso(at),
  data: { id: agentId, type: "reviewer", description: "Review the diff", status, result: "", startedAt: NOW - 200_000, completedAt: at },
});

function piSession(dir: string, ...ls: unknown[]): Cursor {
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines(...ls));
  const cursor: Cursor = { path, offset: 0, tally: {} };
  advance(cursor, "pi", 1 << 20, 1 << 20, 1 << 20);
  return cursor;
}

const piRef = (path: string) => ({ pane: "w2:p3", kind: "pi", sessionKind: "path", session: path });

test("Pi: a background subagent runs until its record says it finished; its output gives live numbers", () => {
  const dir = tempDir();
  const tasks = join(dir, "pi-subagents-501", "-repos-w2", "sess", "tasks");
  mkdirSync(tasks, { recursive: true });
  const output = join(tasks, "ag-1.output");
  const piLine = (type: string, message: unknown, at: number) => JSON.stringify({ isSidechain: true, agentId: "ag-1", type, message, timestamp: iso(at) });
  writeFileSync(
    output,
    lines(
      piLine("user", { role: "user", content: "Review the diff." }, NOW - 100_000),
      piLine("assistant", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }, { type: "toolCall", id: "c2", name: "grep", arguments: { pattern: "x" } }], usage: { input: 10, output: 20, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.25 } } }, NOW - 90_000),
      // A nested subagent, started by this one.
      piLine("assistant", { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "Agent", arguments: { description: "Check tests", subagent_type: "Explore" } }], usage: { input: 10, output: 20, cacheRead: 2000, cacheWrite: 0, cost: { total: 0.5 } } }, NOW - 80_000),
    ),
  );
  touch(output, NOW - 80_000);
  const started = [piCall(NOW - 110_000, "call-1", "Review the diff"), piResult(NOW - 109_000, "call-1", { agentId: "ag-1", status: "background", subagentType: "reviewer", description: "Review the diff" }, `Agent started in background.\nAgent ID: ag-1\nOutput file: ${output}\n`)];
  const cursor = piSession(dir, ...started);
  const a = activity(piRef(cursor.path), cursor, ctxFor({}));
  const top = a.subagents!.find((s) => s.id === "ag-1")!;
  const nested = a.subagents!.find((s) => s.id === "c3")!;
  assert.deepEqual([top.status, top.type, top.tokens, top.costUsd, top.toolCalls, top.path], ["running", "reviewer", 2030, 0.75, 3, output]);
  assert.deepEqual([nested.id, nested.status, nested.type, nested.parent, nested.path], ["c3", "running", "Explore", "ag-1", undefined]);

  const done = piSession(dir, ...started, piRecord(NOW - 10_000, "ag-1", "completed"));
  const byId = (c: Cursor) => activity(piRef(c.path), c, ctxFor({})).subagents!.find((x) => x.id === "ag-1")!;
  const s = byId(done);
  assert.deepEqual([s.status, s.startedAt, s.endedAt], ["done", NOW - 200_000, NOW - 10_000]);
  const orphan = activity(piRef(done.path), done, ctxFor({})).subagents!.find((x) => x.id === "c3")!;
  assert.deepEqual([orphan.status, orphan.endedAt], ["done", NOW - 10_000], "a nested subagent ends with its parent");
  assert.equal(byId(piSession(dir, ...started, piRecord(NOW - 10_000, "ag-1", "error"))).status, "failed");
});

test("Pi: a foreground subagent's result carries its totals", () => {
  const dir = tempDir();
  const cursor = piSession(
    dir,
    piCall(NOW - 50_000, "call-1", "Find blockers"),
    piResult(NOW - 7000, "call-1", { agentId: "ag-2", status: "completed", subagentType: "Explore", toolUses: 24, tokens: "126.0k token", cost: 0.95, durationMs: 43_000 }, "Agent completed in 43.2s."),
  );
  const s = activity(piRef(cursor.path), cursor, ctxFor({})).subagents![0];
  assert.deepEqual([s.id, s.status, s.toolCalls, s.tokens, s.costUsd, s.endedAt! - s.startedAt!], ["ag-2", "done", 24, 126_000, 0.95, 43_000]);
  assert.equal(piTokens("950 token"), 950);
  assert.equal(piTokens("1.2M token"), 1_200_000);
  assert.equal(piTokens(""), undefined);
});

test("Pi: an output path outside pi-subagents' folder is not followed", () => {
  const dir = tempDir();
  const cursor = piSession(dir, piCall(NOW - 5000, "call-1", "x"), piResult(NOW - 4000, "call-1", { agentId: "ag-3", status: "background" }, "Output file: /etc/passwd.output\n"));
  const s = activity(piRef(cursor.path), cursor, ctxFor({})).subagents![0];
  assert.equal(s.path, undefined);
});

test("subagent transcripts read as plain text: messages and one line per tool call", () => {
  const dir = tempDir();
  const claude = join(dir, "agent-a1.jsonl");
  writeFileSync(claude, subLines(NOW));
  assert.equal(
    subagentTranscript({ path: claude, kind: "claude" }).text,
    ["› Find the parser.", "→ Grep parse", "→ Read /repo/parse.ts", "The parser is in parse.ts."].join("\n\n"),
  );
  const codex = join(dir, "rollout.jsonl");
  writeFileSync(
    codex,
    lines(
      { ordinal: 1, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Parent history." }] } },
      { ordinal: 3, type: "response_item", payload: { type: "agent_message", content: [{ type: "input_text", text: "Task name: /root/lint" }] } },
      { ordinal: 4, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) } },
      { ordinal: 5, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "All green." }] } },
    ),
  );
  assert.equal(subagentTranscript({ path: codex, kind: "codex", fromOrdinal: 3 }).text, ["› Task name: /root/lint", "→ exec_command npm test", "All green."].join("\n\n"));
  const long = subagentTranscript({ path: claude, kind: "claude", bytes: 1024 });
  assert.equal(long.truncated, true);
  assert.ok(long.text.endsWith("The parser is in parse.ts."), "the newest message is kept");
  assert.throws(() => subagentTranscript({ path: "/etc/passwd", kind: "claude" }), /not a transcript/);
});

test("probe reports subagents and tasks with each result and spends the remaining budget on them", () => {
  const root = tempDir();
  const parentLines = lines(
    claudeAssistant(NOW - 60_000, [agentCall("toolu_1", "Find the parser")]),
    claudeAssistant(NOW - 50_000, [{ type: "tool_use", id: "todo", name: "TodoWrite", input: { todos: [{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }] } }]),
  );
  const cursor = claudeSession(root, parentLines, { id: "a1", toolUseId: "toolu_1", lines: subLines(NOW), lastAt: NOW - 20_000 });
  const ref = { ...claudeRef, cwd: "/repos/w1", status: "working" };
  const deps = { processes: () => undefined, screen: () => undefined, now: () => NOW };
  const out = probe({ refs: [{ ...ref, cursor: { path: cursor.path, offset: 0, tally: {} } }], roots: { claude: root } }, deps);
  const res = out.results[0];
  assert.equal(res.subagents?.[0].status, "running");
  assert.deepEqual(res.tasks, { done: 1, total: 2, current: "B" });
  assert.equal(out.bytesRead, parentLines.length + subLines(NOW).length, "the parent and its subagent's transcript");
  // With the budget spent on the parent, the subagent is listed without being read.
  const tight = probe({ refs: [{ ...ref, cursor: { path: cursor.path, offset: 0, tally: {} } }], roots: { claude: root }, maxBytes: parentLines.length }, deps);
  assert.equal(tight.bytesRead, parentLines.length);
  assert.equal(tight.results[0].subagents?.[0].toolCalls, undefined);
});

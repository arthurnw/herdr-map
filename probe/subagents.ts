// Subagents and todo lists, read from the same transcripts as usage. server/probe.ts joins this
// file and probe/usage.ts into the one script it sends, so this file imports only Node built-ins
// and usage.ts, and its top-level names must differ from usage.ts's.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { advance, fileSize, num, readJson, safeList, tailText, type Cursor, type Json, type JsonValue, type ProbeRef, type Roots, type Tally, type TranscriptReader } from "./usage.ts";

export type SubagentStatus = "running" | "done" | "failed" | "stopped";

/** A subagent as the probe reports it. */
export interface Subagent {
  id: string;
  /** Agent type or role, such as `Explore`. */
  type?: string;
  /** Codex: the nickname Codex gave the thread. */
  name?: string;
  description?: string;
  status: SubagentStatus;
  /** Epoch ms. */
  startedAt?: number;
  endedAt?: number;
  /** Tokens of its latest turn: the context it saw plus its output. */
  tokens?: number;
  costUsd?: number;
  toolCalls?: number;
  /** ID of the subagent that started this one, when nested. */
  parent?: string;
  /** Its transcript, for reading on demand. */
  path?: string;
  /** Codex: lines before this ordinal are the parent's history, copied in. */
  fromOrdinal?: number;
}

export interface TaskProgress {
  done: number;
  total: number;
  /** The task in progress. */
  current?: string;
}

/** Codex's automatic approval reviews ("guardian" subagents), counted instead of shown. */
export interface Reviews {
  running: number;
  done: number;
}

/** What a parent transcript says about one subagent. */
export interface SubRecord {
  type?: string;
  description?: string;
  status: SubagentStatus;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  toolCalls?: number;
  costUsd?: number;
  /** Pi: the agent ID and output transcript, once the tool result names them. */
  agentId?: string;
  path?: string;
  /** When this record last changed, for pruning. */
  at: number;
}

/** Parent-side records keyed by Claude tool-use ID or Pi tool-call ID. */
export type SubLog = Record<string, SubRecord>;

export interface TaskItem {
  id?: string;
  text: string;
  status: string;
}

export interface TaskList {
  items: TaskItem[];
  /** Claude `TaskCreate` calls whose result, which carries the task ID, hasn't been read yet. */
  pending?: Record<string, string>;
}

/** Counts a subagent transcript's reader keeps in its tally. */
export interface ChildStats {
  tokens?: number;
  costUsd?: number;
  toolCalls?: number;
  status?: SubagentStatus;
  startedAt?: number;
  endedAt?: number;
  /** Codex: lines before this ordinal are skipped. */
  from?: number;
}

/** A subagent transcript being followed. */
export interface ChildCursor extends Cursor {
  /** Claude: the parent's tool-use ID for this subagent. */
  key?: string;
  type?: string;
  name?: string;
  description?: string;
  parent?: string;
  guardian?: boolean;
  startedAt?: number;
}

/** Subagent transcripts being followed for one agent, by subagent ID. Kept in the cursor. */
export interface SubagentState {
  children: Record<string, ChildCursor>;
}

// A subagent that never reported finishing is dropped after this long without writing, and a
// finished one this long after it ended.
export const SUBAGENT_ACTIVE_MS = 30 * 60_000;
export const SUBAGENT_KEEP_MS = 30 * 60_000;
// Reported per agent: running ones first, then the most recent.
export const SUBAGENT_MAX = 12;
// A finished Claude subagent whose transcript grows again after this long was resumed.
const RESUME_SLACK_MS = 5000;
const LOG_MAX = 40;
const TASK_MAX = 50;
const TEXT_MAX = 300;

function time(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

function str(v: unknown, max = TEXT_MAX): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : undefined;
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Keeps the most recently changed records. */
function pruneLog(log: SubLog) {
  const keys = Object.keys(log);
  if (keys.length <= LOG_MAX) return;
  keys.sort((a, b) => log[b].at - log[a].at);
  for (const k of keys.slice(LOG_MAX)) delete log[k];
}

function tasksOf(t: Tally): TaskList {
  return (t.tasks ??= { items: [] });
}

function setTasks(t: Tally, items: TaskItem[]) {
  tasksOf(t).items = items.slice(0, TASK_MAX);
}

// Claude Code's background subagents report back in a `<task-notification>`, which appears in
// queue records, attachments, and user messages; each copy carries the same tool-use ID.
function notificationText(o: Json): string | undefined {
  let s: unknown;
  if (o.type === "queue-operation") s = o.content;
  else if (o.type === "attachment") s = o.attachment?.prompt;
  else if (o.type === "user") {
    const c = o.message?.content;
    s = typeof c === "string" ? c : Array.isArray(c) ? c.find((b) => typeof b?.text === "string" && b.text.includes("<task-notification>"))?.text : undefined;
  }
  return typeof s === "string" && s.includes("<task-notification>") ? s : undefined;
}

function tag(s: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1]?.trim();
}

// oxlint-disable-next-line anti-slop/no-known-value-widening -- looked up by any status a transcript records
const CLAUDE_ENDS: Record<string, SubagentStatus> = { completed: "done", failed: "failed", killed: "stopped", stopped: "stopped" };

function claudeToolUse(b: Json, at: number | undefined, t: Tally) {
  const input = b.input ?? {};
  const log = (t.subs ??= {});
  if ((b.name === "Agent" || b.name === "Task") && typeof b.id === "string") {
    log[b.id] = { type: str(input.subagent_type), description: str(input.description), status: "running", startedAt: at, at: at ?? 0 };
    pruneLog(log);
  } else if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
    setTasks(
      t,
      input.todos.map((x: Json) => ({ text: str(x?.content) ?? str(x?.activeForm) ?? "", status: String(x?.status ?? "pending") })),
    );
  } else if (b.name === "TaskCreate" && typeof b.id === "string") {
    const list = tasksOf(t);
    list.pending = { ...list.pending, [b.id]: str(input.subject) ?? str(input.activeForm) ?? "" };
  } else if (b.name === "TaskUpdate" && input.taskId !== undefined) {
    const list = tasksOf(t);
    const id = String(input.taskId);
    const item = list.items.find((i) => i.id === id);
    if (input.status === "deleted") list.items = list.items.filter((i) => i !== item);
    else if (item) {
      if (typeof input.status === "string") item.status = input.status;
      item.text = str(input.subject) ?? item.text;
    } else setTasks(t, [...list.items, { id, text: str(input.subject) ?? `Task ${id}`, status: String(input.status ?? "pending") }]);
  }
}

function claudeToolResult(b: Json, result: Json | undefined, at: number | undefined, t: Tally) {
  const id = b.tool_use_id;
  if (typeof id !== "string") return;
  const pending = t.tasks?.pending?.[id];
  if (pending !== undefined) {
    const list = tasksOf(t);
    delete list.pending![id];
    const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
    const taskId = result?.task?.id ?? /Task #(\w+)/.exec(text)?.[1];
    if (taskId !== undefined) setTasks(t, [...list.items, { id: String(taskId), text: pending, status: "pending" }]);
  }
  const rec = t.subs?.[id];
  if (!rec || result?.isAsync) return;
  if (result?.status === "completed") {
    Object.assign(rec, { status: "done", endedAt: at, at: at ?? rec.at });
    if (num(result.totalTokens)) rec.tokens = result.totalTokens;
    if (num(result.totalToolUseCount)) rec.toolCalls = result.totalToolUseCount;
    if (rec.startedAt === undefined && at !== undefined && num(result.totalDurationMs)) rec.startedAt = at - result.totalDurationMs;
  } else if (b.is_error) Object.assign(rec, { status: "failed", endedAt: at, at: at ?? rec.at });
}

function claudeNotification(s: string, at: number | undefined, t: Tally) {
  const id = tag(s, "tool-use-id");
  const status = CLAUDE_ENDS[tag(s, "status") ?? ""];
  if (!id || !status) return;
  const tokens = Number(tag(s, "subagent_tokens"));
  // Background shell tasks notify the same way; only subagents report subagent tokens.
  if (!t.subs?.[id] && !tokens) return;
  const log = (t.subs ??= {});
  const rec = (log[id] ??= { status, at: at ?? 0 });
  Object.assign(rec, { status, endedAt: at, at: at ?? rec.at });
  if (tokens) rec.tokens = tokens;
  const tools = Number(tag(s, "tool_uses"));
  if (Number.isFinite(tools) && tag(s, "tool_uses") !== undefined) rec.toolCalls = tools;
  const ms = Number(tag(s, "duration_ms"));
  if (rec.startedAt === undefined && at !== undefined && ms > 0) rec.startedAt = at - ms;
  pruneLog(log);
}

/** Reads a Claude Code parent transcript line for subagent launches and results, and for todo and task tools. */
export function claudeActivity(o: Json, t: Tally) {
  if (o.isSidechain) return;
  const at = time(o.timestamp);
  if (at !== undefined && t.subsFrom === undefined) t.subsFrom = at;
  const content = o.message?.content;
  if (o.type === "assistant" && Array.isArray(content)) {
    for (const b of content) if (b?.type === "tool_use") claudeToolUse(b, at, t);
  } else if (o.type === "user" && Array.isArray(content)) {
    for (const b of content) if (b?.type === "tool_result") claudeToolResult(b, o.toolUseResult, at, t);
  }
  const note = notificationText(o);
  if (note) claudeNotification(note, at, t);
}

/** Codex's `update_plan` tool carries the whole plan each time. */
export function codexActivity(o: Json, t: Tally) {
  const p = o.payload;
  if (o.type !== "response_item" || p?.type !== "function_call" || p.name !== "update_plan") return;
  let args: Json;
  try {
    args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments;
  } catch {
    return;
  }
  if (Array.isArray(args?.plan)) setTasks(t, args.plan.map((x: Json) => ({ text: str(x?.step) ?? "", status: String(x?.status ?? "pending") })));
}

// oxlint-disable-next-line anti-slop/no-known-value-widening -- looked up by any status a transcript records
const PI_STATUS: Record<string, SubagentStatus> = {
  background: "running",
  running: "running",
  queued: "running",
  completed: "done",
  steered: "done",
  error: "failed",
  failed: "failed",
  aborted: "stopped",
  stopped: "stopped",
  cancelled: "stopped",
};

/** "126.0k token" → 126000. */
export function piTokens(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  const m = typeof v === "string" ? /([\d.]+)\s*([kKmM]?)/.exec(v) : null;
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2].toLowerCase() === "k" ? 1e3 : m[2].toLowerCase() === "m" ? 1e6 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
}

// @tintinweb/pi-subagents writes background transcripts under the temp directory; see README.
const PI_OUTPUT = /^Output file:\s*(\S+\.output)\s*$/m;

/**
 * Reads a Pi line for `Agent` tool calls and results and `subagents:record` entries. Used for the
 * parent's session file and for subagents' own transcripts, whose lines are shaped alike.
 */
export function piActivity(o: Json, t: Tally) {
  const m = o.message;
  const at = time(o.timestamp ?? m?.timestamp);
  const before = t.subs;
  const log = (t.subs ??= {});
  if (m?.role === "assistant" && Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c?.type !== "toolCall" || c.name !== "Agent" || typeof c.id !== "string") continue;
      const args = c.arguments ?? {};
      log[c.id] = { type: str(args.subagent_type), description: str(args.description), status: "running", startedAt: at, at: at ?? 0 };
    }
  } else if (m?.role === "toolResult" && m.toolName === "Agent" && typeof m.toolCallId === "string") {
    const d = m.details ?? {};
    const rec = (log[m.toolCallId] ??= { status: "running", startedAt: at, at: at ?? 0 });
    rec.at = at ?? rec.at;
    if (typeof d.agentId === "string") rec.agentId = d.agentId;
    rec.type = str(d.subagentType) ?? rec.type;
    rec.description = str(d.description) ?? rec.description;
    const status = PI_STATUS[d.status] ?? (m.isError ? "failed" : undefined);
    if (status) rec.status = status;
    const path = PI_OUTPUT.exec(textOf(m.content))?.[1];
    if (path) rec.path = path;
    if (rec.status !== "running") {
      rec.endedAt = at;
      if (num(d.durationMs) && at !== undefined) rec.startedAt = at - d.durationMs;
      if (num(d.toolUses)) rec.toolCalls = d.toolUses;
      rec.tokens = piTokens(d.tokens) ?? rec.tokens;
      if (num(d.cost)) rec.costUsd = d.cost;
    }
  } else if (o.type === "custom" && o.customType === "subagents:record" && typeof o.data?.id === "string") {
    const d = o.data;
    const key = Object.keys(log).find((k) => log[k].agentId === d.id) ?? d.id;
    const rec = (log[key] ??= { agentId: d.id, status: "running", at: at ?? 0 });
    rec.at = at ?? rec.at;
    rec.type = str(d.type) ?? rec.type;
    rec.description = str(d.description) ?? rec.description;
    rec.status = PI_STATUS[d.status] ?? rec.status;
    rec.startedAt = time(d.startedAt) ?? rec.startedAt;
    if (rec.status !== "running") rec.endedAt = time(d.completedAt) ?? at;
  }
  if (!before && Object.keys(log).length === 0) delete t.subs;
  else pruneLog(log);
}

function claudeChildLine(o: Json, t: Tally) {
  const s = (t.child ??= {});
  const m = o.message;
  if (o.type !== "assistant" || !m) return;
  const u = m.usage;
  const tokens = u && num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
  if (tokens) s.tokens = tokens;
  if (Array.isArray(m.content)) s.toolCalls = (s.toolCalls ?? 0) + m.content.filter((b: Json) => b?.type === "tool_use").length;
}

function piChildLine(o: Json, t: Tally) {
  const s = (t.child ??= {});
  const m = o.message;
  if (m?.role === "assistant") {
    const u = m.usage;
    const tokens = u && num(u.input) + num(u.cacheRead) + num(u.cacheWrite) + num(u.output);
    if (tokens) s.tokens = tokens;
    if (num(u?.cost?.total)) s.costUsd = (s.costUsd ?? 0) + u.cost.total;
    if (Array.isArray(m.content)) s.toolCalls = (s.toolCalls ?? 0) + m.content.filter((c: Json) => c?.type === "toolCall").length;
  }
  piActivity(o, t);
}

const CODEX_TOOL_ITEMS = new Set(["function_call", "custom_tool_call", "local_shell_call", "web_search_call"]);

function codexChildLine(o: Json, t: Tally) {
  const s = (t.child ??= {});
  if (typeof o.ordinal === "number" && s.from !== undefined && o.ordinal < s.from) return;
  const p = o.payload ?? {};
  const at = time(o.timestamp);
  if (o.type === "event_msg") {
    // A thread can be given more tasks later; each one's duration counts from its own start.
    if (p.type === "task_started") {
      s.status = "running";
      s.endedAt = undefined;
      s.startedAt = at;
    } else if (p.type === "task_complete" || p.type === "turn_aborted") {
      s.status = p.type === "task_complete" ? "done" : "stopped";
      s.endedAt = at;
    } else if (p.type === "token_count") {
      const u = p.info?.last_token_usage;
      const tokens = num(u?.total_tokens) || num(u?.input_tokens) + num(u?.output_tokens);
      if (tokens) s.tokens = tokens;
    }
  } else if (o.type === "response_item" && CODEX_TOOL_ITEMS.has(p.type)) s.toolCalls = (s.toolCalls ?? 0) + 1;
}

/** Readers for subagent transcripts, looked up by `advance` alongside the agents' own. */
// oxlint-disable-next-line anti-slop/no-known-value-widening -- looked up by any agent kind string
export const SUBAGENT_READERS: Record<string, TranscriptReader> = {
  "claude-subagent": { marker: ['"usage"'], read: claudeChildLine, history: true },
  "pi-subagent": { marker: ['"usage"', '"Agent"', "subagents:record"], read: piChildLine, history: true },
  "codex-subagent": {
    marker: ['"task_started"', '"task_complete"', '"turn_aborted"', '"token_count"', '"function_call"', '"custom_tool_call"', '"local_shell_call"', '"web_search_call"'],
    read: codexChildLine,
    history: true,
  },
};

export interface SubagentContext {
  roots: Roots;
  now: number;
  /** Bytes left to read in this run. */
  budget: number;
  maxLine: number;
  /** Codex rollout heads read in this run, shared by every Codex agent. */
  heads: Map<string, CodexHead | undefined>;
}

function follow(child: ChildCursor, kind: string, ctx: SubagentContext): void {
  if (ctx.budget <= 0) return;
  try {
    ctx.budget -= advance(child, kind, ctx.budget, ctx.budget, ctx.maxLine);
  } catch {}
}

function stale(status: SubagentStatus, lastAt: number | undefined, endedAt: number | undefined, now: number): boolean {
  if (status === "running") return lastAt === undefined || now - lastAt > SUBAGENT_ACTIVE_MS;
  return now - (endedAt ?? lastAt ?? 0) > SUBAGENT_KEEP_MS;
}

const CLAUDE_AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,80})\.meta\.json$/;

/** Claude Code keeps subagents in `<session>/subagents/` beside the session's transcript. */
export function claudeSubagents(parent: Cursor, state: SubagentState, ctx: SubagentContext): Subagent[] {
  const dir = join(parent.path.replace(/\.jsonl$/, ""), "subagents");
  const log = parent.tally.subs ?? {};
  const out: Subagent[] = [];
  const live = new Set<string>();
  for (const f of safeList(dir)) {
    const id = CLAUDE_AGENT_FILE.exec(f)?.[1];
    if (!id) continue;
    const path = join(dir, `agent-${id}.jsonl`);
    const lastAt = mtimeOf(path);
    if (lastAt === undefined) continue;
    let child = state.children[id];
    if (!child) {
      if (ctx.now - lastAt > SUBAGENT_ACTIVE_MS) continue;
      const meta = readJson(join(dir, f));
      if (!meta) continue;
      child = {
        path,
        offset: 0,
        tally: {},
        key: typeof meta.toolUseId === "string" ? meta.toolUseId : undefined,
        type: str(meta.agentType),
        description: str(meta.description),
        startedAt: mtimeOf(join(dir, f)),
      };
    }
    const rec = child.key ? log[child.key] : undefined;
    let status: SubagentStatus = "running";
    let endedAt: number | undefined;
    if (rec && rec.status !== "running") {
      // A finished subagent that is sent another message writes to the same transcript.
      if (rec.endedAt === undefined || lastAt <= rec.endedAt + RESUME_SLACK_MS) {
        status = rec.status;
        endedAt = rec.endedAt ?? lastAt;
      }
    } else if (!rec && parent.tally.subsFrom !== undefined && lastAt < parent.tally.subsFrom) {
      // It stopped writing before the part of the parent transcript that was read.
      status = "done";
      endedAt = lastAt;
    }
    if (stale(status, lastAt, endedAt, ctx.now)) continue;
    live.add(id);
    state.children[id] = child;
    follow(child, "claude-subagent", ctx);
    const s = child.tally.child ?? {};
    const ended = status !== "running";
    out.push({
      id,
      type: child.type ?? rec?.type,
      description: child.description ?? rec?.description,
      status,
      startedAt: rec?.startedAt ?? child.startedAt,
      endedAt,
      tokens: (ended && rec?.tokens) || s.tokens,
      toolCalls: (ended && rec?.toolCalls) || s.toolCalls,
      path,
    });
  }
  for (const id of Object.keys(state.children)) if (!live.has(id)) delete state.children[id];
  return out;
}

function piOutputPath(p: string | undefined): string | undefined {
  return p && isAbsolute(p) && p.endsWith(".output") && p.includes("pi-subagents-") ? p : undefined;
}

const PI_DEPTH = 3;

/** Pi subagents from the records in `tally`, with nested ones from each subagent's own transcript. */
export function piSubagents(
  tally: Tally,
  state: SubagentState,
  ctx: SubagentContext,
  parent?: { id: string; endedAt?: number },
  depth = 1,
  live = new Set<string>(),
): Subagent[] {
  const out: Subagent[] = [];
  for (const [key, logged] of Object.entries(tally.subs ?? {})) {
    const id = logged.agentId ?? key;
    // A nested subagent can't outlive the one that started it.
    const rec = logged.status === "running" && parent?.endedAt !== undefined ? { ...logged, status: "done" as const, endedAt: parent.endedAt } : logged;
    if (live.has(id)) continue;
    const path = piOutputPath(rec.path);
    const lastAt = path ? (mtimeOf(path) ?? rec.at) : rec.at;
    if (stale(rec.status, Math.max(lastAt, rec.at), rec.endedAt, ctx.now)) continue;
    live.add(id);
    let child = state.children[id];
    if (path && (!child || child.path !== path) && fileSize(path) !== undefined) child = state.children[id] = { path, offset: 0, tally: {} };
    if (child) follow(child, "pi-subagent", ctx);
    const s = child?.tally.child ?? {};
    const ended = rec.status !== "running";
    out.push({
      id,
      type: rec.type,
      description: rec.description,
      status: rec.status,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      tokens: (ended && rec.tokens) || s.tokens,
      costUsd: (ended && rec.costUsd) || s.costUsd,
      toolCalls: (ended && rec.toolCalls) || s.toolCalls,
      ...(parent && { parent: parent.id }),
      ...(child && { path: child.path }),
    });
    if (child && depth < PI_DEPTH) out.push(...piSubagents(child.tally, state, ctx, { id, endedAt: rec.endedAt ?? (ended ? lastAt : undefined) }, depth + 1, live));
  }
  if (depth === 1) for (const id of Object.keys(state.children)) if (!live.has(id)) delete state.children[id];
  return out;
}

/** The first line of a Codex rollout, when it's a subagent's. */
export interface CodexHead {
  id: string;
  /** The thread that started it. */
  parent: string;
  guardian: boolean;
  role?: string;
  nickname?: string;
  /** Its task name, the last part of `agent_path`. */
  task?: string;
  startedAt?: number;
  from?: number;
}

const HEAD_BYTES = 256 * 1024;

export function codexHead(path: string): CodexHead | undefined {
  let line: string;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const nl = buf.subarray(0, n).indexOf(10);
    if (nl < 0) return undefined;
    line = buf.subarray(0, nl).toString("utf8");
  } finally {
    closeSync(fd);
  }
  if (!line.includes('"subagent"')) return undefined;
  let o: Json;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  const p = o?.payload;
  const sub = p?.source?.subagent;
  if (o?.type !== "session_meta" || typeof p.id !== "string" || !sub) return undefined;
  const spawn = sub.thread_spawn;
  const guardian = sub.other === "guardian";
  const parent = spawn?.parent_thread_id ?? p.parent_thread_id ?? p.session_id;
  if ((!spawn && !guardian) || typeof parent !== "string") return undefined;
  const agentPath = spawn?.agent_path ?? p.agent_path;
  return {
    id: p.id,
    parent,
    guardian,
    role: str(spawn?.agent_role),
    nickname: str(spawn?.agent_nickname ?? p.agent_nickname),
    task: typeof agentPath === "string" ? str(agentPath.split("/").filter(Boolean).at(-1)?.replaceAll("_", " ")) : undefined,
    startedAt: time(p.timestamp),
    from: typeof p.subagent_history_start_ordinal === "number" ? p.subagent_history_start_ordinal : undefined,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Day folders a subagent started recently is filed in: today's and yesterday's, in local time. */
function codexRecentDirs(root: string, now: number): string[] {
  return [0, 1].map((back) => {
    const d = new Date(now - back * 86_400_000);
    return join(root, "sessions", String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate()));
  });
}

export interface CodexActivity {
  subagents: Subagent[];
  reviews?: Reviews;
}

/**
 * Codex subagents are threads with their own rollouts, whose first line names the parent thread.
 * Rollouts changed recently are checked, and followed once they're found to belong to `thread`
 * or to one of its subagents.
 */
export function codexSubagents(thread: string, state: SubagentState, ctx: SubagentContext): CodexActivity {
  const known = new Set(Object.values(state.children).map((c) => c.path));
  const heads: { head: CodexHead; path: string; lastAt: number }[] = [];
  for (const dir of codexRecentDirs(ctx.roots.codex, ctx.now)) {
    for (const f of safeList(dir)) {
      if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      if (known.has(path)) continue;
      const lastAt = mtimeOf(path);
      if (lastAt === undefined || ctx.now - lastAt > SUBAGENT_ACTIVE_MS) continue;
      if (!ctx.heads.has(path)) {
        let head: CodexHead | undefined;
        try {
          head = codexHead(path);
        } catch {}
        ctx.heads.set(path, head);
      }
      const head = ctx.heads.get(path);
      if (head) heads.push({ head, path, lastAt });
    }
  }
  const tree = new Set([thread, ...Object.keys(state.children)]);
  for (let added = true; added; ) {
    added = false;
    for (const { head, path } of heads) {
      if (tree.has(head.id) || !tree.has(head.parent)) continue;
      tree.add(head.id);
      added = true;
      state.children[head.id] = {
        path,
        offset: 0,
        tally: { child: { from: head.from } },
        type: head.guardian ? "guardian" : head.role,
        name: head.nickname,
        description: head.task,
        parent: head.parent === thread ? undefined : head.parent,
        guardian: head.guardian || undefined,
        startedAt: head.startedAt,
      };
    }
  }
  const subagents: Subagent[] = [];
  const reviews: Reviews = { running: 0, done: 0 };
  for (const [id, child] of Object.entries(state.children)) {
    follow(child, "codex-subagent", ctx);
    const s = child.tally.child ?? {};
    const status = s.status ?? "running";
    if (stale(status, mtimeOf(child.path), s.endedAt, ctx.now)) {
      delete state.children[id];
      continue;
    }
    if (child.guardian) {
      reviews[status === "running" ? "running" : "done"]++;
      continue;
    }
    subagents.push({
      id,
      type: child.type,
      name: child.name,
      description: child.description,
      status,
      startedAt: s.startedAt ?? child.startedAt,
      endedAt: s.endedAt,
      tokens: s.tokens,
      toolCalls: s.toolCalls,
      ...(child.parent && { parent: child.parent }),
      path: child.path,
      ...(s.from !== undefined && { fromOrdinal: s.from }),
    });
  }
  return { subagents, ...(reviews.running + reviews.done > 0 && { reviews }) };
}

export function taskProgress(list: TaskList | undefined): TaskProgress | undefined {
  const items = list?.items ?? [];
  if (items.length === 0) return undefined;
  const current = items.find((i) => i.status === "in_progress")?.text;
  return { done: items.filter((i) => i.status === "completed").length, total: items.length, ...(current && { current }) };
}

/** Running first, then the most recently started. */
function rank(list: Subagent[]): Subagent[] {
  return [...list]
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, SUBAGENT_MAX);
}

export interface Activity {
  subagents?: Subagent[];
  reviews?: Reviews;
  tasks?: TaskProgress;
  /** The tool call the agent's main thread is waiting on. */
  current?: CurrentTool;
}

/** An agent's subagents and task progress, following subagent transcripts from `cursor.subagents`. */
export function activity(ref: ProbeRef, cursor: Cursor, ctx: SubagentContext): Activity {
  const state = (cursor.subagents ??= { children: {} });
  let subagents: Subagent[] = [];
  let reviews: Reviews | undefined;
  if (ref.kind === "claude") subagents = claudeSubagents(cursor, state, ctx);
  else if (ref.kind === "pi") subagents = piSubagents(cursor.tally, state, ctx);
  else if (ref.kind === "codex" && ref.sessionKind === "id") ({ subagents, reviews } = codexSubagents(ref.session, state, ctx));
  if (Object.keys(state.children).length === 0) delete cursor.subagents;
  const tasks = taskProgress(cursor.tally.tasks);
  const current = currentTool(cursor.tally);
  return { ...(subagents.length > 0 && { subagents: rank(subagents) }), ...(reviews && { reviews }), ...(tasks && { tasks }), ...(current && { current }) };
}

/** A tool call the agent's main thread made that has no result yet. Kept in the tally. */
export interface OpenCall {
  id: string;
  tool: string;
  summary?: string;
  startedAt?: number;
  /** Claude Code: the ID of the response that made the call. */
  msg?: string;
}

/** The tool call an agent is running, as the probe reports it. */
export interface CurrentTool {
  tool: string;
  /** Its main argument, shortened. */
  summary?: string;
  /** Epoch ms, from the transcript. */
  startedAt?: number;
}

const OPEN_MAX = 16;
const SUMMARY_MAX = 80;

function openCall(t: Tally, call: OpenCall) {
  const open = (t.open ??= []);
  open.push(call);
  if (open.length > OPEN_MAX) open.splice(0, open.length - OPEN_MAX);
}

/** Drops the open calls `keep` rejects. */
function closeCalls(t: Tally, keep: (c: OpenCall) => boolean) {
  if (!t.open) return;
  t.open = t.open.filter(keep);
  if (t.open.length === 0) delete t.open;
}

/**
 * Claude Code tool calls and their results, from the main thread. Each content block of a response
 * is its own line, all with the response's `message.id`; the API needs every call's result before
 * the next response, so a new response also closes calls a missing result left open (an interrupt).
 */
export function claudeCurrent(o: Json, t: Tally) {
  if (o.isSidechain) return;
  const content = o.message?.content;
  if (o.type === "assistant") {
    const msg = typeof o.message?.id === "string" ? o.message.id : undefined;
    closeCalls(t, (c) => msg !== undefined && c.msg === msg);
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
      openCall(t, { id: b.id, tool: String(b.name ?? "tool"), summary: preview(b.input, SUMMARY_MAX) || undefined, startedAt: time(o.timestamp), ...(msg && { msg }) });
    }
  } else if (o.type === "user" && Array.isArray(content)) {
    const done = new Set(content.flatMap((b) => (b?.type === "tool_result" ? [b.tool_use_id] : [])));
    if (done.size > 0) closeCalls(t, (c) => !done.has(c.id));
  }
}

const CODEX_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);

/**
 * Codex's code-mode `exec` tool takes JavaScript that calls other tools, such as
 * `tools.exec_command({"cmd": "npm test"})`; the inner tool and its command say more than the code.
 */
function codexCall(p: Json): CurrentTool {
  const args = codexArgs(p.arguments ?? p.input ?? p.action);
  const tool = String(p.name ?? p.type);
  if (typeof args === "string") {
    const inner = /\btools\.(\w+)\(/.exec(args)?.[1];
    const cmd = /\bcmd["']?\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(args)?.[2];
    let shown = cmd;
    if (cmd !== undefined) {
      try {
        shown = JSON.parse(`"${cmd}"`);
      } catch {}
    }
    if (inner) return { tool: inner, summary: preview(shown ?? args, SUMMARY_MAX) || undefined };
  }
  return { tool, summary: preview(args, SUMMARY_MAX) || undefined };
}

/** Codex tool calls and their outputs, matched by `call_id`. A turn's start or end closes them all. */
export function codexCurrent(o: Json, t: Tally) {
  const p = o.payload;
  if (!p) return;
  if (o.type === "event_msg") {
    if (p.type === "task_started" || p.type === "task_complete" || p.type === "turn_aborted") delete t.open;
    return;
  }
  if (o.type !== "response_item" || typeof p.call_id !== "string") return;
  if (CODEX_CALLS.has(p.type)) openCall(t, { id: p.call_id, ...codexCall(p), startedAt: time(o.timestamp) });
  else if (typeof p.type === "string" && p.type.endsWith("_output")) closeCalls(t, (c) => c.id !== p.call_id);
}

/** Pi tool calls and their results. Pi writes whole messages, so a new one closes calls left open. */
export function piCurrent(o: Json, t: Tally) {
  const m = o.message;
  if (o.type !== "message" || !m) return;
  if (m.role === "toolResult") return closeCalls(t, (c) => c.id !== m.toolCallId);
  if (m.role !== "user" && m.role !== "assistant") return;
  delete t.open;
  if (m.role !== "assistant" || !Array.isArray(m.content)) return;
  for (const c of m.content) {
    if (c?.type !== "toolCall" || typeof c.id !== "string") continue;
    openCall(t, { id: c.id, tool: String(c.name ?? "tool"), summary: preview(c.arguments, SUMMARY_MAX) || undefined, startedAt: time(o.timestamp ?? m.timestamp) });
  }
}

/** The most recently started call that has no result yet. */
export function currentTool(t: Tally): CurrentTool | undefined {
  const c = t.open?.at(-1);
  if (!c) return undefined;
  return { tool: c.tool, ...(c.summary && { summary: c.summary }), ...(c.startedAt !== undefined && { startedAt: c.startedAt }) };
}

export interface TranscriptRequest {
  path: string;
  /** The parent agent's kind: `claude`, `codex`, or `pi`. */
  kind: string;
  /** How much of the end of the transcript to read. */
  bytes?: number;
  /** Codex: skip lines before this ordinal. */
  fromOrdinal?: number;
}

export interface TranscriptOutput {
  text: string;
  /** The transcript is longer than what was read. */
  truncated: boolean;
}

export const TRANSCRIPT_BYTES = 256 * 1024;
const MESSAGE_MAX = 4000;

/** A tool call's main argument on one line, such as its command or file path. */
function preview(input: JsonValue | undefined, max = 120): string {
  if (input === undefined || input === null) return "";
  const pick =
    typeof input !== "object"
      ? input
      : (input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description ?? input.prompt ?? JSON.stringify(input));
  const s = (Array.isArray(pick) ? pick.join(" ") : String(pick)).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > MESSAGE_MAX ? `${t.slice(0, MESSAGE_MAX - 1)}…` : t;
}

/** A prompt as `› text`. Its later lines are indented, so a blank line inside it never separates two entries. */
function asPrompt(text: string): string {
  return `› ${text.replace(/\n/g, "\n  ")}`;
}

function codexArgs(v: JsonValue | undefined): JsonValue | undefined {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** One transcript line as text: messages, and one line per tool call. Tool results are left out. */
export function transcriptLine(kind: string, o: Json, fromOrdinal?: number): string | undefined {
  if (kind === "codex") {
    if (typeof o.ordinal === "number" && fromOrdinal !== undefined && o.ordinal < fromOrdinal) return undefined;
    const p = o.payload;
    if (o.type !== "response_item" || !p) return undefined;
    if (p.type === "message" && (p.role === "assistant" || p.role === "user")) {
      const text = clip(textOf(p.content));
      return text && (p.role === "user" ? asPrompt(text) : text);
    }
    if (p.type === "agent_message") return asPrompt(clip(textOf(p.content)));
    if (CODEX_TOOL_ITEMS.has(p.type)) return `→ ${p.name ?? p.type} ${preview(codexArgs(p.arguments ?? p.input ?? p.action))}`.trimEnd();
    return undefined;
  }
  const m = o.message;
  const role = m?.role;
  if (role !== "user" && role !== "assistant") return undefined;
  if (typeof m.content === "string") return role === "user" ? asPrompt(clip(m.content)) : clip(m.content);
  if (!Array.isArray(m.content)) return undefined;
  const parts: string[] = [];
  for (const b of m.content) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(role === "user" ? asPrompt(clip(b.text)) : clip(b.text));
    else if (b?.type === "tool_use" || b?.type === "toolCall") parts.push(`→ ${b.name} ${preview(b.input ?? b.arguments)}`.trimEnd());
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** The text of each JSONL line that `line` renders, oldest first. */
export function renderLines(text: string, line: (o: Json) => string | undefined): string[] {
  const out: string[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    let o: Json;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const t = o && typeof o === "object" ? line(o) : undefined;
    if (t) out.push(t);
  }
  return out;
}

/** The plain text of the end of a subagent's transcript, oldest first. */
export function subagentTranscript(req: TranscriptRequest): TranscriptOutput {
  if (!isAbsolute(req.path) || !/\.(jsonl|output)$/.test(req.path)) throw new Error("not a transcript path");
  const bytes = Math.min(Math.max(1024, req.bytes ?? TRANSCRIPT_BYTES), 4 * 1024 * 1024);
  const { text, truncated } = tailText(req.path, bytes);
  return { text: renderLines(text, (o) => transcriptLine(req.kind, o, req.fromOrdinal)).join("\n\n"), truncated };
}

// Claude Code wraps slash commands, `!` shell commands, their output, and background task
// notifications in tags. Commands read as typed; the rest isn't something the user wrote.
function claudeTyped(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith("<")) return text;
  const name = tag(t, "command-name");
  if (name) return [name, tag(t, "command-args")].filter(Boolean).join(" ");
  const shell = tag(t, "bash-input");
  return shell ? `! ${shell}` : undefined;
}

// Codex sends the repo's AGENTS.md and its environment as user messages at the start of a thread.
function codexTyped(text: string): string | undefined {
  const t = text.trim();
  return t.startsWith("<") || t.startsWith("# AGENTS.md instructions") ? undefined : text;
}

/** Content with each text block passed through `typed`, dropping the blocks it rejects. */
function typedContent(content: JsonValue | undefined, typed: (text: string) => string | undefined): JsonValue | undefined {
  if (typeof content === "string") return typed(content);
  if (!Array.isArray(content)) return content;
  return content.flatMap((b) => {
    if (typeof b?.text !== "string") return [b];
    const text = typed(b.text);
    return text === undefined ? [] : [{ ...b, text }];
  });
}

/**
 * One line of an agent's own transcript as text, like `transcriptLine`, leaving out subagents'
 * lines, Claude Code's meta and summary entries, and context the agent injected as user messages.
 */
export function historyLine(kind: string, o: Json): string | undefined {
  if (kind === "claude") {
    if (o.type !== "user" && o.type !== "assistant") return undefined;
    if (o.isSidechain || o.isMeta || o.isCompactSummary || o.isApiErrorMessage || o.message?.model === "<synthetic>") return undefined;
    if (o.type === "user") {
      const content = typedContent(o.message?.content, claudeTyped);
      if (content === undefined) return undefined;
      o = { ...o, message: { ...o.message, content } };
    }
  } else if (kind === "codex") {
    const p = o.payload;
    if (o.type === "response_item" && p?.type === "message" && p.role === "user") o = { ...o, payload: { ...p, content: typedContent(p.content, codexTyped) } };
  }
  return transcriptLine(kind, o);
}

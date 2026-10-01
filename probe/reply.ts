// The final reply of an agent's latest turn, read from its transcript for handoffs, and the end of
// its conversation for previews. server/probe.ts joins this file with probe/usage.ts and
// probe/subagents.ts, so it imports only Node built-ins and those, and its top-level names must
// differ from theirs.
import { isAbsolute } from "node:path";
import { historyLine, renderLines } from "./subagents.ts";
import { defaultRoots, findCursors, tailText, type Json, type ProbeDeps, type ProbeInput, type ProbeRef } from "./usage.ts";

export interface ReplyRequest extends Pick<ProbeInput, "roots" | "herdr" | "claimed"> {
  ref: ProbeRef;
  /** The transcript the usage probe last read for the pane. Without it, the transcript is looked up as the usage probe does. */
  path?: string;
  /** How much of the end of the transcript to read. */
  bytes?: number;
}

export interface ReplyOutput {
  /** Unset when the latest turn has no reply text. */
  text?: string;
  /** The reply was longer than `REPLY_CHARS`; its end was kept. */
  trimmed?: boolean;
  /** The transcript that was read. */
  path?: string;
  error?: string;
}

export const REPLY_BYTES = 512 * 1024;
export const REPLY_CHARS = 8_000;

/** The candidate reply so far. `id` groups the lines of one Claude Code message. */
interface ReplyState {
  id?: unknown;
  parts: string[];
}

function newTurn(s: ReplyState) {
  s.id = undefined;
  s.parts = [];
}

/** Replaces the candidate with `parts`, or adds to it when they're from the same message. */
function setReply(s: ReplyState, parts: string[], id?: unknown) {
  if (parts.length === 0) return;
  if (id !== undefined && id === s.id) s.parts.push(...parts);
  else s.parts = parts;
  s.id = id;
}

function textBlocks(content: unknown, type: string): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (b?.type === type && typeof b.text === "string" && b.text.trim() ? [b.text] : []));
}

/**
 * A user line typed or sent as a prompt. Tool results aren't, and neither are background task
 * notifications, which can land after the reply without starting a turn.
 */
function claudePrompt(content: unknown): boolean {
  if (typeof content === "string") return content.trim() !== "" && !content.startsWith("<task-notification>");
  return Array.isArray(content) && !content.some((b) => b?.type === "tool_result") && content.some((b) => b?.type === "text");
}

// Claude Code writes each content block of a response as its own line, all with the response's
// `message.id`, and tool results can land between them. The reply is the text of the last
// response in the turn that has any: earlier ones are narration between tool calls.
function claudeReply(o: Json, s: ReplyState) {
  if (o.isSidechain) return;
  const m = o.message;
  if (o.type === "user" && !o.isMeta && claudePrompt(m?.content)) return newTurn(s);
  if (o.type !== "assistant" || m?.model === "<synthetic>" || o.isApiErrorMessage) return;
  setReply(s, textBlocks(m?.content, "text"), m?.id ?? o.uuid);
}

// A Codex turn starts with `task_started`. Its last assistant message is the final answer, which
// `task_complete` repeats as `last_agent_message`; older rollouts log `agent_message` events.
function codexReply(o: Json, s: ReplyState) {
  const p = o.payload;
  if (!p) return;
  if (o.type === "event_msg") {
    if (p.type === "task_started" || p.type === "user_message") newTurn(s);
    else if (p.type === "agent_message") setReply(s, textBlocks(p.message, "text"));
    else if (p.type === "task_complete") setReply(s, textBlocks(p.last_agent_message, "text"));
  } else if (o.type === "response_item") {
    // `agent_message` items are messages from other agents in the thread's tree.
    if ((p.type === "message" && p.role === "user") || p.type === "agent_message") newTurn(s);
    else if (p.type === "message" && p.role === "assistant") setReply(s, [textBlocks(p.content, "output_text").join("\n")].filter(Boolean));
  }
}

function piReply(o: Json, s: ReplyState) {
  const m = o.message;
  if (o.type !== "message") return;
  if (m?.role === "user") newTurn(s);
  else if (m?.role === "assistant") setReply(s, textBlocks(m.content, "text"));
}

const REPLY_READERS: Record<string, (o: Json, s: ReplyState) => void> = { claude: claudeReply, codex: codexReply, pi: piReply };

/** Keeps the last `REPLY_CHARS` characters, dropping a partial first word. */
export function trimReply(text: string): { text: string; trimmed?: boolean } {
  if (text.length <= REPLY_CHARS) return { text };
  const tail = text.slice(-REPLY_CHARS);
  const cut = /^\S{0,80}\s+/.exec(tail);
  return { text: cut ? tail.slice(cut[0].length) : tail, trimmed: true };
}

/** The final reply of the latest turn in a transcript's lines, or undefined when it has no text. */
export function replyText(kind: string, transcript: string): string | undefined {
  const read = REPLY_READERS[kind];
  if (!read) throw new Error(`no transcript reader for ${kind} sessions`);
  const s: ReplyState = { parts: [] };
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let o: Json;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o && typeof o === "object") read(o, s);
  }
  return s.parts.join("\n\n").trim() || undefined;
}

/** The transcript to read for a request: the one given, or found as the usage probe would. */
function requestedTranscript(req: ReplyRequest, deps: ProbeDeps): string {
  let path = req.path;
  if (!path) {
    const roots = { ...defaultRoots(), ...req.roots };
    const input = { refs: [req.ref], herdr: req.herdr, claimed: req.claimed };
    const [found] = findCursors(input, roots, (deps.now ?? Date.now)(), deps);
    if (found.error) throw new Error(found.error);
    path = found.cursor?.path;
    if (!path) throw new Error("transcript not found");
  }
  if (!isAbsolute(path) || !path.endsWith(".jsonl")) throw new Error("not a transcript path");
  return path;
}

/** The final reply of a pane's latest turn, from its transcript. Failures are returned as `error`. */
export function finalReply(req: ReplyRequest, deps: ProbeDeps = {}): ReplyOutput {
  try {
    const path = requestedTranscript(req, deps);
    const text = replyText(req.ref.kind, tailText(path, req.bytes ?? REPLY_BYTES).text);
    return text ? { ...trimReply(text), path } : { path };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export interface HistoryOutput {
  /** Prompts as `› text`, tool calls as `→ name args`, and the agent's messages, oldest first, separated by blank lines. */
  text?: string;
  /** There's earlier history than `text` shows. */
  truncated?: boolean;
  /** The transcript that was read. */
  path?: string;
  error?: string;
}

// Tool output fills most of a transcript, so 512 KB holds only a few turns; 4 MB usually fills HISTORY_CHARS.
export const HISTORY_BYTES = 4 * 1024 * 1024;
export const HISTORY_CHARS = 60_000;

/** The last entries that fit in `max` characters joined; a single longer entry keeps its end. */
export function keepEnd(entries: string[], max: number): { text: string; cut: boolean } {
  let i = entries.length;
  let size = -2;
  while (i > 0 && size + entries[i - 1].length + 2 <= max) size += entries[--i].length + 2;
  if (i === entries.length && i > 0) return { text: entries[i - 1].slice(-max), cut: true };
  return { text: entries.slice(i).join("\n\n"), cut: i > 0 };
}

/** The end of a pane's main conversation as text, from its transcript. Failures are returned as `error`. */
export function agentHistory(req: ReplyRequest, deps: ProbeDeps = {}): HistoryOutput {
  try {
    const kind = req.ref.kind;
    if (!REPLY_READERS[kind]) throw new Error(`no transcript reader for ${kind} sessions`);
    const path = requestedTranscript(req, deps);
    const tail = tailText(path, req.bytes ?? HISTORY_BYTES);
    const { text, cut } = keepEnd(renderLines(tail.text, (o) => historyLine(kind, o)), HISTORY_CHARS);
    return { text, truncated: tail.truncated || cut, path };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

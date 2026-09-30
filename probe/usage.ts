// Reads agent transcripts on the machine where the agents run and returns each agent's
// context use and recorded cost. herdr-map pipes this file to `node --input-type=module-typescript -`
// (locally, or over SSH) with a call to `probe()` appended, so it must stay a single file
// that imports only Node built-ins.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** What the transcript says so far. Carried in the cursor between runs. */
export interface Tally {
  model?: string;
  provider?: string;
  /** Input-side tokens of the latest turn, including cache reads and writes: the context the model saw. */
  contextTokens?: number;
  /** Context window recorded in the transcript. Only Codex records one. */
  contextWindow?: number;
  /** Sum of the costs the agent recorded. Only Pi records cost. */
  costUsd?: number;
}

/** Where a transcript is and how far it has been read. Each run returns it; the server sends it back with the next. */
export interface Cursor {
  path: string;
  offset: number;
  /** The offset is inside a line that should be dropped, up to the next newline. */
  skip?: boolean;
  /** The reader has reached the end of the file once, so the tally covers everything it needs. */
  caughtUp?: boolean;
  tally: Tally;
  /** Claude Code: which session the pane's process is on, and when that was last checked. */
  claude?: ClaudeFollow;
}

export interface ClaudeFollow {
  /** The session ID the transcript is named after. May differ from the one herdr reports. */
  session: string;
  /** The pane's Claude Code process, when it was found. */
  pid?: number;
  /** When the session was last resolved, in ms on the probe's machine. */
  resolvedAt: number;
  /** When the transcript last grew, in ms on the probe's machine. */
  grewAt: number;
}

export interface ProbeRef {
  pane: string;
  /** herdr's agent kind: `claude`, `codex`, or `pi`. */
  kind: string;
  /** `agent_session.kind`: `id` for Claude Code and Codex, `path` for Pi. */
  sessionKind: string;
  session: string;
  cwd?: string;
  /** herdr's agent status: `working`, `blocked`, `done`, or `idle`. */
  status?: string;
  cursor?: Cursor;
}

export interface Roots {
  claude: string;
  codex: string;
  pi: string;
}

export interface ProbeInput {
  refs: ProbeRef[];
  /** Bytes to read in this run, across all transcripts. */
  maxBytes?: number;
  /** How much of the end of a Claude Code or Codex transcript to read when it's new or far behind. */
  tailBytes?: number;
  /** Agent home directories; defaults follow each agent's own environment variable. */
  roots?: Partial<Roots>;
  /** herdr executable on the probe's machine, for finding a Claude Code pane's process. */
  herdr?: string;
}

/** A foreground process of a pane, as `herdr pane process-info` reports it. */
export interface PaneProcess {
  pid: number;
  argv0?: string;
  name?: string;
}

export interface ProbeDeps {
  /** A pane's foreground processes, or undefined when they can't be read. Defaults to asking herdr. */
  processes?: (pane: string) => PaneProcess[] | undefined;
  now?: () => number;
}

export interface Usage {
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  costUsd?: number;
}

export interface ProbeResult {
  pane: string;
  cursor?: Cursor;
  /** Set once the transcript has been read to its end. */
  usage?: Usage;
  error?: string;
}

export interface ProbeOutput {
  results: ProbeResult[];
  bytesRead: number;
}

export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TAIL_BYTES = 1024 * 1024;

export function defaultRoots(): Roots {
  const home = homedir();
  return {
    claude: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    codex: process.env.CODEX_HOME || join(home, ".codex"),
    pi: process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"),
  };
}

// Claude Code session IDs and Codex thread IDs are UUIDs; this keeps them out of path joins otherwise.
const SESSION_ID = /^[A-Za-z0-9-]{1,80}$/;

/** Claude Code keeps a session at `projects/<cwd with every non-alphanumeric as ->/<id>.jsonl`. */
export function claudeTranscript(root: string, id: string, cwd?: string): string | undefined {
  const projects = join(root, "projects");
  const file = `${id}.jsonl`;
  if (cwd) {
    const guess = join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), file);
    if (existsSync(guess)) return guess;
  }
  // The session may have started in another directory than the pane's current one.
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const p = join(projects, d, file);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function findRollout(dir: string, id: string): string | undefined {
  try {
    const f = readdirSync(dir).find((name) => name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`));
    return f && join(dir, f);
  } catch {
    return undefined;
  }
}

/**
 * Codex keeps a thread at `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, dated in local time.
 * Thread IDs are UUIDv7, whose first 48 bits are the creation time in ms, so the day folder
 * can be computed. Neighboring days cover time zone and midnight differences.
 */
export function codexTranscript(root: string, id: string): string | undefined {
  const sessions = join(root, "sessions");
  const ms = parseInt(id.replaceAll("-", "").slice(0, 12), 16);
  if (Number.isFinite(ms) && ms > 0) {
    for (const shift of [0, -1, 1]) {
      const d = new Date(ms + shift * 86_400_000);
      const found = findRollout(join(sessions, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())), id);
      if (found) return found;
    }
  }
  // Not a UUIDv7, or filed elsewhere: look through every day folder.
  for (const y of safeList(sessions))
    for (const m of safeList(join(sessions, y)))
      for (const d of safeList(join(sessions, y, m))) {
        const found = findRollout(join(sessions, y, m, d), id);
        if (found) return found;
      }
  return undefined;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
}

export function locate(ref: ProbeRef, roots: Roots): string {
  if (ref.sessionKind === "path") {
    if (!isAbsolute(ref.session)) throw new Error("session path is not absolute");
    return ref.session;
  }
  if (!SESSION_ID.test(ref.session)) throw new Error("unexpected session id");
  let found: string | undefined;
  if (ref.kind === "claude") found = claudeTranscript(roots.claude, ref.session, ref.cwd);
  else if (ref.kind === "codex") found = codexTranscript(roots.codex, ref.session);
  else throw new Error(`no transcript reader for ${ref.kind} sessions`);
  if (!found) throw new Error("transcript not found");
  return found;
}

type Json = Record<string, any>;

function readJson(path: string): Json | undefined {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    return o && typeof o === "object" ? o : undefined;
  } catch {
    return undefined;
  }
}

function validId(v: unknown): v is string {
  return typeof v === "string" && SESSION_ID.test(v);
}

function fileSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

// herdr pane IDs look like `w3:p2W`.
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;

/** Reads a pane's foreground processes with `herdr pane process-info`, which changes nothing. */
export function herdrProcesses(bin: string): (pane: string) => PaneProcess[] | undefined {
  // A missing or hung herdr fails the same way for every pane, so it's given up on for the run.
  let broken = false;
  return (pane) => {
    if (broken || !PANE_ID.test(pane)) return undefined;
    try {
      const out = execFileSync(bin, ["pane", "process-info", "--pane", pane], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      const ps = JSON.parse(out)?.result?.process_info?.foreground_processes;
      return Array.isArray(ps) ? ps.filter((p) => Number.isSafeInteger(p?.pid) && p.pid > 0) : undefined;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "ETIMEDOUT") broken = true;
      return undefined;
    }
  };
}

export interface ClaudeSession {
  session: string;
  pid: number;
  /** Where the session started, which names its project folder. */
  cwd?: string;
}

function looksLikeClaude(p: PaneProcess): boolean {
  return [p.argv0, p.name].some((n) => typeof n === "string" && /(^|\/)claude[^/]*$/i.test(n));
}

function parkedJob(dir: string, jobId: string): Json | undefined {
  let best: Json | undefined;
  for (const f of safeList(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const o = readJson(join(dir, f));
    if (!o || !validId(o.sessionId) || (o.jobId !== jobId && !o.sessionId.startsWith(jobId))) continue;
    if (!best || num(o.updatedAt) > num(best.updatedAt)) best = o;
  }
  return best;
}

/**
 * The session a pane's Claude Code process is on, from `sessions/<pid>.json`. herdr's session ID
 * can be stale: when a conversation is moved to the background, the interactive process keeps
 * its old `sessionId` and records the job as `parkedJobId`, and the background process's own
 * entry (`jobId`) has the session that's being written.
 */
export function claudeSession(root: string, processes: PaneProcess[]): ClaudeSession | undefined {
  const dir = join(root, "sessions");
  const claudeFirst = [...processes].sort((a, b) => Number(looksLikeClaude(b)) - Number(looksLikeClaude(a)));
  for (const p of claudeFirst) {
    const own = readJson(join(dir, `${p.pid}.json`));
    if (!own || !validId(own.sessionId)) continue;
    const job = typeof own.parkedJobId === "string" && own.parkedJobId ? parkedJob(dir, own.parkedJobId) : undefined;
    const s = job ?? own;
    return { session: s.sessionId, pid: p.pid, cwd: typeof s.cwd === "string" ? s.cwd : undefined };
  }
  return undefined;
}

// A Claude Code pane's session is checked on first sight and then every minute, or every 30 s
// while its agent is working or blocked and the transcript has stopped growing.
export const CLAUDE_RECHECK_MS = 60_000;
export const CLAUDE_STALL_MS = 30_000;

export function claudeRecheckDue(status: string | undefined, follow: ClaudeFollow, now: number): boolean {
  const since = now - follow.resolvedAt;
  const stalled = (status === "working" || status === "blocked") && now - follow.grewAt >= CLAUDE_STALL_MS;
  return since < 0 || since >= (stalled ? CLAUDE_STALL_MS : CLAUDE_RECHECK_MS);
}

/** The cursor for a Claude Code pane. When a check is due, it follows the pane's process to its current session. */
export function claudeCursor(ref: ProbeRef, roots: Roots, now: number, processes: (pane: string) => PaneProcess[] | undefined): Cursor {
  const cursor = ref.cursor;
  const follow = cursor?.claude;
  const size = cursor && fileSize(cursor.path);
  if (cursor && follow && size !== undefined) {
    if (size > cursor.offset) follow.grewAt = now;
    if (!claudeRecheckDue(ref.status, follow, now)) return cursor;
  }
  const ps = processes(ref.pane);
  const found = ps && claudeSession(roots.claude, ps);
  let session = ref.session;
  let path: string | undefined;
  if (found && found.session !== ref.session) {
    path = claudeTranscript(roots.claude, found.session, found.cwd ?? ref.cwd);
    if (path) session = found.session;
  }
  path ??= locate(ref, roots);
  if (cursor?.path === path) {
    cursor.claude = { session, pid: found?.pid, resolvedAt: now, grewAt: follow?.grewAt ?? now };
    return cursor;
  }
  return { path, offset: 0, tally: {}, claude: { session, pid: found?.pid, resolvedAt: now, grewAt: now } };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function claudeLine(o: Json, t: Tally) {
  const m = o.message;
  if (o.type !== "assistant" || o.isSidechain || !m?.usage || m.model === "<synthetic>") return;
  const u = m.usage;
  const input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  if (input === 0) return;
  t.contextTokens = input;
  t.model = m.model;
}

function codexLine(o: Json, t: Tally) {
  const p = o.payload;
  if (o.type === "turn_context" && typeof p?.model === "string") t.model = p.model;
  if (o.type !== "event_msg" || p?.type !== "token_count" || !p.info) return;
  // OpenAI counts cached input inside input_tokens.
  const input = num(p.info.last_token_usage?.input_tokens);
  if (input > 0) t.contextTokens = input;
  if (num(p.info.model_context_window) > 0) t.contextWindow = p.info.model_context_window;
}

function piLine(o: Json, t: Tally) {
  // Assistant messages carry the turn's usage; `usage` entries record extra calls such as cache warming.
  const u = o.type === "usage" ? o.usage : o.type === "message" && o.message?.role === "assistant" ? o.message.usage : undefined;
  if (!u) return;
  const cost = u.cost?.total;
  if (typeof cost === "number" && Number.isFinite(cost)) t.costUsd = (t.costUsd ?? 0) + cost;
  if (o.type !== "message") return;
  const input = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
  if (input === 0) return;
  t.contextTokens = input;
  t.model = o.message.model;
  t.provider = o.message.provider;
}

const READERS: Record<string, { marker: string[]; read: (o: Json, t: Tally) => void; history: boolean }> = {
  claude: { marker: ['"usage"'], read: claudeLine, history: false },
  codex: { marker: ['"token_count"', '"turn_context"'], read: codexLine, history: false },
  // Pi's cost is a sum over the whole session, so its transcript is read from the start.
  pi: { marker: ['"usage"'], read: piLine, history: true },
};

/** Applies complete JSON lines to a tally. Lines that aren't JSON, or aren't relevant, are skipped. */
export function readLines(kind: string, text: string, tally: Tally): Tally {
  const reader = READERS[kind];
  if (!reader) throw new Error(`no transcript reader for ${kind} sessions`);
  for (const line of text.split("\n")) {
    // Most lines are tool output; checking for a marker first avoids parsing them.
    if (!reader.marker.some((m) => line.includes(m))) continue;
    let o: Json;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o && typeof o === "object") reader.read(o, tally);
  }
  return tally;
}

/**
 * Reads new complete lines from the cursor's offset, up to `budget` bytes, and returns the bytes read.
 * A partial last line is left for the next run. A line longer than `maxLine` is dropped.
 */
export function advance(cursor: Cursor, kind: string, budget: number, tailBytes: number, maxLine: number): number {
  const reader = READERS[kind];
  if (!reader) throw new Error(`no transcript reader for ${kind} sessions`);
  const fd = openSync(cursor.path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < cursor.offset) {
      // Rewritten or truncated: start over.
      cursor.offset = 0;
      cursor.skip = false;
      cursor.caughtUp = false;
      cursor.tally = {};
    }
    // Claude Code and Codex only need the latest turn, so skip history they're far behind on.
    if (!reader.history && size - cursor.offset > tailBytes) {
      cursor.offset = size - tailBytes;
      cursor.skip = true;
    }
    const pending = size - cursor.offset;
    const n = Math.min(pending, budget);
    if (pending === 0) cursor.caughtUp = true;
    if (n <= 0) return 0;
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, cursor.offset);
    const atEnd = n === pending;
    let start = 0;
    if (cursor.skip) {
      const nl = buf.indexOf(10);
      if (nl < 0) {
        cursor.offset += n;
        if (atEnd) cursor.caughtUp = true;
        return n;
      }
      start = nl + 1;
      cursor.skip = false;
    }
    // UTF-8 continuation bytes are never 0x0a, so cutting at a newline never splits a character.
    const end = buf.lastIndexOf(10);
    if (end < start) {
      if (!atEnd && n - start >= maxLine) {
        cursor.offset += n;
        cursor.skip = true;
      } else {
        cursor.offset += start;
        if (atEnd) cursor.caughtUp = true;
      }
      return n;
    }
    readLines(kind, buf.subarray(start, end).toString("utf8"), cursor.tally);
    cursor.offset += end + 1;
    if (atEnd) cursor.caughtUp = true;
    return n;
  } finally {
    closeSync(fd);
  }
}

// Context windows for Claude models, which Claude Code transcripts don't record. Current
// models have 1M tokens; Haiku and models before Opus and Sonnet 4.6 have 200K. Models not
// listed show tokens without a percentage.
const CLAUDE_WINDOWS: [RegExp, number][] = [
  [/^claude-haiku-/, 200_000],
  [/^claude-3|^claude-(opus|sonnet)-4-([0-5](\D|$)|\d{8})/, 200_000],
  [/^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|[5-9])/, 1_000_000],
];

export function claudeWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  return CLAUDE_WINDOWS.find(([re]) => re.test(model))?.[1];
}

type PiModels = Record<string, { models?: { id?: string; contextWindow?: number }[] }>;

/** Pi's model registry: the fetched catalog and the user's own models.json. */
export function piWindows(root: string): (provider?: string, model?: string) => number | undefined {
  const sources: PiModels[] = [];
  for (const [file, pick] of [
    ["models.json", (o: Json) => o.providers],
    ["models-store.json", (o: Json) => o],
  ] as const) {
    try {
      const o = pick(JSON.parse(readFileSync(join(root, file), "utf8")));
      if (o && typeof o === "object") sources.push(o);
    } catch {}
  }
  return (provider, model) => {
    if (!provider || !model) return undefined;
    for (const s of sources) {
      const w = s[provider]?.models?.find((m) => m.id === model)?.contextWindow;
      if (typeof w === "number" && w > 0) return w;
    }
    return undefined;
  };
}

export function summarize(kind: string, tally: Tally, piWindow: () => ReturnType<typeof piWindows>): Usage {
  let window = tally.contextWindow;
  if (!window && kind === "pi") window = piWindow()(tally.provider, tally.model);
  if (!window) window = claudeWindow(tally.model);
  // A window smaller than what was used is wrong for this session (a different tier, say); show tokens only.
  if (window && tally.contextTokens && tally.contextTokens > window) window = undefined;
  return {
    model: tally.model,
    contextTokens: tally.contextTokens,
    contextWindow: window,
    costUsd: tally.costUsd === undefined ? undefined : Math.round(tally.costUsd * 1e6) / 1e6,
  };
}

export function probe(input: ProbeInput, deps: ProbeDeps = {}): ProbeOutput {
  const roots = { ...defaultRoots(), ...input.roots };
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const tailBytes = input.tailBytes ?? DEFAULT_TAIL_BYTES;
  const now = (deps.now ?? Date.now)();
  let processes = deps.processes;
  const paneProcesses = (pane: string) => (processes ??= herdrProcesses(input.herdr ?? "herdr"))(pane);
  let pi: ReturnType<typeof piWindows> | undefined;
  const piWindow = () => (pi ??= piWindows(roots.pi));
  let bytesRead = 0;
  const results: ProbeResult[] = [];
  for (const ref of input.refs) {
    try {
      let cursor = ref.cursor;
      if (ref.kind === "claude" && ref.sessionKind === "id") cursor = claudeCursor(ref, roots, now, paneProcesses);
      else {
        const moved = ref.sessionKind === "path" && cursor?.path !== ref.session;
        if (!cursor || moved || !existsSync(cursor.path)) cursor = { path: locate(ref, roots), offset: 0, tally: {} };
      }
      bytesRead += advance(cursor, ref.kind, maxBytes - bytesRead, tailBytes, maxBytes);
      results.push({ pane: ref.pane, cursor, usage: cursor.caughtUp ? summarize(ref.kind, cursor.tally, piWindow) : undefined });
    } catch (err) {
      results.push({ pane: ref.pane, error: (err as Error).message });
    }
  }
  return { results, bytesRead };
}

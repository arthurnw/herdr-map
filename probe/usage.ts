// Reads agent transcripts on the machine where the agents run and returns each agent's
// context use and recorded cost, and its subagents and task progress (probe/subagents.ts).
// herdr-map joins the probe files and pipes them to `node --input-type=module-typescript -`
// (locally, or over SSH) with a call to `probe()` (or another entry point) appended, so they
// import only Node built-ins and each other.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  activity,
  claudeActivity,
  codexActivity,
  piActivity,
  SUBAGENT_READERS,
  type Activity,
  type ChildStats,
  type SubagentContext,
  type SubagentState,
  type SubLog,
  type TaskList,
} from "./subagents.ts";

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
  /** Subagents the transcript has started or heard back from. */
  subs?: SubLog;
  /** Claude Code: the time of the first line read, when reading started at the tail. */
  subsFrom?: number;
  /** The agent's todo list. */
  tasks?: TaskList;
  /** Set in a subagent transcript's tally. */
  child?: ChildStats;
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
  /** Subagent transcripts being followed. */
  subagents?: SubagentState;
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
  /** Set when nothing on disk links the pane to a transcript and its screen was matched instead. */
  screen?: ScreenCheck;
}

export interface ScreenCheck {
  /** When the screen was last read, in ms on the probe's machine. */
  checkedAt: number;
  /** A hash of the lines picked from the screen then. */
  print: string;
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
  /** Claude Code session IDs that panes not in `refs` are on, so no other pane is matched to them. */
  claimed?: string[];
}

/** A foreground process of a pane, as `herdr pane process-info` reports it. */
export interface PaneProcess {
  pid: number;
  argv0?: string;
  argv?: string[];
  name?: string;
}

export interface ProbeDeps {
  /** A pane's foreground processes, or undefined when they can't be read. Defaults to asking herdr. */
  processes?: (pane: string) => PaneProcess[] | undefined;
  /** A pane's visible screen, or undefined when it can't be read. Defaults to asking herdr. */
  screen?: (pane: string) => string | undefined;
  now?: () => number;
}

export interface Usage {
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  costUsd?: number;
}

export interface ProbeResult extends Activity {
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

export function safeList(dir: string): string[] {
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

export type Json = Record<string, any>;
export type JsonValue = Json | string | number | boolean | null;

/** The message of a caught error. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function readJson(path: string): Json | undefined {
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

export function fileSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

// herdr pane IDs look like `w3:p2W`.
const PANE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;

export type HerdrCall = (args: string[]) => string | undefined;

/** Runs a herdr command and returns its output, or undefined when it fails. */
export function herdrCaller(bin: string): HerdrCall {
  // A missing or hung herdr fails the same way for every pane, so it's given up on for the run.
  let broken = false;
  return (args) => {
    if (broken) return undefined;
    try {
      return execFileSync(bin, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    } catch (err) {
      // SAFETY: execFileSync throws Errors; spawn failures and timeouts carry a `code`.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "ETIMEDOUT") broken = true;
      return undefined;
    }
  };
}

/** A pane's processes as `herdr pane process-info` reports them. */
export interface ProcessInfo {
  /** The shell herdr started in the pane. */
  shellPid?: number;
  foreground: PaneProcess[];
}

const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;

export function parseProcessInfo(out: string): ProcessInfo | undefined {
  try {
    const info = JSON.parse(out)?.result?.process_info;
    const ps = info?.foreground_processes;
    if (!Array.isArray(ps)) return undefined;
    return { ...(validPid(info.shell_pid) && { shellPid: info.shell_pid }), foreground: ps.filter((p) => validPid(p?.pid)) };
  } catch {
    return undefined;
  }
}

/** Reads a pane's shell and foreground processes with `herdr pane process-info`, which changes nothing. */
export function herdrProcessInfo(bin: string, call = herdrCaller(bin)): (pane: string) => ProcessInfo | undefined {
  return (pane) => {
    const out = PANE_ID.test(pane) ? call(["pane", "process-info", "--pane", pane]) : undefined;
    return out === undefined ? undefined : parseProcessInfo(out);
  };
}

/** Reads a pane's foreground processes with `herdr pane process-info`, which changes nothing. */
export function herdrProcesses(bin: string, call = herdrCaller(bin)): (pane: string) => PaneProcess[] | undefined {
  const info = herdrProcessInfo(bin, call);
  return (pane) => info(pane)?.foreground;
}

/** Reads a pane's visible screen with `herdr pane read`, which changes nothing. */
export function herdrScreen(bin: string, call = herdrCaller(bin)): (pane: string) => string | undefined {
  return (pane) => (PANE_ID.test(pane) ? call(["pane", "read", pane, "--source", "visible", "--lines", "80"]) : undefined);
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
// The server sends an idle pane once a minute, timed on its own clock; a check falls due this
// much early so run-to-run latency can't push it to the minute after.
export const CLAUDE_RECHECK_SLACK_MS = 5_000;

export function claudeRecheckDue(status: string | undefined, follow: ClaudeFollow, now: number): boolean {
  const since = now - follow.resolvedAt;
  const stalled = (status === "working" || status === "blocked") && now - follow.grewAt >= CLAUDE_STALL_MS;
  return since < 0 || since >= (stalled ? CLAUDE_STALL_MS : CLAUDE_RECHECK_MS) - CLAUDE_RECHECK_SLACK_MS;
}

/**
 * The cursor for a Claude Code pane. When a check is due, it follows the pane's process to its
 * current session. Undefined when no transcript is linked to the pane.
 */
export function claudeCursor(ref: ProbeRef, roots: Roots, now: number, processes: (pane: string) => PaneProcess[] | undefined): Cursor | undefined {
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
  if (!path) {
    if (!SESSION_ID.test(ref.session)) throw new Error("unexpected session id");
    path = claudeTranscript(roots.claude, ref.session, ref.cwd);
    if (!path) return undefined;
  }
  if (cursor?.path === path) {
    cursor.claude = { session, pid: found?.pid, resolvedAt: now, grewAt: follow?.grewAt ?? now };
    return cursor;
  }
  return { path, offset: 0, tally: {}, claude: { session, pid: found?.pid, resolvedAt: now, grewAt: now } };
}

// Screen matching, for a Claude Code pane whose process's session has no transcript and whose
// conversation no sessions entry points to, as happens after some moves to the background:
// lines from the pane's screen are looked up in the tails of candidate transcripts.
export const SCREEN_RETRY_MS = 3 * 60_000;
export const SCREEN_LINES = 4;
export const SCREEN_CANDIDATES = 8;
export const SCREEN_TAIL_BYTES = 512 * 1024;
export const SCREEN_RECENT_MS = 3 * 86_400_000;

// Box drawing, block elements, braille spinners, and private-use icon glyphs mark UI chrome.
const CHROME_CHARS = /[\u2500-\u259f\u2800-\u28ff\ue000-\uf8ff]|[\u{f0000}-\u{10ffff}]/u;
// Prompts, spinners, recaps, and status lines.
const CHROME_START = /^[❯›>$%※✻✶✳✢✽⏵·]/u;
const CHROME_TEXT = /esc to (interrupt|cancel)|ctrl\+|shift\+tab|\/clear\b|for shortcuts|auto mode|accept edits|bypass permissions|-- (insert|normal) --/i;

/** Lowercased letters and digits with one space between runs, which survives both terminal rendering and JSON escaping. */
export function screenText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The longest lines of a screen that look like conversation rather than UI, reduced by `screenText`. */
export function screenLines(screen: string, n = SCREEN_LINES): string[] {
  const picked = new Set<string>();
  for (const raw of screen.split("\n")) {
    const line = raw.trim();
    if (CHROME_CHARS.test(line) || CHROME_START.test(line) || CHROME_TEXT.test(line)) continue;
    const t = screenText(line);
    if (t.length >= 40 && t.split(" ").length >= 6) picked.add(t);
  }
  return [...picked].sort((a, b) => b.length - a.length).slice(0, n);
}

// Fields of message content that aren't shown as text, or are large and never on screen.
const HIDDEN_FIELDS = new Set(["thinking", "signature", "id", "tool_use_id", "type", "source", "data"]);

function shownText(v: unknown, out: string[]) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) shownText(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!HIDDEN_FIELDS.has(k)) shownText(x, out);
}

/** The last `bytes` of a file as text, from the first line start. `truncated` is set when the file is longer. */
export function tailText(path: string, bytes: number): { text: string; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    const text = buf.toString("utf8");
    return n < size ? { text: text.slice(text.indexOf("\n") + 1), truncated: true } : { text, truncated: false };
  } finally {
    closeSync(fd);
  }
}

/** The text of the main-thread messages in the last `bytes` of a Claude Code transcript, reduced by `screenText`. */
export function transcriptText(path: string, bytes = SCREEN_TAIL_BYTES): string {
  const { text } = tailText(path, bytes);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"message"')) continue;
    try {
      const o = JSON.parse(line);
      if ((o?.type === "user" || o?.type === "assistant") && !o.isSidechain) shownText(o.message?.content, out);
    } catch {}
  }
  return out.map(screenText).join("\n");
}

/** The one candidate whose text has the screen's lines: the only one with two or more, or the only one with any. */
export function matchScreen(lines: string[], candidates: string[], read: (path: string) => string = transcriptText): string | undefined {
  if (lines.length === 0) return undefined;
  const hits = candidates.flatMap((path) => {
    let text = "";
    try {
      text = read(path);
    } catch {}
    const n = lines.filter((l) => text.includes(l)).length;
    return n > 0 ? [{ path, n }] : [];
  });
  if (hits.length === 1) return hits[0].path;
  const strong = hits.filter((h) => h.n >= 2);
  return strong.length === 1 ? strong[0].path : undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The working trees of the git repository `cwd` is in, read from its `.git` files; just `cwd` outside one. */
export function repoRoots(cwd: string): string[] {
  let dir = cwd;
  while (!existsSync(join(dir, ".git"))) {
    const up = dirname(dir);
    if (up === dir) return [cwd];
    dir = up;
  }
  let common = join(dir, ".git");
  // A linked worktree's `.git` is a file naming its git dir, whose `commondir` leads to the repository's.
  const link = readText(common);
  if (link !== undefined) {
    const m = /^gitdir:\s*(.+)$/m.exec(link);
    if (!m) return [dir];
    const gitdir = resolve(dir, m[1].trim());
    const rel = readText(join(gitdir, "commondir"))?.trim();
    common = rel ? resolve(gitdir, rel) : gitdir;
  }
  const roots = new Set([dir]);
  if (basename(common) === ".git") roots.add(dirname(common));
  for (const wt of safeList(join(common, "worktrees"))) {
    const g = readText(join(common, "worktrees", wt, "gitdir"))?.trim();
    if (g) roots.add(dirname(resolve(common, "worktrees", wt, g)));
  }
  return [...roots];
}

/**
 * Transcripts a pane with no linked transcript might be showing, newest first: background jobs'
 * sessions, and sessions of the pane's git repository modified in the last few days.
 */
export function screenCandidates(root: string, cwd: string | undefined, claimed: Set<string>, now: number): string[] {
  const found = new Map<string, number>();
  const add = (path: string, recentOnly: boolean) => {
    if (found.has(path) || claimed.has(basename(path, ".jsonl"))) return;
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return;
    }
    if (!recentOnly || now - mtime <= SCREEN_RECENT_MS) found.set(path, mtime);
  };
  const sessions = join(root, "sessions");
  for (const f of safeList(sessions)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const o = readJson(join(sessions, f));
    if (o?.kind !== "bg" || !validId(o.sessionId) || claimed.has(o.sessionId)) continue;
    const path = claudeTranscript(root, o.sessionId, typeof o.cwd === "string" ? o.cwd : undefined);
    if (path) add(path, false);
  }
  if (cwd && isAbsolute(cwd)) {
    const projects = join(root, "projects");
    const slugs = repoRoots(cwd).map((r) => r.replace(/[^A-Za-z0-9]/g, "-"));
    for (const d of safeList(projects)) {
      if (!slugs.some((s) => d === s || d.startsWith(`${s}-`))) continue;
      for (const f of safeList(join(projects, d))) if (f.endsWith(".jsonl") && validId(f.slice(0, -6))) add(join(projects, d, f), true);
    }
  }
  return [...found]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SCREEN_CANDIDATES)
    .map(([path]) => path);
}

export interface ScreenContext {
  roots: Roots;
  now: number;
  screen: (pane: string) => string | undefined;
  /** Session IDs other panes are on. */
  claimed: Set<string>;
  /** Screens left to read in this run. */
  reads: number;
}

function fingerprint(lines: string[]): string {
  return createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/**
 * The cursor for a Claude Code pane that no transcript is linked to, found by matching its screen.
 * A match is kept while the screen's lines stay the same or the transcript grows; otherwise, and
 * while nothing matches, the screen is matched again every few minutes. A cursor with an empty
 * path records a failed match. Undefined when the screen wasn't read.
 */
export function screenCursor(ref: ProbeRef, ctx: ScreenContext): Cursor | undefined {
  const prev = ref.cursor;
  const check = prev?.claude?.screen;
  const matched = !!prev?.path && !!check && fileSize(prev.path) !== undefined;
  const keep = () => {
    prev!.claude!.resolvedAt = ctx.now;
    return prev;
  };
  const recent = !!check && ctx.now >= check.checkedAt && ctx.now - check.checkedAt < SCREEN_RETRY_MS;
  if (recent && (matched || !prev!.path)) return keep();
  if (ctx.reads <= 0) return matched ? keep() : undefined;
  ctx.reads--;
  const shown = ctx.screen(ref.pane);
  const lines = shown === undefined ? [] : screenLines(shown);
  const print = fingerprint(lines);
  if (matched && (shown === undefined || print === check!.print || prev!.claude!.grewAt > check!.checkedAt)) {
    if (shown !== undefined) Object.assign(check!, { checkedAt: ctx.now, print });
    return keep();
  }
  const path = shown === undefined ? undefined : matchScreen(lines, screenCandidates(ctx.roots.claude, ref.cwd, ctx.claimed, ctx.now));
  const follow: ClaudeFollow = { session: path ? basename(path, ".jsonl") : ref.session, resolvedAt: ctx.now, grewAt: ctx.now, screen: { checkedAt: ctx.now, print } };
  if (path && path === prev?.path) {
    prev.claude = { ...follow, grewAt: prev.claude?.grewAt ?? ctx.now };
    return prev;
  }
  return { path: path ?? "", offset: 0, tally: {}, claude: follow };
}

export function num(v: unknown): number {
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

export interface TranscriptReader {
  marker: string[];
  read: (o: Json, t: Tally) => void;
  history: boolean;
}

// oxlint-disable-next-line anti-slop/no-known-value-widening -- looked up by any agent kind string
const READERS: Record<string, TranscriptReader> = {
  claude: {
    marker: ['"usage"', '"toolUseResult"', "<task-notification>"],
    read: (o, t) => (claudeLine(o, t), claudeActivity(o, t)),
    history: false,
  },
  codex: { marker: ['"token_count"', '"turn_context"', '"update_plan"'], read: (o, t) => (codexLine(o, t), codexActivity(o, t)), history: false },
  // Pi's cost is a sum over the whole session, so its transcript is read from the start.
  pi: { marker: ['"usage"', '"Agent"', "subagents:record"], read: (o, t) => (piLine(o, t), piActivity(o, t)), history: true },
};

function readerFor(kind: string) {
  return READERS[kind] ?? SUBAGENT_READERS[kind];
}

/** Applies complete JSON lines to a tally. Lines that aren't JSON, or aren't relevant, are skipped. */
export function readLines(kind: string, text: string, tally: Tally): Tally {
  const reader = readerFor(kind);
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
  const reader = readerFor(kind);
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

export interface CursorLookup {
  cursor?: Cursor;
  error?: string;
}

/**
 * Each ref's transcript: its cursor's, or the one its session names, or for a Claude Code pane
 * the one its process is on or its screen matches. A cursor with an empty path found nothing.
 */
export function findCursors(input: ProbeInput, roots: Roots, now: number, deps: ProbeDeps = {}): CursorLookup[] {
  const bin = input.herdr ?? "herdr";
  let call: HerdrCall | undefined;
  let processes = deps.processes;
  const paneProcesses = (pane: string) => (processes ??= herdrProcesses(bin, (call ??= herdrCaller(bin))))(pane);
  let screen = deps.screen;
  const paneScreen = (pane: string) => (screen ??= herdrScreen(bin, (call ??= herdrCaller(bin))))(pane);
  const isClaude = (ref: ProbeRef) => ref.kind === "claude" && ref.sessionKind === "id";

  const found = input.refs.map((ref): CursorLookup => {
    try {
      if (isClaude(ref)) return { cursor: claudeCursor(ref, roots, now, paneProcesses) };
      let cursor = ref.cursor;
      const moved = ref.sessionKind === "path" && cursor?.path !== ref.session;
      if (!cursor || moved || !existsSync(cursor.path)) cursor = { path: locate(ref, roots), offset: 0, tally: {} };
      return { cursor };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  });

  // At most one screen is read and matched per run.
  const ctx: ScreenContext = { roots, now, screen: paneScreen, claimed: new Set(), reads: 1 };
  input.refs.forEach((ref, i) => {
    if (!isClaude(ref) || found[i].cursor || found[i].error) return;
    ctx.claimed = new Set(input.claimed);
    input.refs.forEach((other, j) => {
      if (j === i) return;
      const c = found[j].cursor;
      for (const id of [other.session, other.cursor?.claude?.session, c?.claude?.session, c?.path && basename(c.path, ".jsonl")]) if (id) ctx.claimed.add(id);
    });
    try {
      found[i].cursor = screenCursor(ref, ctx);
    } catch (err) {
      found[i].error = errorMessage(err);
    }
  });
  return found;
}

export function probe(input: ProbeInput, deps: ProbeDeps = {}): ProbeOutput {
  const roots = { ...defaultRoots(), ...input.roots };
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const tailBytes = input.tailBytes ?? DEFAULT_TAIL_BYTES;
  const now = (deps.now ?? Date.now)();
  let pi: ReturnType<typeof piWindows> | undefined;
  const piWindow = () => (pi ??= piWindows(roots.pi));
  const found = findCursors(input, roots, now, deps);

  let bytesRead = 0;
  const results = input.refs.map((ref, i): ProbeResult => {
    const { cursor, error } = found[i];
    if (error) return { pane: ref.pane, error };
    if (!cursor?.path) return { pane: ref.pane, ...(cursor && { cursor }), error: "transcript not found" };
    try {
      bytesRead += advance(cursor, ref.kind, maxBytes - bytesRead, tailBytes, maxBytes);
      return { pane: ref.pane, cursor, usage: cursor.caughtUp ? summarize(ref.kind, cursor.tally, piWindow) : undefined };
    } catch (err) {
      return { pane: ref.pane, error: errorMessage(err) };
    }
  });

  // Subagent transcripts get what's left of the budget once every agent's own is read.
  const sub: SubagentContext = { roots, now, budget: maxBytes - bytesRead, maxLine: maxBytes, heads: new Map() };
  results.forEach((res, i) => {
    if (!res.cursor?.path || res.error) return;
    try {
      Object.assign(res, activity(input.refs[i], res.cursor, sub));
    } catch {}
  });
  return { results, bytesRead: maxBytes - sub.budget };
}

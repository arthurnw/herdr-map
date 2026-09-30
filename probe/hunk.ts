// Lists live hunk review sessions with their notes, and the hunk herdr plugin's record of which
// agent owns each review and which of your comments it sent. Runs where herdr and hunk run, like
// the usage probe, and imports only Node built-ins. It only reads: `hunk session list` and, for
// a session that doesn't include its notes, `hunk session comment list`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HunkNote } from "../shared/hunk.ts";

export interface HunkRequest {
  hunk?: string;
}

export interface HunkSession {
  id: string;
  repo: string;
  cwd?: string;
  title?: string;
  notes: HunkNote[];
}

/** The plugin's record for a reviewed worktree. */
export interface HunkIndexEntry {
  worktree: string;
  agentPane?: string;
  agentName?: string;
  /** The review pane the plugin opened. */
  pane?: string;
}

export interface HunkOutput {
  /** Set when hunk isn't installed on this machine. */
  missing?: boolean;
  sessions: HunkSession[];
  /** Entries for the sessions' repos only. */
  index: HunkIndexEntry[];
  errors: string[];
}

const HUNK_TIMEOUT_MS = 10_000;
const MAX_NOTES = 200;
const MAX_SUMMARY = 300;
const MAX_DETAIL = 2000;

/** The plugin's per-worktree index, in herdr's plugin state directory. */
export function indexPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_MAP_HUNK_INDEX) return env.HERDR_MAP_HUNK_INDEX;
  const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "herdr", "plugins", "jhochenbaum.hunkdiff", "review-index.json");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** One of hunk's review notes (`comment list --type all`, or a session's `reviewNotes`). */
export function toNote(raw: unknown, sent: Set<string>): HunkNote | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const id = str(r.noteId);
  const file = str(r.filePath);
  if (!id || !file || typeof r.body !== "string") return undefined;
  const range = (Array.isArray(r.newRange) ? r.newRange : Array.isArray(r.oldRange) ? r.oldRange : undefined) as unknown[] | undefined;
  const line = typeof range?.[0] === "number" ? range[0] : undefined;
  const [first, ...rest] = r.body.trim().split("\n");
  const detail = rest.join("\n").trim();
  const createdAt = typeof r.createdAt === "string" ? Date.parse(r.createdAt) : NaN;
  const source = r.source === "user" ? "user" : "agent";
  return {
    id,
    ...(str(r.parentId) && { parent: str(r.parentId) }),
    source,
    ...(str(r.author) && { author: str(r.author) }),
    file,
    side: Array.isArray(r.newRange) || !Array.isArray(r.oldRange) ? "new" : "old",
    ...(line !== undefined && { line }),
    summary: clip(first.trim(), MAX_SUMMARY),
    ...(detail && { detail: clip(detail, MAX_DETAIL) }),
    ...(Number.isFinite(createdAt) && { createdAt }),
    ...(source === "user" && sent.has(id) && { sent: true }),
  };
}

export function toNotes(raw: unknown, sent: Set<string>): HunkNote[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_NOTES).flatMap((n) => toNote(n, sent) ?? []);
}

interface IndexRecord {
  entry: HunkIndexEntry;
  sent: Set<string>;
}

/** Reads the plugin's index, keyed by worktree path. A missing or unreadable file has no entries. */
export function parseIndex(text: string): Map<string, IndexRecord> {
  const out = new Map<string, IndexRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const value of Object.values(parsed)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const worktree = str(v.worktree);
    if (!worktree) continue;
    const entry: HunkIndexEntry = {
      worktree: trimSlash(worktree),
      ...(str(v.agentPaneId) && { agentPane: str(v.agentPaneId) }),
      ...(str(v.agentName) && { agentName: str(v.agentName) }),
      ...(str(v.paneId) && { pane: str(v.paneId) }),
    };
    const sent = new Set(Array.isArray(v.sent) ? v.sent.filter((s): s is string => typeof s === "string") : []);
    out.set(entry.worktree, { entry, sent });
  }
  return out;
}

function readIndex(): Map<string, IndexRecord> {
  try {
    return parseIndex(readFileSync(indexPath(), "utf8"));
  } catch {
    return new Map();
  }
}

interface RunResult {
  ok: boolean;
  out: string;
  err: string;
  missing?: boolean;
}

function runHunk(bin: string, args: string[]): RunResult {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: HUNK_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return { ok: false, out: "", err: code === "ETIMEDOUT" ? `timed out after ${HUNK_TIMEOUT_MS / 1000}s` : r.error.message, missing: code === "ENOENT" };
  }
  return { ok: r.status === 0, out: r.stdout, err: r.stderr.trim() };
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
const NO_SESSIONS = /no active hunk sessions/i;

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function hunkProbe(req: HunkRequest): HunkOutput {
  const bin = req.hunk ?? "hunk";
  const errors: string[] = [];
  const list = runHunk(bin, ["session", "list", "--json"]);
  if (list.missing) return { missing: true, sessions: [], index: [], errors: [] };
  if (!list.ok) {
    if (NO_SESSIONS.test(list.err)) return { sessions: [], index: [], errors };
    return { sessions: [], index: [], errors: [`hunk session list: ${firstLine(list.err) || "failed"}`] };
  }
  const parsed = parseJson(list.out);
  if (!parsed || !Array.isArray(parsed.sessions)) {
    return { sessions: [], index: [], errors: [`hunk session list printed something other than its JSON: ${list.out.slice(0, 120)}`] };
  }
  const index = readIndex();
  const sessions: HunkSession[] = [];
  const entries: HunkIndexEntry[] = [];
  for (const s of parsed.sessions as Record<string, unknown>[]) {
    const id = str(s?.sessionId);
    const repo = str(s?.repoRoot) ?? str(s?.cwd);
    if (!id || !repo) continue;
    const record = index.get(trimSlash(repo));
    const sent = record?.sent ?? new Set<string>();
    const state = (s.snapshot as { state?: Record<string, unknown> } | undefined)?.state;
    let notes: HunkNote[];
    if (Array.isArray(state?.reviewNotes)) notes = toNotes(state.reviewNotes, sent);
    else {
      const r = runHunk(bin, ["session", "comment", "list", id, "--type", "all", "--json"]);
      notes = r.ok ? toNotes(parseJson(r.out)?.comments, sent) : [];
      if (!r.ok) errors.push(`hunk session comment list: ${firstLine(r.err) || "failed"}`);
    }
    sessions.push({ id, repo: trimSlash(repo), ...(str(s.cwd) && { cwd: str(s.cwd) }), ...(str(s.title) && { title: str(s.title) }), notes });
    if (record && !entries.includes(record.entry)) entries.push(record.entry);
  }
  return { sessions, index: entries, errors };
}

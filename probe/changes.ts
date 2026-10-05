// Reads a repo's changed files and one file's diff for the preview's Changes tab. Runs where the
// agents run, bundled with the git probe, and imports only Node built-ins. Every git command
// here only reads: status runs without optional locks, so it never writes the index.
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { ChangedFile, ChangeScope, ChangesOutput, ChangesSummary, FileDiff, FileStatus } from "../shared/changes.ts";
import { firstLine, runTool } from "./git.ts";

export interface ChangesRequest {
  root: string;
  scope: ChangeScope;
  git?: string;
}

export interface DiffRequest extends ChangesRequest {
  /** An entry from this root and scope's summary. */
  file: ChangedFile;
  maxLines?: number;
  maxBytes?: number;
}

const CHANGES_TIMEOUT_MS = 10_000;
export const MAX_FILES = 1000;
export const MAX_DIFF_LINES = 2000;
export const MAX_DIFF_BYTES = 400 * 1024;
// Untracked files up to this size are read to count their lines, and diffed on expand.
const MAX_UNTRACKED_BYTES = 1024 * 1024;
// Like git, a NUL in the first 8000 bytes makes a file binary.
const BINARY_SNIFF_BYTES = 8000;
// Paths after `--` are matched literally, so a name with `*` or `:(` isn't read as a pattern.
const GIT_ARGS = ["--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false"];
// The user's config may turn on colors, external diff tools, or textconv filters.
const DIFF_ARGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

function runGit(req: ChangesRequest, args: string[]) {
  return runTool(req.git ?? "git", [...GIT_ARGS, ...args], req.root, CHANGES_TIMEOUT_MS);
}

export interface StatusEntries {
  branch?: string;
  oid?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Changed, staged, untracked, and unmerged entries. */
  dirty: number;
  untracked: string[];
}

/** The text after the first `n` space-separated fields of a status line. */
function afterFields(line: string, n: number): string {
  let i = 0;
  for (let k = 0; k < n; k++) i = line.indexOf(" ", i) + 1;
  return line.slice(i);
}

/** Parses `git status --porcelain=v2 -z --branch`; a rename entry's original path is its own NUL field. */
export function parseStatusZ(out: string): StatusEntries {
  const st: StatusEntries = { dirty: 0, untracked: [] };
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    if (f.startsWith("# ")) {
      const [key, ...rest] = f.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid" && value !== "(initial)") st.oid = value;
      else if (key === "branch.head" && value !== "(detached)") st.branch = value;
      else if (key === "branch.upstream") st.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    if (f[0] === "!") continue;
    st.dirty++;
    if (f[0] === "?") st.untracked.push(afterFields(f, 1));
    else if (f[0] === "2") i++;
  }
  return st;
}

export interface NameEntry {
  status: FileStatus;
  path: string;
  from?: string;
}

const STATUS_LETTER = new Map<string, FileStatus>([
  ["A", "A"],
  ["D", "D"],
  ["M", "M"],
  ["T", "M"],
  ["U", "U"],
]);

/** Parses `git diff --name-status -z`: a status field, then one path, or two for a rename or copy. */
export function parseNameStatusZ(out: string): NameEntry[] {
  const fields = out.split("\0");
  const entries: NameEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const [from, path] = [fields[i + 1], fields[i + 2]];
      i += 2;
      entries.push(letter === "R" ? { status: "R", path, from } : { status: "A", path });
    } else {
      entries.push({ status: STATUS_LETTER.get(letter) ?? "M", path: fields[++i] });
    }
  }
  return entries;
}

export interface NumstatEntry {
  path: string;
  from?: string;
  /** Unset for binary files, which numstat counts as `-`. */
  adds?: number;
  dels?: number;
}

/**
 * Parses `git diff --numstat -z`: `adds TAB dels TAB path NUL`, or for a rename an empty path
 * followed by the old and new paths as NUL fields.
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const fields = out.split("\0");
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const [a, d, ...rest] = f.split("\t");
    const counted = a !== "-" && d !== "-";
    const counts = counted ? { adds: Number(a), dels: Number(d) } : {};
    const path = rest.join("\t");
    if (path) entries.push({ path, ...counts });
    else {
      entries.push({ path: fields[i + 2], from: fields[i + 1], ...counts });
      i += 2;
    }
  }
  return entries;
}

function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

/** Line counts of an untracked file, as numstat would give them, without reading past the size limit. */
export function untrackedCounts(root: string, path: string): Pick<ChangedFile, "adds" | "dels" | "binary"> {
  try {
    const st = lstatSync(join(root, path));
    // A symlink's content is its target, one line.
    if (st.isSymbolicLink()) return { adds: 1, dels: 0 };
    if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) return {};
    const buf = readHead(join(root, path), st.size);
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { binary: true };
    let lines = 0;
    for (const b of buf) if (b === 10) lines++;
    if (buf.length && buf[buf.length - 1] !== 10) lines++;
    return { adds: lines, dels: 0 };
  } catch {
    return {};
  }
}

/** The ref named as the default branch: origin/HEAD's target, else origin/main, origin/master, main, or master. */
export function defaultBranch(req: ChangesRequest): string | undefined {
  const r = runGit(req, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (r.ok && r.out.trim()) return r.out.trim();
  for (const ref of ["origin/main", "origin/master", "main", "master"])
    if (runGit(req, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok) return ref;
  return undefined;
}

interface Base {
  /** What the working tree is compared with: a commit, or the empty tree before the first commit. */
  rev: string;
  ref?: string;
  commits?: number;
}

function resolveBase(req: ChangesRequest, oid: string | undefined): Base | { error: string } {
  if (req.scope === "uncommitted") {
    if (oid) return { rev: "HEAD" };
    const empty = runGit(req, ["hash-object", "-t", "tree", "/dev/null"]);
    return empty.ok ? { rev: empty.out.trim() } : { error: `git hash-object: ${firstLine(empty.err)}` };
  }
  if (!oid) return { error: "no commits yet" };
  const ref = defaultBranch(req);
  if (!ref) return { error: "no default branch to compare with (origin/HEAD, main, or master)" };
  const mb = runGit(req, ["merge-base", ref, "HEAD"]);
  if (!mb.ok) return { error: `no merge-base with ${ref}` };
  const rev = mb.out.trim();
  const count = runGit(req, ["rev-list", "--count", `${rev}..HEAD`]);
  return { rev, ref, ...(count.ok && { commits: Number(count.out.trim()) }) };
}

const NOT_A_REPO = /not a git repository|must be run in a work tree/i;

/** The files that differ in `req.scope`, with line counts, plus branch and upstream state. */
export function changesSummary(req: ChangesRequest): ChangesOutput {
  const s = runGit(req, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
  if (s.missing) return { error: `${req.git ?? "git"} is not installed or not on PATH` };
  if (!s.ok) return { error: NOT_A_REPO.test(s.err) ? "not a git repository" : `git status: ${firstLine(s.err)}` };
  const st = parseStatusZ(s.out);
  const base = resolveBase(req, st.oid);
  if ("error" in base) return { error: base.error };
  const names = runGit(req, ["diff", ...DIFF_ARGS, "--name-status", "-z", base.rev]);
  if (!names.ok) return { error: `git diff: ${firstLine(names.err)}` };
  const nums = runGit(req, ["diff", ...DIFF_ARGS, "--numstat", "-z", base.rev]);
  if (!nums.ok) return { error: `git diff --numstat: ${firstLine(nums.err)}` };
  const counts = new Map(parseNumstatZ(nums.out).map((n) => [n.path, n]));
  const files: ChangedFile[] = parseNameStatusZ(names.out).map((e) => {
    const n = counts.get(e.path);
    const counted = n?.adds !== undefined ? { adds: n.adds, dels: n.dels } : { binary: true };
    return { ...e, ...counted };
  });
  const tracked = new Set(files.map((f) => f.path));
  const untracked = st.untracked.flatMap((path): ChangedFile[] => (tracked.has(path) ? [] : [{ path, status: "?" }]));
  const all = [...files, ...untracked].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const listed = all.slice(0, MAX_FILES);
  for (const f of listed) if (f.status === "?") Object.assign(f, untrackedCounts(req.root, f.path));
  const summary: ChangesSummary = {
    root: req.root,
    scope: req.scope,
    ...(st.branch && { branch: st.branch }),
    ...(st.oid && { head: st.oid.slice(0, 7) }),
    ...(st.upstream && { upstream: st.upstream, ahead: st.ahead ?? 0, behind: st.behind ?? 0 }),
    ...(base.ref && { base: base.ref }),
    ...(base.commits !== undefined && { commits: base.commits }),
    files: listed,
    ...(all.length > MAX_FILES && { more: all.length - MAX_FILES }),
    adds: 0,
    dels: 0,
  };
  for (const f of all) {
    summary.adds += f.adds ?? 0;
    summary.dels += f.dels ?? 0;
  }
  return { summary };
}

/** Keeps whole lines of `text` within both limits. */
export function truncateDiff(text: string, maxLines = MAX_DIFF_LINES, maxBytes = MAX_DIFF_BYTES): { text: string; truncated: boolean } {
  let end = 0;
  let lines = 0;
  let bytes = 0;
  while (end < text.length && lines < maxLines) {
    const nl = text.indexOf("\n", end);
    const next = nl < 0 ? text.length : nl + 1;
    const size = Buffer.byteLength(text.slice(end, next));
    if (bytes + size > maxBytes) break;
    bytes += size;
    lines++;
    end = next;
  }
  return end >= text.length ? { text, truncated: false } : { text: text.slice(0, end), truncated: true };
}

const BINARY = /^Binary files .* differ$/m;

function finishDiff(req: DiffRequest, out: string, overflow = false): FileDiff {
  const { path } = req.file;
  if (BINARY.test(out) && !out.includes("\n@@")) return { path, binary: true, text: "" };
  const cut = truncateDiff(out, req.maxLines, req.maxBytes);
  return { path, text: cut.text, ...((cut.truncated || overflow) && { truncated: true }) };
}

/** One file's diff in `req.scope`. The file must come from the same root and scope's summary. */
export function changesDiff(req: DiffRequest): FileDiff {
  const { file } = req;
  if (file.binary) return { path: file.path, binary: true, text: "" };
  if (file.status === "?") {
    let size: number;
    try {
      const st = lstatSync(join(req.root, file.path));
      if (st.isDirectory()) return { path: file.path, text: "", note: "An untracked directory, such as a nested repository." };
      size = st.size;
    } catch {
      return { path: file.path, text: "", note: "The file is gone." };
    }
    if (size > MAX_UNTRACKED_BYTES) return { path: file.path, text: "", truncated: true, note: `The file is ${Math.round(size / 1024)} KB, too large to show.` };
    // --no-index exits with 1 when the files differ, which they always do here.
    const r = runGit(req, ["diff", "--no-index", ...DIFF_ARGS, "--", "/dev/null", file.path]);
    if (!r.ok && !r.out) return { path: file.path, text: "", error: `git diff: ${firstLine(r.err)}` };
    return finishDiff(req, r.out);
  }
  const s = runGit(req, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const base = resolveBase(req, s.ok ? s.out.trim() : undefined);
  if ("error" in base) return { path: file.path, text: "", error: base.error };
  const paths = file.from ? [file.from, file.path] : [file.path];
  const r = runGit(req, ["diff", ...DIFF_ARGS, base.rev, "--", ...paths]);
  if (!r.ok && !r.overflow) return { path: file.path, text: "", error: `git diff: ${firstLine(r.err)}` };
  return finishDiff(req, r.out, r.overflow);
}

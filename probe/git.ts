// Reads branch, changes, and the linked pull request of the repos agents work in. Runs where
// the agents run, like the usage probe, and imports only Node built-ins.
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import type { CheckSummary, PullRequest } from "../shared/git.ts";

export interface GitRequest {
  dirs: string[];
  /**
   * Repo roots whose PR the server looked up recently, with the `key` it was looked up at.
   * gh is skipped for a root while its key still matches.
   */
  fresh?: Record<string, string>;
  git?: string;
  gh?: string;
  /** No new gh lookups start after this long; the rest wait for the next run. */
  ghBudgetMs?: number;
}

export interface GitRepo {
  root: string;
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  dirty: number;
  /** Branch and HEAD, which a PR lookup is cached by. */
  key: string;
  /**
   * Set when this run has an answer: the PR, or null for none, including on the default
   * branch, on a detached HEAD, and when gh fails. Unset when gh was skipped.
   */
  pr?: PullRequest | null;
}

export interface GitOutput {
  /** Each directory's repo root, or null outside a repo. */
  roots: Record<string, string | null>;
  repos: GitRepo[];
  errors: string[];
}

const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 15_000;
const GH_BUDGET_MS = 20_000;
const PR_FIELDS = "number,title,url,state,isDraft,reviewDecision,statusCheckRollup";

export interface ToolResult {
  ok: boolean;
  out: string;
  err: string;
  missing?: boolean;
  /** Output passed the buffer limit; `out` has what was read before it. */
  overflow?: boolean;
}

export function runTool(cmd: string, args: string[], cwd: string, timeout: number): ToolResult {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
  });
  if (r.error) {
    // SAFETY: spawnSync sets `error` only for system errors, which carry a `code`.
    const code = (r.error as NodeJS.ErrnoException).code;
    const err = code === "ETIMEDOUT" ? `timed out after ${timeout / 1000}s` : r.error.message;
    return { ok: false, out: r.stdout ?? "", err, missing: code === "ENOENT", overflow: code === "ENOBUFS" };
  }
  return { ok: r.status === 0, out: r.stdout, err: r.stderr.trim() };
}

export const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface StatusInfo {
  branch?: string;
  oid?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  dirty: number;
}

/** Parses `git status --porcelain=v2 --branch`: header lines start with `#`, every other line is one entry. */
export function parseStatus(out: string): StatusInfo {
  const info: StatusInfo = { dirty: 0 };
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (!line.startsWith("# ")) {
      info.dirty++;
      continue;
    }
    const [key, ...rest] = line.slice(2).split(" ");
    const value = rest.join(" ");
    if (key === "branch.oid" && value !== "(initial)") info.oid = value;
    else if (key === "branch.head" && value !== "(detached)") info.branch = value;
    else if (key === "branch.upstream") info.upstream = value;
    else if (key === "branch.ab") {
      const m = /^\+(\d+) -(\d+)$/.exec(value);
      if (m) [info.ahead, info.behind] = [Number(m[1]), Number(m[2])];
    }
  }
  return info;
}

interface RollupItem {
  __typename?: string;
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  startedAt?: string;
}

// The same buckets as `gh pr checks`; anything else (queued, in progress, expected) is pending.
const FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const MAX_CHECK_NAMES = 5;

/** Sums up a PR's `statusCheckRollup`: check runs have a status and conclusion, commit statuses a state. */
export function summarizeChecks(items: RollupItem[]): CheckSummary {
  // A re-run check is listed once per run; the latest counts.
  const latest = new Map<string, RollupItem>();
  items.forEach((c, i) => {
    const name = c.name ?? c.context;
    const key = name ? `${c.workflowName ?? ""}/${name}` : String(i);
    const prev = latest.get(key);
    if (!prev || (c.startedAt ?? "") >= (prev.startedAt ?? "")) latest.set(key, c);
  });
  const sum: CheckSummary = { state: "none", passed: 0, failed: 0, pending: 0 };
  const failing: string[] = [];
  const pending: string[] = [];
  for (const c of latest.values()) {
    const state = (c.state ?? (c.status === "COMPLETED" ? c.conclusion : c.status) ?? "").toUpperCase();
    const name = c.name ?? c.context ?? "check";
    if (FAILING.has(state)) {
      sum.failed++;
      if (failing.length < MAX_CHECK_NAMES) failing.push(name);
    } else if (PASSING.has(state)) sum.passed++;
    else {
      sum.pending++;
      if (pending.length < MAX_CHECK_NAMES) pending.push(name);
    }
  }
  sum.state = sum.failed ? "fail" : sum.pending ? "pending" : sum.passed ? "pass" : "none";
  if (failing.length) sum.failing = failing;
  if (pending.length) sum.pendingNames = pending;
  return sum;
}

export function toPullRequest(raw: Record<string, unknown>): PullRequest {
  const state = String(raw.state ?? "").toLowerCase();
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    url: String(raw.url ?? ""),
    state: state === "merged" || state === "closed" ? state : "open",
    draft: raw.isDraft === true,
    ...(typeof raw.reviewDecision === "string" && raw.reviewDecision && { review: raw.reviewDecision }),
    checks: summarizeChecks(Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []),
  };
}

// gh's answers for a branch without a PR, or a repo it can't look PRs up for.
const NO_PR = /no (open )?pull requests? found|none of the git remotes|no git remotes|not a git repository/i;

export interface PrLookup {
  pr: PullRequest | null;
  error?: string;
}

/** The PR for the branch checked out in `root`. A missing, logged-out, or failing gh gives none, with an error. */
export function lookupPr(gh: string, root: string, timeoutMs = GH_TIMEOUT_MS): PrLookup {
  const r = runTool(gh, ["pr", "view", "--json", PR_FIELDS], root, timeoutMs);
  if (r.missing) return { pr: null, error: `${gh} is not installed or not on PATH` };
  if (!r.ok) return NO_PR.test(r.err) ? { pr: null } : { pr: null, error: `gh pr view: ${firstLine(r.err) || "failed"}` };
  try {
    return { pr: toPullRequest(JSON.parse(r.out)) };
  } catch {
    return { pr: null, error: `gh pr view printed something other than JSON: ${r.out.slice(0, 120)}` };
  }
}

function isDefaultBranch(git: string, root: string, branch: string): boolean {
  const r = runTool(git, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root, GIT_TIMEOUT_MS);
  const def = r.ok ? r.out.trim().replace(/^origin\//, "") : "";
  return def ? branch === def : branch === "main" || branch === "master";
}

export function gitProbe(req: GitRequest): GitOutput {
  const git = req.git ?? "git";
  const gh = req.gh ?? "gh";
  const deadline = Date.now() + (req.ghBudgetMs ?? GH_BUDGET_MS);
  const roots: Record<string, string | null> = {};
  const errors = new Set<string>();
  const found = new Set<string>();
  for (const dir of new Set(req.dirs)) {
    roots[dir] = null;
    if (!isDir(dir)) continue;
    const r = runTool(git, ["rev-parse", "--show-toplevel"], dir, GIT_TIMEOUT_MS);
    if (r.ok) {
      roots[dir] = r.out.trim();
      found.add(roots[dir]);
    } else if (r.missing) errors.add(`${git} is not installed or not on PATH`);
    else if (!/not a git repository|must be run in a work tree/i.test(r.err)) errors.add(`git rev-parse in ${dir}: ${firstLine(r.err)}`);
  }
  const repos: GitRepo[] = [];
  for (const root of found) {
    // Without optional locks, status doesn't write the index, so it can't block an agent's own git commands.
    const s = runTool(git, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], root, GIT_TIMEOUT_MS);
    if (!s.ok) {
      errors.add(`git status in ${root}: ${firstLine(s.err)}`);
      continue;
    }
    const { oid, ...st } = parseStatus(s.out);
    const repo: GitRepo = { root, ...st, ...(oid && { head: oid.slice(0, 7) }), key: `${st.branch ?? ""}@${oid ?? ""}` };
    if (!st.branch || isDefaultBranch(git, root, st.branch)) repo.pr = null;
    else if (req.fresh?.[root] !== repo.key && Date.now() < deadline) {
      const { pr, error } = lookupPr(gh, root);
      repo.pr = pr;
      if (error) errors.add(error);
    }
    repos.push(repo);
  }
  return { roots, repos, errors: [...errors] };
}

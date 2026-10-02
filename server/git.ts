import { readFileSync } from "node:fs";
import type { GitOutput, GitRepo, GitRequest } from "../probe/git.ts";
import { errorMessage } from "../shared/errors.ts";
import type { PullRequest, WorkspaceGit } from "../shared/git.ts";
import type { Fleet, Snapshot } from "../shared/model.ts";
import { bundleProbe, runScript, type ProbeOptions } from "./probe.ts";

const GIT_SOURCE = bundleProbe([readFileSync(new URL("../probe/git.ts", import.meta.url), "utf8")]);

/** The git probe source with a call that prints the result for `req`. */
export function gitScript(req: GitRequest): string {
  return `${GIT_SOURCE}\nprocess.stdout.write(JSON.stringify(gitProbe(${JSON.stringify(req)})));\n`;
}

export function runGitProbe(opts: ProbeOptions, req: GitRequest, timeoutMs = 60_000): Promise<GitOutput> {
  return runScript(opts, gitScript(req), timeoutMs);
}

/** Directories of each workspace's agent panes: where the agent process runs, or else the pane's cwd. */
export function workspaceDirs(snap: Snapshot | undefined): Map<string, string[]> {
  const agents = new Set(snap?.agents.map((a) => a.pane_id));
  const out = new Map<string, string[]>();
  for (const p of snap?.panes ?? []) {
    const dir = p.foreground_cwd || p.cwd;
    if (!agents.has(p.pane_id) || !dir) continue;
    out.set(p.workspace_id, [...(out.get(p.workspace_id) ?? []), dir]);
  }
  return out;
}

/** The repo root most of `dirs` are in; the first one seen wins a tie. */
export function pickRoot(dirs: string[], roots: Map<string, string | null>): string | undefined {
  const counts = new Map<string, number>();
  for (const d of dirs) {
    const root = roots.get(d);
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [root, n] of counts) if (!best || n > counts.get(best)!) best = root;
  return best;
}

/** Sets `git` on workspaces the probe has a repo for. */
export function markGit(fleet: Fleet, git: Map<string, WorkspaceGit>): Fleet {
  if (git.size === 0) return fleet;
  for (const g of fleet.groups) for (const ws of g.workspaces) if (git.has(ws.id)) ws.git = git.get(ws.id);
  return fleet;
}

export const GIT_INTERVAL_MS = 15_000;
// How often the loop checks whether a run is due, so a new agent's directory is read soon.
const TICK_MS = 1000;
export const PR_TTL_MS = 60_000;
// A merged or closed PR rarely changes while HEAD stays put.
export const DONE_PR_TTL_MS = 10 * 60_000;

const prTtl = (pr: PullRequest | null) => (pr && pr.state !== "open" ? DONE_PR_TTL_MS : PR_TTL_MS);

interface PrEntry {
  key: string;
  branch?: string;
  pr: PullRequest | null;
  at: number;
}

export interface GitWatcherOptions {
  probe: ProbeOptions;
  intervalMs?: number;
  /** Agent pane directories by workspace ID. */
  dirs: () => Map<string, string[]>;
  /** Called when any workspace's git state changes. */
  onChange: () => void;
  run?: (req: GitRequest) => Promise<GitOutput>;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * Runs the git probe every `intervalMs`, or sooner when an agent is in a directory the last
 * run didn't read. PR lookups are cached by repo root, branch, and HEAD: the probe skips gh
 * for a root while its entry is younger than `PR_TTL_MS` and HEAD hasn't moved.
 */
export function createGitWatcher(opts: GitWatcherOptions) {
  const intervalMs = opts.intervalMs ?? GIT_INTERVAL_MS;
  const run = opts.run ?? ((req: GitRequest) => runGitProbe(opts.probe, req));
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? Date.now;
  let roots = new Map<string, string | null>();
  let repos = new Map<string, GitRepo>();
  const prs = new Map<string, PrEntry>();
  const logged = new Set<string>();
  let tried = new Set<string>();
  let lastRun: number | undefined;
  let running = false;
  let last = "";

  function report(message: string) {
    if (logged.has(message)) return;
    logged.add(message);
    log(`git probe: ${message}`);
  }

  function fresh(t: number) {
    const out: Record<string, string> = {};
    for (const [root, e] of prs) if (t - e.at < prTtl(e.pr)) out[root] = e.key;
    return out;
  }

  function allDirs(byWorkspace: Map<string, string[]>): string[] {
    return [...new Set([...byWorkspace.values()].flat())];
  }

  function isDue(t: number): boolean {
    if (lastRun === undefined || t - lastRun >= intervalMs) return true;
    return allDirs(opts.dirs()).some((d) => !tried.has(d));
  }

  function workspaces(byWorkspace = opts.dirs()): Map<string, WorkspaceGit> {
    const out = new Map<string, WorkspaceGit>();
    for (const [ws, dirs] of byWorkspace) {
      const root = pickRoot(dirs, roots);
      const repo = root ? repos.get(root) : undefined;
      if (!repo) continue;
      const { key, pr: _, ...git } = repo;
      const e = prs.get(repo.root);
      // A lookup the probe skipped for lack of time still names the right PR while the branch is the same.
      const pr = e?.pr && repo.branch && e.branch === repo.branch ? e.pr : undefined;
      out.set(ws, pr ? { ...git, pr } : git);
    }
    return out;
  }

  async function round() {
    const byWorkspace = opts.dirs();
    const dirs = allDirs(byWorkspace);
    const t = now();
    lastRun = t;
    tried = new Set(dirs);
    if (dirs.length === 0) {
      roots = new Map();
      repos = new Map();
    } else {
      try {
        const out = await run({ dirs, fresh: fresh(t) });
        roots = new Map(Object.entries(out.roots));
        repos = new Map(out.repos.map((r) => [r.root, r]));
        for (const r of out.repos) if (r.pr !== undefined) prs.set(r.root, { key: r.key, branch: r.branch, pr: r.pr, at: t });
        for (const root of prs.keys()) if (!repos.has(root)) prs.delete(root);
        out.errors.forEach(report);
      } catch (err) {
        report(errorMessage(err));
      }
    }
    const next = JSON.stringify([...workspaces(byWorkspace)]);
    if (next !== last) {
      last = next;
      opts.onChange();
    }
  }

  /** Runs a round when one is due; never two at once. */
  async function tick() {
    if (running || !isDue(now())) return;
    running = true;
    try {
      await round();
    } finally {
      running = false;
    }
  }

  return {
    /** Starts the loop; the first run waits `delayMs` so the first snapshot is in. */
    start(delayMs = 1000) {
      const loop = () =>
        void tick()
          .catch((err: Error) => report(err.message))
          .finally(() => setTimeout(loop, TICK_MS));
      setTimeout(loop, delayMs);
    },
    tick,
    workspaces,
  };
}

import { readFileSync } from "node:fs";
import type { HunkOutput, HunkRequest } from "../probe/hunk.ts";
import { hunkCounts, type HunkNote, type HunkReview } from "../shared/hunk.ts";
import { fleetPanes, type Fleet, type Snapshot } from "../shared/model.ts";
import { bundleProbe, runScript, type ProbeOptions } from "./probe.ts";

const HUNK_SOURCE = bundleProbe([readFileSync(new URL("../probe/hunk.ts", import.meta.url), "utf8")]);

/** The hunk probe source with a call that prints the result for `req`. */
export function hunkScript(req: HunkRequest): string {
  return `${HUNK_SOURCE}\nprocess.stdout.write(JSON.stringify(hunkProbe(${JSON.stringify(req)})));\n`;
}

export function runHunkProbe(opts: ProbeOptions, req: HunkRequest, timeoutMs = 30_000): Promise<HunkOutput> {
  return runScript(opts, hunkScript(req), timeoutMs);
}

const inside = (dir: string, root: string) => dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Puts each live review on one workspace: the one with the review's hunk pane, else the one with
 * the agent the plugin sends it to, else the one whose worktree checkout is the repo, else the one
 * with the most panes inside the repo (agent panes first). A pane counts for the innermost repo
 * that contains it, so a worktree nested in its main checkout isn't matched to both.
 */
export function matchReviews(snap: Snapshot | undefined, out: HunkOutput | undefined): Map<string, HunkReview[]> {
  const byWs = new Map<string, HunkReview[]>();
  if (!snap || !out?.sessions.length) return byWs;
  const paneWs = new Map(snap.panes.map((p) => [p.pane_id, p.workspace_id]));
  const agents = new Set(snap.agents.map((a) => a.pane_id));
  const repos = [...new Set(out.sessions.map((s) => s.repo))].sort((a, b) => b.length - a.length);
  const owner = (dir: string | undefined) => (dir ? repos.find((r) => inside(dir, r)) : undefined);
  const dirs = (p: Snapshot["panes"][number]) => [...new Set([p.foreground_cwd, p.cwd].filter((d): d is string => !!d))];
  const order = new Map(snap.workspaces.map((w) => [w.workspace_id, w.number]));

  function byPanes(repo: string): string | undefined {
    const score = new Map<string, number>();
    for (const p of snap!.panes) {
      if (!dirs(p).some((d) => owner(d) === repo)) continue;
      score.set(p.workspace_id, (score.get(p.workspace_id) ?? 0) + (agents.has(p.pane_id) ? 100 : 1));
    }
    let best: string | undefined;
    for (const [ws, n] of score) {
      const b = best ? score.get(best)! : -1;
      if (n > b || (n === b && (order.get(ws) ?? 0) < (order.get(best!) ?? 0))) best = ws;
    }
    return best;
  }

  /** The only agent in `ws` working inside `repo`, for a review the plugin hasn't linked to one. */
  function soleAgent(ws: string, repo: string): string | undefined {
    const found = snap!.panes.filter((p) => p.workspace_id === ws && agents.has(p.pane_id) && dirs(p).some((d) => owner(d) === repo));
    return found.length === 1 ? found[0].pane_id : undefined;
  }

  for (const s of out.sessions) {
    const entry = out.index.find((e) => e.worktree === s.repo);
    const pane = entry?.pane && paneWs.has(entry.pane) ? entry.pane : undefined;
    const indexed = entry?.agentPane && agents.has(entry.agentPane) ? entry.agentPane : undefined;
    const ws =
      (pane && paneWs.get(pane)) ??
      (indexed && paneWs.get(indexed)) ??
      snap.workspaces.find((w) => w.worktree?.checkout_path === s.repo)?.workspace_id ??
      byPanes(s.repo);
    if (!ws) continue;
    const agent = indexed ?? soleAgent(ws, s.repo);
    const review: HunkReview = {
      session: s.id,
      repo: s.repo,
      ...(s.title && { title: s.title }),
      ...(pane && { pane }),
      ...(agent && { agent }),
      notes: s.notes,
    };
    byWs.set(ws, [...(byWs.get(ws) ?? []), review]);
  }
  return byWs;
}

/** Sets `hunk` on workspaces with live reviews and counts on the agents that own them. */
export function markHunk(fleet: Fleet, byWs: Map<string, HunkReview[]>): Fleet {
  if (byWs.size === 0) return fleet;
  const owned = new Map<string, HunkReview[]>();
  for (const g of fleet.groups)
    for (const ws of g.workspaces) {
      const reviews = byWs.get(ws.id);
      if (!reviews) continue;
      ws.hunk = reviews;
      for (const r of reviews) if (r.agent) owned.set(r.agent, [...(owned.get(r.agent) ?? []), r]);
    }
  for (const pane of fleetPanes(fleet)) {
    const reviews = owned.get(pane.id);
    if (reviews && pane.agent) pane.agent.hunk = hunkCounts(reviews);
  }
  return fleet;
}

/** Every review on the map. */
export function fleetReviews(fleet: Fleet | undefined): HunkReview[] {
  return (fleet?.groups ?? []).flatMap((g) => g.workspaces.flatMap((ws) => ws.hunk ?? []));
}

export const HUNK_INTERVAL_MS = 10_000;
// While hunk isn't installed where herdr runs, the probe only checks for it this often.
export const HUNK_MISSING_MS = 10 * 60_000;

export interface HunkWatcherOptions {
  probe: ProbeOptions;
  intervalMs?: number;
  /** Called when the sessions, their notes, or the plugin's records change. */
  onChange: () => void;
  run?: (req: HunkRequest) => Promise<HunkOutput>;
  log?: (line: string) => void;
}

/** Runs the hunk probe every `intervalMs`, one run at a time. Each distinct error is logged once. */
export function createHunkWatcher(opts: HunkWatcherOptions) {
  const intervalMs = opts.intervalMs ?? HUNK_INTERVAL_MS;
  const run = opts.run ?? ((req: HunkRequest) => runHunkProbe(opts.probe, req));
  const log = opts.log ?? ((line: string) => console.error(line));
  const logged = new Set<string>();
  let output: HunkOutput | undefined;
  let missing = false;
  let last = "";
  let running: Promise<void> | undefined;
  let again = false;
  let timer: NodeJS.Timeout | undefined;
  let started = false;

  function report(message: string) {
    if (logged.has(message)) return;
    logged.add(message);
    log(`hunk probe: ${message}`);
  }

  async function round(): Promise<number> {
    try {
      const out = await run({ ...(opts.probe.hunk && { hunk: opts.probe.hunk }) });
      out.errors.forEach(report);
      missing = !!out.missing;
      if (missing) report("hunk is not installed or not on PATH where herdr runs; review notes are off until it is");
      output = missing ? undefined : out;
    } catch (err) {
      report((err as Error).message);
    }
    const next = JSON.stringify(output ?? null);
    if (next !== last) {
      last = next;
      opts.onChange();
    }
    return missing ? HUNK_MISSING_MS : intervalMs;
  }

  function schedule(ms: number) {
    clearTimeout(timer);
    if (started) timer = setTimeout(() => void refresh(), ms);
  }

  /** Runs a round now, or right after the one in progress. */
  async function refresh(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let wait: number;
      do {
        again = false;
        wait = await round();
      } while (again);
      running = undefined;
      schedule(wait);
    })();
    return running;
  }

  return {
    /** Starts the loop; the first run waits `delayMs` so the first snapshot is in. */
    start(delayMs = 1000) {
      started = true;
      schedule(delayMs);
    },
    refresh,
    output: () => output,
  };
}

// hunk session IDs are UUIDs, and note IDs look like `user:1790808965938-1` or `mcp:<uuid>`.
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const NOTE_ID = /^[A-Za-z0-9:._-]{1,128}$/;
export const MAX_REPLY = 2000;
// Newlines and tabs are fine in a note; other control characters aren't.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function assertSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error("invalid hunk session id");
  return id;
}

export function assertNoteId(id: unknown): string {
  if (typeof id !== "string" || !NOTE_ID.test(id)) throw new Error("invalid hunk note id");
  return id;
}

export function assertReply(text: unknown): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t || t.length > MAX_REPLY || CONTROL.test(t)) throw new Error(`a reply must be 1-${MAX_REPLY} characters of text`);
  return t;
}

/**
 * Jumps the review to a note. hunk's `--comment` finds only notes added through its CLI, so
 * a note from its viewer is found by its file and line instead. Values go in `--opt=value`
 * form so one starting with `-` can't read as an option.
 */
export function navigateArgs(session: string, note: HunkNote): string[] {
  const base = ["session", "navigate", assertSessionId(session)];
  if (note.source === "agent" || note.line === undefined) return [...base, `--comment=${assertNoteId(note.id)}`, "--json"];
  return [...base, `--file=${note.file}`, `--${note.side === "old" ? "old" : "new"}-line=${note.line}`, "--json"];
}

export function replyArgs(session: string, noteId: string, text: string, author: string): string[] {
  return [
    "session",
    "comment",
    "add",
    assertSessionId(session),
    `--reply-to=${assertNoteId(noteId)}`,
    `--summary=${assertReply(text)}`,
    `--author=${author}`,
    "--json",
  ];
}

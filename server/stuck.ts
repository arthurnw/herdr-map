import { createHash } from "node:crypto";
import { fleetPanes, type Fleet, type FleetAgent } from "../shared/model.ts";
import { detectBanner, screenFingerprint } from "../shared/stuck.ts";
import { readPane, type HerdrOptions } from "./herdr.ts";

export type Stuck = NonNullable<FleetAgent["stuck"]>;

interface Seen {
  hash: string;
  changedAt: number;
  banner?: Stuck;
}

/** Remembers when each working agent's screen last changed and whether it shows a banner. */
export class StuckTracker {
  private seen = new Map<string, Seen>();
  private stuckMs: number;

  constructor(stuckMs: number) {
    this.stuckMs = stuckMs;
  }

  observe(paneId: string, screen: string, now: number) {
    const hash = createHash("sha1").update(screenFingerprint(screen)).digest("hex");
    const prev = this.seen.get(paneId);
    const reason = detectBanner(screen);
    const banner = reason ? (prev?.banner?.reason === reason ? prev.banner : { reason, since: now }) : undefined;
    const changedAt = prev && prev.hash === hash ? prev.changedAt : now;
    this.seen.set(paneId, { hash, changedAt, banner });
  }

  /** Forgets panes that are no longer working, so a later turn starts fresh. */
  retain(paneIds: Iterable<string>) {
    const keep = new Set(paneIds);
    for (const id of this.seen.keys()) if (!keep.has(id)) this.seen.delete(id);
  }

  /** Stuck panes as of `now`. A banner wins over a quiet screen. */
  stuck(now: number): Map<string, Stuck> {
    const out = new Map<string, Stuck>();
    for (const [id, s] of this.seen) {
      if (s.banner) out.set(id, s.banner);
      else if (now - s.changedAt >= this.stuckMs) out.set(id, { reason: "no-output", since: s.changedAt });
    }
    return out;
  }
}

/** Sets `stuck` on working agents in `fleet` that the watcher flagged. */
export function markStuck(fleet: Fleet, stuck: Map<string, Stuck>): Fleet {
  if (stuck.size === 0) return fleet;
  for (const pane of fleetPanes(fleet)) {
    const s = stuck.get(pane.id);
    if (s && pane.agent?.status === "working") pane.agent.stuck = s;
  }
  return fleet;
}

export function workingPanes(fleet: Fleet | undefined): string[] {
  return fleetPanes(fleet)
    .filter((p) => p.agent?.status === "working")
    .map((p) => p.id);
}

export interface StuckWatcherOptions {
  herdr: HerdrOptions;
  intervalMs: number;
  stuckMs: number;
  /** Pane IDs to check on each round. */
  panes: () => string[];
  /** Called when the set of stuck agents changes. */
  onChange: () => void;
}

/**
 * Reads the visible screen of each working agent every `intervalMs`, one read at a time.
 * Each read is a herdr call (about 0.2 s over SSH), so this runs far less often than the
 * snapshot poll and only for working agents.
 */
export function createStuckWatcher(opts: StuckWatcherOptions) {
  const tracker = new StuckTracker(opts.stuckMs);
  let current = new Map<string, Stuck>();
  let currentKey = "";

  async function round() {
    try {
      const ids = opts.panes();
      tracker.retain(ids);
      for (const id of ids) {
        try {
          tracker.observe(id, await readPane(opts.herdr, id, "visible", 200), Date.now());
        } catch {
          // The pane may have closed since the last snapshot; the next round drops it.
        }
      }
      const next = tracker.stuck(Date.now());
      const key = JSON.stringify([...next]);
      if (key !== currentKey) {
        current = next;
        currentKey = key;
        opts.onChange();
      }
    } finally {
      setTimeout(round, opts.intervalMs);
    }
  }

  setTimeout(round, opts.intervalMs);
  return { stuck: () => current };
}

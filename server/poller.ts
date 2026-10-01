import type { ServerResponse } from "node:http";
import { buildFleet, StatusClock, type Fleet, type Snapshot, type SnapPane } from "../shared/model.ts";
import { snapshot, type HerdrOptions } from "./herdr.ts";
import type { ReplyOutput } from "../probe/reply.ts";
import type { TranscriptOutput } from "../probe/subagents.ts";
import { agentPaneIds, createMemoryWatcher, markMemory } from "./memory.ts";
import { createUsageWatcher, markActivity, markUsage, sessionRefs, type ProbeOptions } from "./probe.ts";
import { createStuckWatcher, markStuck, workingPanes } from "./stuck.ts";
import { createGitWatcher, markGit, workspaceDirs } from "./git.ts";
import { createHunkWatcher, markHunk, matchReviews } from "./hunk.ts";

export interface State {
  fleet?: Fleet;
  error?: string;
  /** The usage probe's last error. Logged by the server, not shown as a banner. */
  probeError?: string;
  updatedAt?: number;
}

export interface Poller {
  state(): State;
  /** Polls herdr now and pushes any visible change to SSE clients. */
  poll(): Promise<void>;
  /** Open `/api/events` responses. */
  clients: Set<ServerResponse>;
  /** Clears a held `done` for a pane herdr-map just focused. */
  markSeen(paneId: string): void;
  /** The end of a subagent's transcript, read by the probe. */
  subagentTranscript(paneId: string, subagentId: string): Promise<TranscriptOutput>;
  /** The final reply of an agent's latest turn, read by the probe from its transcript. */
  lastReply(paneId: string): Promise<ReplyOutput>;
  /** Re-reads hunk's review sessions now, after herdr-map changed one. */
  refreshHunk(): Promise<void>;
  /** A pane as of the latest snapshot. */
  pane(paneId: string): SnapPane | undefined;
}

// Screen reads for stuck detection cost a herdr call per working agent, so they run
// once every this many snapshot polls.
const STUCK_POLLS = 10;

// Transcript reads run on their own slower loop; see server/probe.ts.
const PROBE_INTERVAL_MS = 5000;
// Memory figures move slowly, and each run asks herdr once per agent pane.
const MEMORY_INTERVAL_MS = 15_000;

export function createPoller(herdr: HerdrOptions, intervalMs: number, stuckMs: number, probe?: ProbeOptions): Poller {
  const clock = new StatusClock();
  const clients = new Set<ServerResponse>();
  let state: State = {};
  let snap: Snapshot | undefined;
  let lastPayload = "";
  let pollTimer: NodeJS.Timeout | undefined;
  let polling = false;
  let pollAgain = false;

  function broadcast(payload: string) {
    for (const res of clients) res.write(`data: ${payload}\n\n`);
  }

  async function poll(): Promise<void> {
    // A focus request asks for an immediate poll; never run two at once.
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    clearTimeout(pollTimer);
    try {
      snap = await snapshot(herdr);
      const now = Date.now();
      const fleet = buildFleet(snap, clock.observe(snap.agents, now, snap.focused_pane_id));
      state = { fleet: markStuck(fleet, watcher.stuck()), updatedAt: now };
      if (usage) state = { ...state, fleet: markActivity(markUsage(state.fleet!, usage.usage()), usage.activity()), probeError: usage.error() };
      if (memory) state = { ...state, fleet: markMemory(state.fleet!, memory.memory()) };
      if (git) state = { ...state, fleet: markGit(state.fleet!, git.workspaces(workspaceDirs(snap))) };
      if (hunk) state = { ...state, fleet: markHunk(state.fleet!, matchReviews(snap, hunk.output())) };
    } catch (err) {
      state = { ...state, error: (err as Error).message };
    }
    const { updatedAt, ...rest } = state;
    const payload = JSON.stringify(rest);
    // Only push when something visible changed; clients age timestamps locally.
    if (payload !== lastPayload) {
      lastPayload = payload;
      broadcast(JSON.stringify(state));
    }
    polling = false;
    if (pollAgain) {
      pollAgain = false;
      return poll();
    }
    pollTimer = setTimeout(poll, intervalMs);
  }

  const watcher = createStuckWatcher({
    herdr,
    intervalMs: intervalMs * STUCK_POLLS,
    stuckMs,
    panes: () => workingPanes(state.fleet),
    onChange: () => void poll(),
  });

  const usage =
    probe &&
    createUsageWatcher({ probe, intervalMs: PROBE_INTERVAL_MS, refs: () => sessionRefs(snap, state.fleet), onChange: () => void poll() });
  usage?.start();

  const memory =
    probe &&
    createMemoryWatcher({ probe, intervalMs: MEMORY_INTERVAL_MS, panes: () => agentPaneIds(state.fleet), onChange: () => void poll() });
  memory?.start();
  // Branch, changes, and PRs, on their own slower loop; see server/git.ts.
  const git = probe && createGitWatcher({ probe, dirs: () => workspaceDirs(snap), onChange: () => void poll() });
  git?.start();
  // hunk review sessions and their notes, on their own slower loop; see server/hunk.ts.
  const hunk = probe && createHunkWatcher({ probe, onChange: () => void poll() });
  hunk?.start();

  // SSE proxies and browsers drop idle streams; a comment line keeps them open.
  setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 20_000);

  return {
    state: () => state,
    poll,
    clients,
    markSeen: (paneId) => clock.markSeen(paneId),
    subagentTranscript: (paneId, id) => (usage ? usage.transcript(paneId, id) : Promise.reject(new Error("the usage probe is off"))),
    lastReply: async (paneId) => (usage ? usage.reply(paneId) : { error: "the usage probe is off" }),
    refreshHunk: async () => {
      await hunk?.refresh();
    },
    pane: (paneId) => snap?.panes.find((p) => p.pane_id === paneId),
  };
}

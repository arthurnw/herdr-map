import type { ServerResponse } from "node:http";
import { buildFleet, StatusClock, type Fleet } from "../shared/model.ts";
import { snapshot, type HerdrOptions } from "./herdr.ts";

export interface State {
  fleet?: Fleet;
  error?: string;
  updatedAt?: number;
}

export interface Poller {
  state(): State;
  /** Polls herdr now and pushes any visible change to SSE clients. */
  poll(): Promise<void>;
  /** Open `/api/events` responses. */
  clients: Set<ServerResponse>;
}

export function createPoller(herdr: HerdrOptions, intervalMs: number): Poller {
  const clock = new StatusClock();
  const clients = new Set<ServerResponse>();
  let state: State = {};
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
      const snap = await snapshot(herdr);
      const now = Date.now();
      state = { fleet: buildFleet(snap, clock.observe(snap.agents, now)), updatedAt: now };
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

  // SSE proxies and browsers drop idle streams; a comment line keeps them open.
  setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 20_000);

  return { state: () => state, poll, clients };
}

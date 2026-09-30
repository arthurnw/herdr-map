import { fleetPanes, type AgentMemory, type Fleet, type FleetMemory } from "../shared/model.ts";
import type { MemoryInput, MemoryOutput } from "../probe/memory.ts";
import { readMemory, type ProbeOptions } from "./probe.ts";

export interface MemoryState {
  panes: Map<string, AgentMemory>;
  total?: FleetMemory;
}

/** Agent panes in the fleet, which the memory probe measures. */
export function agentPaneIds(fleet: Fleet | undefined): string[] {
  return fleetPanes(fleet).flatMap((p) => (p.agent ? [p.id] : []));
}

/** Sets `memory` on agents the probe measured, and the fleet's total. */
export function markMemory(fleet: Fleet, memory: MemoryState): Fleet {
  if (memory.panes.size === 0) return fleet;
  for (const pane of fleetPanes(fleet)) {
    const m = memory.panes.get(pane.id);
    if (m && pane.agent) pane.agent.memory = m;
  }
  if (memory.total) fleet.memory = memory.total;
  return fleet;
}

export interface MemoryWatcherOptions {
  probe: ProbeOptions;
  intervalMs: number;
  panes: () => string[];
  /** Called when any figure changes. */
  onChange: () => void;
  run?: (input: MemoryInput) => Promise<MemoryOutput>;
  log?: (line: string) => void;
}

/** Runs the memory probe every `intervalMs`, one run at a time, apart from the usage probe's loop. */
export function createMemoryWatcher(opts: MemoryWatcherOptions) {
  const run = opts.run ?? ((input: MemoryInput) => readMemory(opts.probe, input));
  const log = opts.log ?? ((line: string) => console.error(line));
  let state: MemoryState = { panes: new Map() };
  let lastError: string | undefined;
  // Each distinct message is logged once; a clean run clears them so a recurrence shows again.
  const logged = new Set<string>();
  const logOnce = (line: string) => {
    if (logged.has(line)) return;
    logged.add(line);
    log(line);
  };

  async function round() {
    const panes = opts.panes();
    if (panes.length === 0) {
      if (state.panes.size === 0) return;
      state = { panes: new Map() };
      opts.onChange();
      return;
    }
    let next: MemoryState;
    try {
      const out = await run({ panes, ...(opts.probe.herdr && { herdr: opts.probe.herdr }) });
      if (out.error) throw new Error(out.error);
      for (const e of out.errors ?? []) logOnce(`memory probe: ${e.pane}: ${e.error}`);
      if (!out.errors?.length) logged.clear();
      lastError = undefined;
      next = {
        panes: new Map(out.panes.map(({ pane, ...m }) => [pane, m])),
        total: { bytes: out.totalBytes, agents: out.panes.length, ...(out.machineBytes && { machineBytes: out.machineBytes }) },
      };
    } catch (err) {
      // The last figures stay up until a run succeeds again.
      lastError = (err as Error).message;
      logOnce(`memory probe: ${lastError}`);
      return;
    }
    const changed = JSON.stringify([...next.panes, next.total]) !== JSON.stringify([...state.panes, state.total]);
    state = next;
    if (changed) opts.onChange();
  }

  async function loop() {
    try {
      await round();
    } finally {
      setTimeout(loop, opts.intervalMs);
    }
  }

  return {
    /** Starts the loop; the first run waits `delayMs` so the first snapshot is in. */
    start(delayMs = 1000) {
      setTimeout(loop, delayMs);
    },
    round,
    memory: () => state,
    error: () => lastError,
  };
}

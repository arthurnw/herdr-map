import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fleetPanes, type AgentStatus, type AgentUsage, type Fleet, type Snapshot } from "../shared/model.ts";
import type { Cursor, ProbeInput, ProbeOutput, ProbeRef, Usage } from "../probe/usage.ts";
import { commandFor } from "./herdr.ts";

export interface ProbeOptions {
  /** SSH destination where the agents run. Unset runs the probe locally. */
  ssh?: string;
  /** Node executable on that machine. */
  node: string;
  /** herdr executable on that machine, which the probe asks for Claude Code panes' processes. */
  herdr?: string;
}

const PROBE_SOURCE = readFileSync(new URL("../probe/usage.ts", import.meta.url), "utf8");

/** The probe reads its script from stdin, so nothing has to be installed on the remote. */
export function probeCommand(opts: ProbeOptions): [string, string[]] {
  return commandFor({ ssh: opts.ssh, bin: opts.node }, ["--input-type=module-typescript", "-"]);
}

/** The probe source with a call that prints the result for `input`. */
export function probeScript(input: ProbeInput): string {
  return `${PROBE_SOURCE}\nprocess.stdout.write(JSON.stringify(probe(${JSON.stringify(input)})));\n`;
}

export function runProbe(opts: ProbeOptions, input: ProbeInput, timeoutMs = 20_000): Promise<ProbeOutput> {
  const [cmd, argv] = probeCommand(opts);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`probe timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const lines = err.trim().split("\n");
        reject(new Error(`${cmd} exited with ${code}: ${lines.find((l) => /Error/.test(l)) ?? lines.at(-1) ?? ""}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as ProbeOutput);
      } catch {
        reject(new Error(`probe printed something other than JSON: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(probeScript(input));
  });
}

/** An agent pane whose session herdr knows. */
export interface SessionRef {
  pane: string;
  kind: string;
  sessionKind: string;
  session: string;
  cwd?: string;
  status: AgentStatus;
  since: number;
}

export function sessionRefs(snap: Snapshot | undefined, fleet: Fleet | undefined): SessionRef[] {
  const agents = new Map(fleetPanes(fleet).flatMap((p) => (p.agent ? [[p.id, p.agent] as const] : [])));
  const refs: SessionRef[] = [];
  for (const p of snap?.panes ?? []) {
    const agent = agents.get(p.pane_id);
    const s = p.agent_session;
    if (!agent || !s?.value) continue;
    refs.push({ pane: p.pane_id, kind: agent.kind, sessionKind: s.kind, session: s.value, cwd: p.cwd, status: agent.status, since: agent.since });
  }
  return refs;
}

/** Sets `usage` on agents the probe has numbers for. */
export function markUsage(fleet: Fleet, usage: Map<string, AgentUsage>): Fleet {
  if (usage.size === 0) return fleet;
  for (const pane of fleetPanes(fleet)) {
    const u = usage.get(pane.id);
    if (u && pane.agent) pane.agent.usage = u;
  }
  return fleet;
}

interface Entry {
  session: string;
  cursor?: Cursor;
  usage?: AgentUsage;
  triedAt?: number;
  error?: string;
}

// An agent is read while it works and for this long after its status last changed, which
// covers the end of a turn. Idle agents are read once, so their numbers show at startup.
export const RECENT_MS = 60_000;
// A transcript that couldn't be found is looked for again this often while its agent is idle.
export const RETRY_MS = 60_000;
// An idle Claude Code agent's session can move to another transcript without its status
// changing, so it's sent this often for the probe's own once-a-minute re-check. The probe
// reads nothing when the transcript hasn't grown.
export const CLAUDE_IDLE_MS = 60_000;

export function isDue(ref: SessionRef, entry: Entry | undefined, now: number): boolean {
  if (!entry?.triedAt) return true;
  if (ref.status === "working" || ref.status === "blocked") return true;
  if (now - ref.since < RECENT_MS) return true;
  if (ref.kind === "claude" && ref.sessionKind === "id" && now - entry.triedAt >= CLAUDE_IDLE_MS) return true;
  return !!entry.error && now - entry.triedAt >= RETRY_MS;
}

function sameUsage(a: AgentUsage | undefined, b: Usage): boolean {
  return !!a && a.model === b.model && a.contextTokens === b.contextTokens && a.contextWindow === b.contextWindow && a.costUsd === b.costUsd;
}

export interface UsageWatcherOptions {
  probe: ProbeOptions;
  intervalMs: number;
  refs: () => SessionRef[];
  /** Called when any agent's numbers, or the probe's error, change. */
  onChange: () => void;
  run?: (input: ProbeInput) => Promise<ProbeOutput>;
  log?: (line: string) => void;
}

/**
 * Runs the probe every `intervalMs`, one run at a time, for agents that are working or
 * changed status recently. Cursors round-trip through each run, so the probe keeps no
 * state on the remote and reads only bytes added since the last run.
 */
export function createUsageWatcher(opts: UsageWatcherOptions) {
  const run = opts.run ?? ((input: ProbeInput) => runProbe(opts.probe, input));
  const log = opts.log ?? ((line: string) => console.error(line));
  const entries = new Map<string, Entry>();
  let lastError: string | undefined;

  async function round() {
    let changed = false;
    const refs = opts.refs();
    const live = new Map(refs.map((r) => [r.pane, r]));
    for (const [pane, e] of entries) {
      if (live.get(pane)?.session !== e.session) {
        entries.delete(pane);
        changed ||= !!e.usage;
      }
    }
    const now = Date.now();
    const due = refs
      .filter((r) => isDue(r, entries.get(r.pane), now))
      // Working agents first, so they get the byte budget when many transcripts are behind.
      .sort((a, b) => Number(b.status === "working") - Number(a.status === "working"));
    if (due.length > 0) {
      const input: ProbeInput = {
        refs: due.map((r): ProbeRef => ({
          pane: r.pane,
          kind: r.kind,
          sessionKind: r.sessionKind,
          session: r.session,
          cwd: r.cwd,
          status: r.status,
          cursor: entries.get(r.pane)?.cursor,
        })),
        ...(opts.probe.herdr && { herdr: opts.probe.herdr }),
      };
      try {
        const out = await run(input);
        if (lastError) changed = true;
        lastError = undefined;
        for (const res of out.results) {
          const ref = live.get(res.pane);
          if (!ref) continue;
          const e = entries.get(res.pane) ?? { session: ref.session };
          e.triedAt = now;
          if (res.error && res.error !== e.error) log(`usage probe: ${res.pane} (${ref.kind}): ${res.error}`);
          e.error = res.error;
          if (res.cursor) e.cursor = res.cursor;
          if (res.usage && !sameUsage(e.usage, res.usage)) {
            e.usage = { ...res.usage, updatedAt: Date.now() };
            changed = true;
          }
          entries.set(res.pane, e);
        }
      } catch (err) {
        const message = (err as Error).message;
        if (message !== lastError) {
          log(`usage probe: ${message}`);
          changed = true;
        }
        lastError = message;
      }
    }
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
    usage(): Map<string, AgentUsage> {
      const out = new Map<string, AgentUsage>();
      for (const [pane, e] of entries) if (e.usage) out.set(pane, e.usage);
      return out;
    },
    error: () => lastError,
  };
}

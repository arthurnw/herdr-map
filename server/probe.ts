import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { errorMessage } from "../shared/errors.ts";
import { fleetPanes, type AgentStatus, type AgentUsage, type Fleet, type FleetAgent, type Snapshot } from "../shared/model.ts";
import type { MemoryInput, MemoryOutput } from "../probe/memory.ts";
import type { HistoryOutput, ReplyOutput, ReplyRequest } from "../probe/reply.ts";
import type { Activity, Subagent, TranscriptOutput, TranscriptRequest } from "../probe/subagents.ts";
import type { Cursor, ProbeInput, ProbeOutput, ProbeRef, Usage } from "../probe/usage.ts";
import { commandFor } from "./herdr.ts";

export interface ProbeOptions {
  /** SSH destination where the agents run. Unset runs the probe locally. */
  ssh?: string;
  /** Node executable on that machine. */
  node: string;
  /** herdr executable on that machine, which the probe asks for Claude Code panes' processes. */
  herdr?: string;
  /** hunk executable on that machine, which the hunk probe lists review sessions with. */
  hunk?: string;
}

const IMPORT = /^import (type )?\{([^}]*)\} from "([^"]+)";(\n|$)/gm;

/**
 * Joins probe modules into one script. Imports between them are dropped, and imports of Node
 * built-ins are merged so no name is imported twice. Only named imports are supported.
 */
export function bundleProbe(sources: string[]): string {
  const builtins = new Map<string, Set<string>>();
  const bodies = sources.map((src) => {
    const body = src.replace(IMPORT, (_, typeOnly: string | undefined, names: string, from: string) => {
      if (from.startsWith("./") || typeOnly) return "";
      if (!from.startsWith("node:")) throw new Error(`the probe can only import Node built-ins, not ${from}`);
      const set = builtins.get(from) ?? new Set();
      for (const n of names.split(",").map((x) => x.trim())) if (n && !n.startsWith("type ")) set.add(n);
      builtins.set(from, set);
      return "";
    });
    const other = /^import .*$/m.exec(body);
    if (other) throw new Error(`unsupported probe import: ${other[0]}`);
    return body;
  });
  const imports = [...builtins].map(([from, names]) => `import { ${[...names].join(", ")} } from "${from}";`);
  return [...imports, ...bodies].join("\n");
}

const PROBE_SOURCE = bundleProbe(["../probe/usage.ts", "../probe/subagents.ts", "../probe/reply.ts", "../probe/memory.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")));

/** The probe reads its script from stdin, so nothing has to be installed on the remote. */
export function probeCommand(opts: ProbeOptions): [string, string[]] {
  return commandFor({ ssh: opts.ssh, bin: opts.node }, ["--input-type=module-typescript", "-"]);
}

/** The probe source with a call that prints the result for `input`. */
export function probeScript(input: ProbeInput): string {
  return `${PROBE_SOURCE}\nprocess.stdout.write(JSON.stringify(probe(${JSON.stringify(input)})));\n`;
}

/** The probe source with a call that prints the end of a subagent's transcript as text. */
export function transcriptScript(req: TranscriptRequest): string {
  return `${PROBE_SOURCE}\nprocess.stdout.write(JSON.stringify(subagentTranscript(${JSON.stringify(req)})));\n`;
}

/** The probe source with a call that prints the final reply of an agent's latest turn. */
export function replyScript(req: ReplyRequest): string {
  return `${PROBE_SOURCE}\nprocess.stdout.write(JSON.stringify(finalReply(${JSON.stringify(req)})));\n`;
}

/** The probe source with a call that prints the end of an agent's conversation as text. */
export function historyScript(req: ReplyRequest): string {
  return `${PROBE_SOURCE}\nprocess.stdout.write(JSON.stringify(agentHistory(${JSON.stringify(req)})));\n`;
}

/** The probe source with a call that prints the memory use of agent panes' process trees. */
export function memoryScript(input: MemoryInput): string {
  return `${PROBE_SOURCE}\nprocess.stdout.write(JSON.stringify(memoryUse(${JSON.stringify(input)})));\n`;
}

export function runScript<T>(opts: ProbeOptions, script: string, timeoutMs: number): Promise<T> {
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
        const why = lines.find((l) => /Error/.test(l)) ?? lines.at(-1) ?? "";
        // ssh exits 255 when the connection fails, often silently when the laptop wakes from sleep.
        const hint = !why && opts.ssh && code === 255 ? `couldn't connect to ${opts.ssh}` : why;
        reject(new Error(`${cmd} exited with ${code}: ${hint}`));
        return;
      }
      try {
        // SAFETY: the script prints the JSON of the probe call's result, a T.
        resolve(JSON.parse(out) as T);
      } catch {
        reject(new Error(`probe printed something other than JSON: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(script);
  });
}

export function runProbe(opts: ProbeOptions, input: ProbeInput, timeoutMs = 20_000): Promise<ProbeOutput> {
  return runScript(opts, probeScript(input), timeoutMs);
}

export function readTranscript(opts: ProbeOptions, req: TranscriptRequest, timeoutMs = 10_000): Promise<TranscriptOutput> {
  return runScript(opts, transcriptScript(req), timeoutMs);
}

export function readReply(opts: ProbeOptions, req: ReplyRequest, timeoutMs = 10_000): Promise<ReplyOutput> {
  return runScript(opts, replyScript(req), timeoutMs);
}

export function readHistory(opts: ProbeOptions, req: ReplyRequest, timeoutMs = 10_000): Promise<HistoryOutput> {
  return runScript(opts, historyScript(req), timeoutMs);
}

export function readMemory(opts: ProbeOptions, input: MemoryInput, timeoutMs = 20_000): Promise<MemoryOutput> {
  return runScript(opts, memoryScript(input), timeoutMs);
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

/** Sets subagents, reviews, and task progress on agents the probe found them for. */
export function markActivity(fleet: Fleet, activity: Map<string, Activity>): Fleet {
  if (activity.size === 0) return fleet;
  for (const pane of fleetPanes(fleet)) {
    const a = activity.get(pane.id);
    if (a && pane.agent) Object.assign(pane.agent, fleetActivity(a));
  }
  return fleet;
}

/** The probe's activity as the browser gets it: transcript paths stay on the server. */
function fleetActivity(a: Activity): Pick<FleetAgent, "subagents" | "reviews" | "tasks"> {
  const out: Pick<FleetAgent, "subagents" | "reviews" | "tasks"> = {};
  if (a.subagents?.length) out.subagents = a.subagents.map(({ path, fromOrdinal, ...s }) => ({ ...s, ...(path && { transcript: true }) }));
  if (a.reviews) out.reviews = a.reviews;
  if (a.tasks) out.tasks = a.tasks;
  return out;
}

interface Entry {
  session: string;
  kind?: string;
  cursor?: Cursor;
  usage?: AgentUsage;
  activity?: Activity;
  triedAt?: number;
  error?: string;
}

const NO_SESSION = "herdr reports no session for this agent";

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
  // Background subagents keep working after their parent's turn ends.
  if (entry.activity?.subagents?.some((s) => s.status === "running")) return true;
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
  read?: (req: TranscriptRequest) => Promise<TranscriptOutput>;
  reply?: (req: ReplyRequest) => Promise<ReplyOutput>;
  history?: (req: ReplyRequest) => Promise<HistoryOutput>;
  log?: (line: string) => void;
}

/**
 * Runs the probe every `intervalMs`, one run at a time, for agents that are working or
 * changed status recently. Cursors round-trip through each run, so the probe keeps no
 * state on the remote and reads only bytes added since the last run.
 */
export function createUsageWatcher(opts: UsageWatcherOptions) {
  const run = opts.run ?? ((input: ProbeInput) => runProbe(opts.probe, input));
  const read = opts.read ?? ((req: TranscriptRequest) => readTranscript(opts.probe, req));
  const reply = opts.reply ?? ((req: ReplyRequest) => readReply(opts.probe, req));
  const history = opts.history ?? ((req: ReplyRequest) => readHistory(opts.probe, req));
  const log = opts.log ?? ((line: string) => console.error(line));
  const entries = new Map<string, Entry>();
  let lastError: string | undefined;

  /** Sessions of Claude Code panes other than `sent`, so the probe doesn't match another pane's screen to them. */
  function claimedBy(refs: SessionRef[], sent: Set<string>): string[] | undefined {
    const claimed = refs
      .filter((r) => r.kind === "claude" && !sent.has(r.pane))
      .flatMap((r) => [r.session, entries.get(r.pane)?.cursor?.claude?.session ?? r.session]);
    return claimed.length > 0 ? [...new Set(claimed)] : undefined;
  }

  function probeRef(r: SessionRef): ProbeRef {
    return { pane: r.pane, kind: r.kind, sessionKind: r.sessionKind, session: r.session, cwd: r.cwd, status: r.status, cursor: entries.get(r.pane)?.cursor };
  }

  function transcriptRequest(pane: string): ReplyRequest | undefined {
    const refs = opts.refs();
    const ref = refs.find((r) => r.pane === pane);
    if (!ref) return undefined;
    const e = entries.get(pane);
    const path = e?.session === ref.session ? e.cursor?.path : undefined;
    const claimed = path ? undefined : claimedBy(refs, new Set([pane]));
    return {
      ref: probeRef(ref),
      ...(path && { path }),
      ...(opts.probe.herdr && { herdr: opts.probe.herdr }),
      ...(claimed && { claimed }),
    };
  }

  async function round() {
    let changed = false;
    const refs = opts.refs();
    const live = new Map(refs.map((r) => [r.pane, r]));
    for (const [pane, e] of entries) {
      if (live.get(pane)?.session !== e.session) {
        entries.delete(pane);
        changed ||= !!e.usage || !!e.activity;
      }
    }
    const now = Date.now();
    const due = refs
      .filter((r) => isDue(r, entries.get(r.pane), now))
      // Working agents first, so they get the byte budget when many transcripts are behind.
      .sort((a, b) => Number(b.status === "working") - Number(a.status === "working"));
    if (due.length > 0) {
      const claimed = claimedBy(refs, new Set(due.map((r) => r.pane)));
      const input: ProbeInput = {
        refs: due.map(probeRef),
        ...(opts.probe.herdr && { herdr: opts.probe.herdr }),
        ...(claimed && { claimed }),
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
          if (!res.error) {
            const { subagents, reviews, tasks } = res;
            const next: Activity | undefined = subagents?.length || reviews || tasks ? { subagents, reviews, tasks } : undefined;
            if (JSON.stringify(next) !== JSON.stringify(e.activity)) changed = true;
            e.activity = next;
            e.kind = ref.kind;
          }
          entries.set(res.pane, e);
        }
      } catch (err) {
        const message = errorMessage(err);
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
    activity(): Map<string, Activity> {
      const out = new Map<string, Activity>();
      for (const [pane, e] of entries) if (e.activity) out.set(pane, e.activity);
      return out;
    },
    /** The end of a subagent's transcript as text. Only transcripts the probe reported can be read. */
    async transcript(pane: string, id: string): Promise<TranscriptOutput> {
      const e = entries.get(pane);
      const s: Subagent | undefined = e?.activity?.subagents?.find((x) => x.id === id);
      if (!e?.kind || !s) throw new Error("no such subagent");
      if (!s.path) throw new Error("this subagent has no transcript");
      return read({ path: s.path, kind: e.kind, ...(s.fromOrdinal !== undefined && { fromOrdinal: s.fromOrdinal }) });
    },
    /**
     * The final reply of a pane's latest turn, from the transcript the probe last read for it,
     * or looked up as a probe run would when there's none yet.
     */
    async reply(pane: string): Promise<ReplyOutput> {
      const req = transcriptRequest(pane);
      return req ? reply(req) : { error: NO_SESSION };
    },
    /** The end of a pane's conversation as text, from the same transcript as `reply`. */
    async history(pane: string): Promise<HistoryOutput> {
      const req = transcriptRequest(pane);
      return req ? history(req) : { error: NO_SESSION };
    },
    error: () => lastError,
  };
}

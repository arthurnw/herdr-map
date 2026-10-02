// Memory use of each agent pane's process tree, from one `ps` call and herdr's process-info
// on the machine where the agents run. Joined to probe/usage.ts like the other probe files,
// so every top-level name here shares one scope with theirs.
import { execFileSync } from "node:child_process";
import { totalmem } from "node:os";
import { errorMessage, herdrCaller, herdrProcessInfo, type PaneProcess, type ProcessInfo } from "./usage.ts";

export interface MemoryInput {
  /** Agent pane IDs. */
  panes: string[];
  /** herdr executable on the probe's machine. */
  herdr?: string;
  /** How many commands to list per pane. */
  top?: number;
}

export interface MemoryProc {
  pid: number;
  ppid: number;
  /** Resident set size in bytes. */
  bytes: number;
  /** Command basename. */
  name: string;
}

export interface MemoryTop {
  name: string;
  bytes: number;
  /** Processes with this name in the tree. */
  count: number;
}

export interface PaneMemory {
  pane: string;
  bytes: number;
  processes: number;
  /** The heaviest commands in the tree, heaviest first. */
  top: MemoryTop[];
}

export interface MemoryOutput {
  panes: PaneMemory[];
  /** Panes that couldn't be measured, with why. */
  errors?: { pane: string; error: string }[];
  /** Resident memory across all measured panes, each process counted once. */
  totalBytes: number;
  /** Physical memory of the probe's machine. */
  machineBytes?: number;
  /** Set when `ps` itself failed; nothing was measured. */
  error?: string;
}

export interface MemoryDeps {
  /** `ps -A -o pid=,ppid=,rss=,comm=` output. Defaults to running it. */
  ps?: () => string;
  processInfo?: (pane: string) => ProcessInfo | undefined;
  totalmem?: () => number;
}

const MEMORY_TOP = 3;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/;

/** A command's basename, without the `-` a login shell's name starts with. */
export function commandName(comm: string): string {
  return (comm.split("/").at(-1) ?? comm).replace(/^-/, "");
}

/** Parses `ps -o pid=,ppid=,rss=,comm=`, whose RSS is in KiB. Unparseable lines are skipped. */
export function parsePs(out: string): Map<number, MemoryProc> {
  const procs = new Map<number, MemoryProc>();
  for (const line of out.split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid > 0) procs.set(pid, { pid, ppid: Number(m[2]), bytes: Number(m[3]) * 1024, name: commandName(m[4]) });
  }
  return procs;
}

export function childrenOf(procs: Map<number, MemoryProc>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const p of procs.values()) {
    if (p.ppid === p.pid) continue;
    const list = out.get(p.ppid) ?? [];
    list.push(p.pid);
    out.set(p.ppid, list);
  }
  return out;
}

/** `ps` truncates names on Linux (15 characters), so a prefix either way counts. */
function sameCommand(name: string, fg: PaneProcess): boolean {
  return [fg.name, fg.argv0, fg.argv?.[0]].some((n) => {
    if (typeof n !== "string" || !n) return false;
    const other = commandName(n);
    return other.startsWith(name) || name.startsWith(other);
  });
}

/**
 * The pane's processes: the shell and everything under it, plus foreground processes that
 * left the shell's tree (their parent exited). Those are taken only when `ps` names them
 * as herdr did, since process-info and `ps` run at different moments and a pid can be reused.
 */
export function paneProcs(info: ProcessInfo, procs: Map<number, MemoryProc>, children: Map<number, number[]>): MemoryProc[] {
  const seen = new Set<number>();
  const out: MemoryProc[] = [];
  const walk = (root: number) => {
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      const p = procs.get(pid);
      if (!p || seen.has(pid)) continue;
      seen.add(pid);
      out.push(p);
      stack.push(...(children.get(pid) ?? []));
    }
  };
  if (info.shellPid) walk(info.shellPid);
  for (const fg of info.foreground) {
    const p = procs.get(fg.pid);
    if (p && !seen.has(fg.pid) && sameCommand(p.name, fg)) walk(fg.pid);
  }
  return out;
}

export function summarizeProcs(pane: string, list: MemoryProc[], top = MEMORY_TOP): PaneMemory {
  const byName = new Map<string, MemoryTop>();
  let bytes = 0;
  for (const p of list) {
    bytes += p.bytes;
    const t = byName.get(p.name) ?? { name: p.name, bytes: 0, count: 0 };
    t.bytes += p.bytes;
    t.count++;
    byName.set(p.name, t);
  }
  const heaviest = [...byName.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)).slice(0, top);
  return { pane, bytes, processes: list.length, top: heaviest };
}

function runPs(): string {
  // A test can stand in for `ps`; see test/e2e/ps-stub.sh.
  const bin = process.env.HERDR_MAP_PS || "ps";
  return execFileSync(bin, ["-A", "-o", "pid=,ppid=,rss=,comm="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function memoryUse(input: MemoryInput, deps: MemoryDeps = {}): MemoryOutput {
  const machineBytes = (deps.totalmem ?? totalmem)();
  const info = deps.processInfo ?? herdrProcessInfo(input.herdr ?? "herdr", herdrCaller(input.herdr ?? "herdr"));
  const infos = input.panes.map((pane) => [pane, info(pane)] as const);
  let procs: Map<number, MemoryProc>;
  try {
    procs = parsePs((deps.ps ?? runPs)());
  } catch (err) {
    return { panes: [], totalBytes: 0, machineBytes, error: `ps failed: ${errorMessage(err).split("\n")[0]}` };
  }
  const children = childrenOf(procs);
  const panes: PaneMemory[] = [];
  const errors: { pane: string; error: string }[] = [];
  const counted = new Set<number>();
  let totalBytes = 0;
  for (const [pane, i] of infos) {
    if (!i) {
      errors.push({ pane, error: "herdr gave no process info" });
      continue;
    }
    const list = paneProcs(i, procs, children);
    if (list.length === 0) {
      errors.push({ pane, error: "none of the pane's processes are running" });
      continue;
    }
    panes.push(summarizeProcs(pane, list, input.top));
    for (const p of list) {
      if (counted.has(p.pid)) continue;
      counted.add(p.pid);
      totalBytes += p.bytes;
    }
  }
  return { panes, ...(errors.length > 0 && { errors }), totalBytes, machineBytes };
}

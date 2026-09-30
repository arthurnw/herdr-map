import type { AgentMemory, Fleet, FleetMemory } from "../shared/model.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Above this, an agent's memory figure turns amber.
export const HIGH_MEMORY_BYTES = 2 * GB;

/** 350_000_000 → "334 MB", 1_300_000_000 → "1.2 GB", 13_000_000_000 → "12 GB". Binary units, as Activity Monitor uses. */
export function formatBytes(n: number): string {
  if (n < 999.5 * MB) return `${Math.round(n / MB)} MB`;
  if (n < 9.95 * GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.round(n / GB)} GB`;
}

export const highMemory = (m: AgentMemory) => m.bytes > HIGH_MEMORY_BYTES;

/** "claude 820 MB", or "node ×3 300 MB" for several processes with one name. */
export function topEntry(t: AgentMemory["top"][number]): string {
  return `${t.name}${t.count > 1 ? ` ×${t.count}` : ""} ${formatBytes(t.bytes)}`;
}

export function memoryTitle(m: AgentMemory): string {
  const n = `${m.processes} process${m.processes === 1 ? "" : "es"}`;
  return `${formatBytes(m.bytes)} in ${n}${m.top.length ? `: ${m.top.map(topEntry).join(", ")}` : ""}`;
}

export function machineShare(total: FleetMemory): number | undefined {
  return total.machineBytes ? Math.round((total.bytes / total.machineBytes) * 100) : undefined;
}

/** The agents using the most memory, heaviest first, labeled by name (or kind) and workspace. */
export function heaviestAgents(fleet: Fleet | undefined, kindLabel: (kind: string) => string = (k) => k, n = 5): { label: string; bytes: number }[] {
  const out: { label: string; bytes: number }[] = [];
  for (const g of fleet?.groups ?? [])
    for (const ws of g.workspaces)
      for (const t of ws.tabs)
        for (const p of t.panes) {
          const m = p.agent?.memory;
          if (m) out.push({ label: `${p.agent!.name ?? kindLabel(p.agent!.kind)} (${ws.label})`, bytes: m.bytes });
        }
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, n);
}

export function fleetMemoryTitle(fleet: Fleet | undefined, kindLabel?: (kind: string) => string): string | undefined {
  const total = fleet?.memory;
  if (!total) return undefined;
  const pct = machineShare(total);
  const of = total.machineBytes ? ` of ${formatBytes(total.machineBytes)} (${pct}%)` : "";
  const lines = [`Agents use ${formatBytes(total.bytes)}${of} across ${total.agents} agent${total.agents === 1 ? "" : "s"}`];
  const heavy = heaviestAgents(fleet, kindLabel);
  if (heavy.length) lines.push("Heaviest:", ...heavy.map((a) => `${a.label}: ${formatBytes(a.bytes)}`));
  return lines.join("\n");
}

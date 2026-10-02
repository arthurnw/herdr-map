// Memory use from the memory probe: a figure on agent cards, a line in the preview, and a toolbar total.
import { MemoryStick } from "lucide-react";
import type { AgentMemory, Fleet, FleetAgent } from "../shared/model.ts";
import { cn } from "@/lib/utils";
import { fleetMemoryTitle, formatBytes, highMemory, machineShare, memoryTitle, topEntry } from "./memory-format.ts";
import { kindLabel } from "./status.tsx";


export function MemoryChip({ memory }: { memory: AgentMemory }) {
  return (
    <span className={`mem-chip${highMemory(memory) ? " high" : ""}`} title={memoryTitle(memory)}>
      · {formatBytes(memory.bytes)}
    </span>
  );
}

/** The preview's memory line: the tree's total and its heaviest commands. */
export function MemoryLine({ agent }: { agent?: FleetAgent }) {
  const m = agent?.memory;
  if (!m) return null;
  return (
    <p className="text-xs text-muted-foreground tabular-nums" aria-label="Memory">
      <span className={cn(highMemory(m) && "font-semibold text-(--stuck)")}>{formatBytes(m.bytes)}</span> memory in {m.processes}{" "}
      process{m.processes === 1 ? "" : "es"}
      {m.top.map((t) => ` · ${topEntry(t)}`).join("")}
    </p>
  );
}

/** Memory across agents in the toolbar, with its share of the machine's memory. */
export function MemoryTotal({ fleet }: { fleet?: Fleet }) {
  const total = fleet?.memory;
  if (!total) return null;
  const pct = machineShare(total);
  return (
    <span
      className="flex shrink-0 items-center gap-1 px-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
      aria-label="Agent memory"
      title={fleetMemoryTitle(fleet, kindLabel)}
    >
      <MemoryStick className="size-3.5" aria-hidden />
      {formatBytes(total.bytes)}
      {pct !== undefined && <span>({pct}%)</span>}
    </span>
  );
}

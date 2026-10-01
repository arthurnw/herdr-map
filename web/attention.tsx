// Stuck and finished markers for agents that need you; needs-you.ts decides which ones do.
import { TriangleAlert } from "lucide-react";
import type { FleetAgent, FleetWorkspace } from "../shared/model.ts";
import { Badge } from "@/components/ui/badge";
import { formatAge } from "./format.ts";

type Stuck = NonNullable<FleetAgent["stuck"]>;

export function stuckLabel(stuck: Stuck, now: number): string {
  if (stuck.reason === "rate-limit") return "rate limited";
  if (stuck.reason === "error") return "API error";
  return `stuck ${formatAge(now - stuck.since)}`;
}

export function stuckDescription(stuck: Stuck, now: number): string {
  if (stuck.reason === "rate-limit") return `Rate-limit or usage-limit message on screen for ${formatAge(now - stuck.since)}`;
  if (stuck.reason === "error") return `API error on screen for ${formatAge(now - stuck.since)}`;
  return `Working, but the screen hasn't changed for ${formatAge(now - stuck.since)}`;
}

/** The line on a map card. */
export function StuckMarker({ stuck, now }: { stuck: Stuck; now: number }) {
  return (
    <div className="agent-stuck" title={stuckDescription(stuck, now)}>
      <TriangleAlert className="agent-stuck-icon" aria-hidden />
      {stuckLabel(stuck, now)}
    </div>
  );
}

/** The badge in the sidebar. */
export function StuckBadge({ stuck, now }: { stuck: Stuck; now: number }) {
  return (
    <Badge variant="outline" className="gap-1 border-(--stuck) text-(--stuck)" title={stuckDescription(stuck, now)}>
      <TriangleAlert className="size-3" aria-hidden />
      {stuckLabel(stuck, now)}
    </Badge>
  );
}

export function doneCount(ws: FleetWorkspace): number {
  return ws.tabs.reduce((n, t) => n + t.panes.filter((p) => p.agent?.status === "done").length, 0);
}

/** A dot and count on a workspace header while it has finished agents you haven't looked at. */
export function DoneMarker({ workspace }: { workspace: FleetWorkspace }) {
  const n = doneCount(workspace);
  if (n === 0) return null;
  return (
    <span className="ws-done" title={`${n} finished agent${n > 1 ? "s" : ""}`}>
      <span className="ws-done-dot" aria-hidden />
      {n}
    </span>
  );
}

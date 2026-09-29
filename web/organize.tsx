// Workspace header pieces for collapsing, tagging, and coloring workspaces and repo boxes.
import { STATUSES, type AgentStatus, type FleetWorkspace } from "../shared/model.ts";

/** Agent counts by status, for a collapsed header. Done agents already have their own marker. */
export function StatusCounts({ workspace }: { workspace: FleetWorkspace }) {
  const counts = new Map<AgentStatus, number>();
  for (const tab of workspace.tabs)
    for (const pane of tab.panes) if (pane.agent) counts.set(pane.agent.status, (counts.get(pane.agent.status) ?? 0) + 1);
  const shown = STATUSES.filter((s) => s !== "done" && counts.has(s));
  if (shown.length === 0) return null;
  return (
    <span className="ws-status-counts" title={shown.map((s) => `${counts.get(s)} ${s}`).join(", ")}>
      {shown.map((s) => (
        <span key={s} className={`ws-status-count status-${s}`}>
          <span className="ws-status-dot" aria-hidden />
          {counts.get(s)}
        </span>
      ))}
    </span>
  );
}

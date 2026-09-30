import type { AgentStatus, Fleet } from "../shared/model.ts";

export interface PaneInfo {
  paneId: string;
  workspace: string;
  /** Unset for a pane without an agent. */
  status?: AgentStatus;
  kind?: string;
  name?: string;
}

/** Every pane in the fleet by id, with its agent's status and names for prompts and labels. */
export function indexPanes(fleet: Fleet | undefined): Map<string, PaneInfo> {
  const out = new Map<string, PaneInfo>();
  for (const g of fleet?.groups ?? [])
    for (const ws of g.workspaces)
      for (const tab of ws.tabs)
        for (const p of tab.panes) {
          out.set(p.id, { paneId: p.id, workspace: ws.label, status: p.agent?.status, kind: p.agent?.kind, name: p.agent?.name });
        }
  return out;
}

/** "lead (api)", or "claude (api)" for an agent without a name. */
export function paneLabel(info: PaneInfo | undefined, paneId: string): string {
  if (!info) return paneId;
  return `${info.name ?? info.kind ?? paneId} (${info.workspace})`;
}

/** Statuses a prompt can be delivered in. herdr refuses prompts to blocked agents. */
export function isFree(status: AgentStatus | undefined): boolean {
  return status === "idle" || status === "done";
}

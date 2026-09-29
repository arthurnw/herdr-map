// Workspace and repo box header pieces for collapsing, tagging, and coloring.
import { useContext } from "react";
import { Check, Palette } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { STATUSES, type AgentStatus, type FleetWorkspace } from "../shared/model.ts";
import { COLORS, isColor, type TintColor } from "../shared/organize.ts";
import { WorkspaceActions } from "./workspace-actions.ts";

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

/** Classes that tint an element with a saved color; unknown colors are ignored. */
export function tintClass(color: string | undefined): string {
  return isColor(color) ? `tinted tint-${color}` : "";
}

const label = (c: TintColor) => c[0].toUpperCase() + c.slice(1);

/** Menu items for picking a color or none, with the current one checked. */
export function ColorItems({ value, onPick }: { value?: string; onPick: (color: TintColor | null) => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={() => onPick(null)}>
        <span className="color-swatch none" aria-hidden />
        No color
        {!isColor(value) && <Check className="ml-auto" aria-hidden />}
      </DropdownMenuItem>
      {COLORS.map((c) => (
        <DropdownMenuItem key={c} onSelect={() => onPick(c)}>
          <span className={`color-swatch tint-${c}`} aria-hidden />
          {label(c)}
          {value === c && <Check className="ml-auto" aria-hidden />}
        </DropdownMenuItem>
      ))}
    </>
  );
}

// Keeps clicks on header menus from reaching React Flow, which would start a drag or
// focus in herdr; menu content renders in a portal, but React still bubbles through the node.
export const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** The color button on a repo box header. */
export function GroupColorMenu({ groupKey, groupLabel, color }: { groupKey: string; groupLabel: string; color?: string }) {
  const actions = useContext(WorkspaceActions);
  if (!actions) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="group-menu nodrag nopan" aria-label={`Color for ${groupLabel}`} onClick={stop} onPointerDown={stop}>
          <Palette aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onClick={stop} onPointerDown={stop}>
        <ColorItems value={color} onPick={(c) => actions.setGroupColor(groupKey, c)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

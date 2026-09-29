// Workspace and repo box header pieces for collapsing, tagging, and coloring.
import { useContext, useEffect, useRef, useState } from "react";
import { Check, Palette, Tag, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { STATUSES, type AgentStatus, type FleetWorkspace } from "../shared/model.ts";
import { COLORS, isColor, normalizeTag, type TintColor } from "../shared/organize.ts";
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

export function TagChips({ tags }: { tags: string[] }) {
  return tags.map((t) => (
    <span key={t} className="ws-tag ws-user-tag">
      {t}
    </span>
  ));
}

/** The workspace menu's tag items: add one, or remove any it has. */
export function TagMenuItems({ tags, onAdd, onRemove }: { tags: string[]; onAdd: () => void; onRemove: (tag: string) => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={onAdd}>
        <Tag aria-hidden />
        Add tag…
      </DropdownMenuItem>
      {tags.map((t) => (
        <DropdownMenuItem key={t} onSelect={() => onRemove(t)}>
          <X aria-hidden />
          Remove tag “{t}”
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * A small input that turns typed text into a tag. Enter adds it, Esc or leaving the field
 * closes it. `onClose` runs after either.
 */
export function TagInput({ onAdd, onClose, className }: { onAdd: (tag: string) => void; onClose: () => void; className?: string }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const tag = normalizeTag(text);
  useEffect(() => input.current?.focus(), []);
  return (
    <input
      ref={input}
      className={`tag-input nodrag nopan ${className ?? ""}`}
      aria-label="New tag"
      placeholder="tag"
      aria-invalid={text !== "" && !tag}
      title={text && !tag ? "Letters, digits, “.”, “_”, or “-”, up to 24" : undefined}
      value={text}
      maxLength={40}
      onChange={(e) => setText(e.target.value)}
      onClick={stop}
      onPointerDown={stop}
      onBlur={onClose}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && tag) {
          onAdd(tag);
          onClose();
        }
        if (e.key === "Escape") onClose();
      }}
    />
  );
}

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

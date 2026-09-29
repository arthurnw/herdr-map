// Workspace and repo box metadata changes, shared by the server (which validates and
// stores them) and the web UI (which applies them before the server answers).
import type { GroupMeta, WorkspaceMeta } from "./layout-types.ts";

/** Colors for repo boxes, workspaces, and notes. The UI maps each to a light and a dark shade. */
export const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export type TintColor = (typeof COLORS)[number];

export function isColor(value: unknown): value is TintColor {
  return COLORS.includes(value as TintColor);
}

export interface MetaState {
  workspaces: Record<string, WorkspaceMeta>;
  groups: Record<string, GroupMeta>;
}

/** A change to one or more workspaces. Omitted fields stay as they are. */
export interface WorkspacePatch {
  ids: string[];
  collapsed?: boolean;
  /** `null` removes the color. */
  color?: TintColor | null;
}

/** A repo box color change; `null` removes the color. */
export interface GroupPatch {
  key: string;
  color: TintColor | null;
}

/** Applies `patch` in place. Entries left with no metadata are removed. */
export function applyWorkspacePatch(workspaces: Record<string, WorkspaceMeta>, patch: WorkspacePatch): void {
  for (const id of patch.ids) {
    const meta: WorkspaceMeta = { ...workspaces[id] };
    if (patch.collapsed === true) meta.collapsed = true;
    if (patch.collapsed === false) delete meta.collapsed;
    if (patch.color) meta.color = patch.color;
    if (patch.color === null) delete meta.color;
    if (Object.keys(meta).length > 0) workspaces[id] = meta;
    else delete workspaces[id];
  }
}

/** Applies `patch` in place. A box left with no metadata is removed. */
export function applyGroupPatch(groups: Record<string, GroupMeta>, patch: GroupPatch): void {
  if (patch.color) groups[patch.key] = { ...groups[patch.key], color: patch.color };
  else delete groups[patch.key];
}

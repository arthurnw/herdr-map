// Workspace and repo box metadata changes, shared by the server (which validates and
// stores them) and the web UI (which applies them before the server answers).
import type { GroupMeta, WorkspaceMeta } from "./layout-types.ts";

export interface MetaState {
  workspaces: Record<string, WorkspaceMeta>;
  groups: Record<string, GroupMeta>;
}

/** A change to one or more workspaces. Omitted fields stay as they are. */
export interface WorkspacePatch {
  ids: string[];
  collapsed?: boolean;
}

/** Applies `patch` in place. Entries left with no metadata are removed. */
export function applyWorkspacePatch(workspaces: Record<string, WorkspaceMeta>, patch: WorkspacePatch): void {
  for (const id of patch.ids) {
    const meta: WorkspaceMeta = { ...workspaces[id] };
    if (patch.collapsed === true) meta.collapsed = true;
    if (patch.collapsed === false) delete meta.collapsed;
    if (Object.keys(meta).length > 0) workspaces[id] = meta;
    else delete workspaces[id];
  }
}

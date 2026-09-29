// Shape of layout.json, shared by the server (which persists it) and the web UI.

/** Canvas position per workspace id. `detached` workspaces sit outside their repo group. */
export type SavedLayout = Record<string, { x: number; y: number; detached?: boolean }>;

export interface NamedLayout {
  /** Epoch milliseconds. */
  savedAt: number;
  layout: SavedLayout;
}

export interface WorkspaceMeta {
  tags?: string[];
  /** Any CSS color string; the UI decides how to apply it. */
  color?: string;
  collapsed?: boolean;
}

export interface GroupMeta {
  color?: string;
}

export interface Note {
  id: string;
  text: string;
  x: number;
  y: number;
  /** Size in canvas units; the UI picks a default when unset. */
  w?: number;
  h?: number;
  color?: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/** A link end: a herdr pane id or a `Note.id`. */
export interface Endpoint {
  kind: "pane" | "note";
  id: string;
}

export type LinkKind = "context" | "handoff";

export interface Link {
  id: string;
  from: Endpoint;
  to: Endpoint;
  kind: LinkKind;
  createdAt: number;
}

export interface LayoutStore {
  version: 2;
  /** The layout in use. */
  current: SavedLayout;
  /** Layouts the user saved by name to restore later. */
  named: Record<string, NamedLayout>;
  /** Keyed by herdr workspace id. */
  workspaces: Record<string, WorkspaceMeta>;
  /** Keyed by `FleetGroup.key`: herdr `worktree.repo_key`, or `__other__`. */
  groups: Record<string, GroupMeta>;
  notes: Note[];
  links: Link[];
  /** Previous `current` layouts, oldest first, for undo. */
  history: SavedLayout[];
}

import { createContext } from "react";
import type { TintColor } from "../shared/organize.ts";

/** Layout actions the workspace and repo box header menus call; provided by the map. */
export interface WorkspaceActionsValue {
  setDetached(workspaceIds: string | string[], detach: boolean): void;
  /** Clears a tab's hand-placed card positions. */
  restackCards(tabId: string): void;
  setCollapsed(workspaceIds: string[], collapsed: boolean): void;
  setWorkspaceColor(workspaceIds: string[], color: TintColor | null): void;
  setGroupColor(groupKey: string, color: TintColor | null): void;
  addTag(workspaceIds: string[], tag: string): void;
  removeTag(workspaceIds: string[], tag: string): void;
}

export const WorkspaceActions = createContext<WorkspaceActionsValue | undefined>(undefined);

import { createContext } from "react";

/** Layout actions the workspace node's header menu calls; provided by the map. */
export interface WorkspaceActionsValue {
  setDetached(workspaceId: string, detach: boolean): void;
}

export const WorkspaceActions = createContext<WorkspaceActionsValue | undefined>(undefined);

// Actions for the box-selected workspaces, shown over the canvas while any are selected.
import { useContext, useState } from "react";
import type { Node } from "@xyflow/react";
import { ChevronsDownUp, ChevronsUpDown, Group, Tag, Ungroup, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WorkspaceData } from "./layout.ts";
import { TagInput } from "./organize.tsx";
import { WorkspaceActions } from "./workspace-actions.ts";

export function BulkBar({ nodes, selected, onClear }: { nodes: Node[]; selected: ReadonlySet<string>; onClear: () => void }) {
  const actions = useContext(WorkspaceActions);
  const [tagging, setTagging] = useState(false);
  const workspaces = nodes.filter((n) => n.type === "workspace").map((n) => ({ nodeId: n.id, ...(n.data as WorkspaceData) }));
  const chosen = workspaces.filter((w) => selected.has(w.nodeId));
  if (!actions || chosen.length === 0) return null;

  const ids = chosen.map((w) => w.workspace.id);
  // A workspace can leave its box only while an unselected workspace stays in it.
  const staying = new Set(workspaces.filter((w) => !selected.has(w.nodeId) && !w.detached).map((w) => w.groupKey));
  const canTakeOut = chosen.some((w) => !w.detached && staying.has(w.groupKey));
  const canPutBack = chosen.some((w) => w.detached);

  return (
    <div className="flex items-center gap-1 rounded-lg border bg-card p-1 text-sm shadow-md" role="toolbar" aria-label="Selected workspaces">
      <span className="px-2 font-medium whitespace-nowrap tabular-nums">
        {chosen.length} workspace{chosen.length > 1 ? "s" : ""}
      </span>
      <Button variant="ghost" size="sm" disabled={chosen.every((w) => w.collapsed)} onClick={() => actions.setCollapsed(ids, true)}>
        <ChevronsDownUp />
        Collapse
      </Button>
      <Button variant="ghost" size="sm" disabled={!chosen.some((w) => w.collapsed)} onClick={() => actions.setCollapsed(ids, false)}>
        <ChevronsUpDown />
        Expand
      </Button>
      {tagging ? (
        <TagInput className="mx-1" onAdd={(t) => actions.addTag(ids, t)} onClose={() => setTagging(false)} />
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setTagging(true)}>
          <Tag />
          Add tag
        </Button>
      )}
      <Button variant="ghost" size="sm" disabled={!canTakeOut} onClick={() => actions.setDetached(ids, true)}>
        <Ungroup />
        Take out of box
      </Button>
      <Button variant="ghost" size="sm" disabled={!canPutBack} onClick={() => actions.setDetached(ids, false)}>
        <Group />
        Put back in box
      </Button>
      <Button variant="ghost" size="icon" className="size-8" aria-label="Clear selection" onClick={onClear}>
        <X />
      </Button>
    </div>
  );
}

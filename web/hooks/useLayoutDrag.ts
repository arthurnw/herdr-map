import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useReactFlow, type Node, type NodeChange } from "@xyflow/react";
import { isDetachedDrop, type GroupData, type Rect, type SavedLayout, type WorkspaceData } from "../layout.ts";
import { putLayout } from "../state.ts";

function nodeRect(n: Node): Rect {
  return { x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 };
}

/** The saved workspace positions, loaded once from the server. Undefined until loaded. */
export function useSavedLayout() {
  const [saved, setSaved] = useState<SavedLayout>();

  useEffect(() => {
    fetch("/api/layout")
      .then((res) => res.json())
      .then((layout: SavedLayout) => setSaved(layout))
      .catch(() => setSaved({}));
  }, []);

  return [saved, setSaved] as const;
}

/**
 * Workspace and group dragging over the laid-out `nodes`, plus reading and applying whole
 * layouts. Settled positions are written back to the server.
 */
export function useLayoutDrag(
  nodes: Node[],
  saved: SavedLayout | undefined,
  setSaved: Dispatch<SetStateAction<SavedLayout | undefined>>,
) {
  // Bumped after a drag or reset; the effect below writes the settled layout.
  const [saveTick, setSaveTick] = useState(0);
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (saveTick > 0 && saved) void putLayout(saved);
    // Only a new tick should trigger a write, not every drag frame.
  }, [saveTick]);

  // Dragging a workspace moves it; dragging a group box moves its attached workspaces.
  // The first drag freezes the automatic layout by saving every current position.
  // Group drags apply offsets from the drag start, so repeated change events can't compound.
  const groupDrag = useRef<{ id: string; origin: { x: number; y: number }; members: SavedLayout }>(undefined);

  const onNodeDragStart = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== "group-box") return;
      const members: SavedLayout = {};
      for (const n of nodes) {
        if (n.type !== "workspace") continue;
        const id = (n.data as WorkspaceData).workspace.id;
        if ((node.data as GroupData).memberIds.includes(id)) members[id] = { ...n.position, detached: false };
      }
      groupDrag.current = { id: node.id, origin: { ...node.position }, members };
    },
    [nodes],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const moves = changes.filter((c) => c.type === "position" && c.position);
      if (moves.length === 0) return;
      setSaved((prev) => {
        const next: SavedLayout = { ...prev };
        const byId = new Map(nodes.map((n) => [n.id, n]));
        if (Object.keys(next).length === 0) {
          for (const n of nodes) {
            if (n.type === "workspace") next[(n.data as WorkspaceData).workspace.id] = { ...n.position };
          }
        }
        for (const change of moves) {
          if (change.type !== "position" || !change.position) continue;
          const node = byId.get(change.id);
          if (!node) continue;
          if (node.type === "workspace") {
            const id = (node.data as WorkspaceData).workspace.id;
            next[id] = { ...change.position, detached: next[id]?.detached };
          } else if (node.type === "group-box" && groupDrag.current?.id === node.id) {
            const { origin, members } = groupDrag.current;
            const dx = change.position.x - origin.x;
            const dy = change.position.y - origin.y;
            for (const [id, p] of Object.entries(members)) next[id] = { x: p.x + dx, y: p.y + dy };
          }
        }
        return next;
      });
    },
    [nodes, setSaved],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      setSaved((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        if (node.type === "workspace") {
          const data = node.data as WorkspaceData;
          const others = nodes.filter(
            (n) =>
              n.type === "workspace" &&
              n.id !== node.id &&
              (n.data as WorkspaceData).groupKey === data.groupKey &&
              !(n.data as WorkspaceData).detached,
          );
          const detached = isDetachedDrop(nodeRect(node), others.map(nodeRect));
          next[data.workspace.id] = { ...node.position, detached };
        }
        return next;
      });
      groupDrag.current = undefined;
      setSaveTick((t) => t + 1);
    },
    [nodes, setSaved],
  );

  // Saved positions for hidden workspaces are kept alongside the ones on screen.
  const currentPositions = useCallback((): SavedLayout => {
    const out: SavedLayout = { ...saved };
    for (const n of nodes) {
      if (n.type !== "workspace") continue;
      const data = n.data as WorkspaceData;
      out[data.workspace.id] = { ...n.position, detached: data.detached || undefined };
    }
    return out;
  }, [saved, nodes]);

  const applyLayout = useCallback(
    (next: SavedLayout) => {
      setSaved(next);
      setSaveTick((t) => t + 1);
      requestAnimationFrame(() => fitView({ padding: 0.05 }));
    },
    [setSaved, fitView],
  );

  return { onNodeDragStart, onNodesChange, onNodeDragStop, currentPositions, applyLayout };
}

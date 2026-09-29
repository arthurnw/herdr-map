import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useReactFlow, type Node, type NodeChange } from "@xyflow/react";
import { isDetachedDrop, type GroupData, type Rect, type SavedLayout, type WorkspaceData } from "../layout.ts";
import { putLayout } from "../state.ts";

function nodeRect(n: Node): Rect {
  return { x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 };
}

function bounds(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
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

const NONE: ReadonlySet<string> = new Set();

/**
 * Workspace and group dragging over the laid-out `nodes`, plus reading and applying whole
 * layouts. Settled positions are written back to the server. `selected` holds the node IDs
 * of box-selected workspaces, which move together.
 */
export function useLayoutDrag(
  nodes: Node[],
  saved: SavedLayout | undefined,
  setSaved: Dispatch<SetStateAction<SavedLayout | undefined>>,
  selected: ReadonlySet<string> = NONE,
  /** Told which workspace IDs a drag is moving, and `undefined` when it ends. */
  setDragging: (ids: ReadonlySet<string> | undefined) => void = () => {},
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
  // Dragging one of several box-selected workspaces moves the others by the same offset.
  const bulkDrag = useRef<{ id: string; origin: { x: number; y: number }; members: SavedLayout }>(undefined);

  const onNodeDragStart = useCallback(
    (_: unknown, node: Node) => {
      if (node.type === "workspace" && selected.has(node.id) && selected.size > 1) {
        const members: SavedLayout = {};
        for (const n of nodes) {
          if (n.type !== "workspace" || n.id === node.id || !selected.has(n.id)) continue;
          const data = n.data as WorkspaceData;
          members[data.workspace.id] = { ...n.position, detached: data.detached || undefined };
        }
        bulkDrag.current = { id: node.id, origin: { ...node.position }, members };
      }
      if (node.type === "workspace") {
        const ids = new Set([(node.data as WorkspaceData).workspace.id]);
        if (bulkDrag.current?.id === node.id) for (const id of Object.keys(bulkDrag.current.members)) ids.add(id);
        setDragging(ids);
      }
      if (node.type !== "group-box") return;
      const members: SavedLayout = {};
      for (const n of nodes) {
        if (n.type !== "workspace") continue;
        const id = (n.data as WorkspaceData).workspace.id;
        if ((node.data as GroupData).memberIds.includes(id)) members[id] = { ...n.position, detached: false };
      }
      groupDrag.current = { id: node.id, origin: { ...node.position }, members };
    },
    [nodes, selected, setDragging],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const moves = changes.filter((c) => c.type === "position" && c.position);
      if (moves.length === 0) return;
      const bulk = bulkDrag.current;
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
            if (bulk?.id === node.id) {
              const { origin, members } = bulk;
              const dx = change.position.x - origin.x;
              const dy = change.position.y - origin.y;
              for (const [mid, p] of Object.entries(members)) next[mid] = { ...p, x: p.x + dx, y: p.y + dy };
            }
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
      // Read before the ref is cleared below; the updater runs later.
      const bulk = bulkDrag.current;
      setSaved((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        if (node.type === "workspace") {
          const wsId = (n: Node) => (n.data as WorkspaceData).workspace.id;
          const moved = nodes.filter(
            (n) => n.type === "workspace" && (n.id === node.id || (bulk?.id === node.id && selected.has(n.id))),
          );
          const movedIds = new Set(moved.map((n) => n.id));
          const rect = (n: Node) => nodeRect({ ...n, position: n.id === node.id ? node.position : (next[wsId(n)] ?? n.position) });
          // Workspaces moved together detach from, or rejoin, their group as one, depending on
          // whether they land near the group members that stayed put.
          for (const m of moved) {
            const { groupKey } = m.data as WorkspaceData;
            const sameGroup = (n: Node) => (n.data as WorkspaceData).groupKey === groupKey;
            const others = nodes.filter(
              (n) => n.type === "workspace" && !movedIds.has(n.id) && sameGroup(n) && !(n.data as WorkspaceData).detached,
            );
            const detached = isDetachedDrop(bounds(moved.filter(sameGroup).map(rect)), others.map(nodeRect));
            const { x, y } = rect(m);
            next[wsId(m)] = { x, y, detached };
          }
        }
        return next;
      });
      groupDrag.current = undefined;
      bulkDrag.current = undefined;
      setDragging(undefined);
      setSaveTick((t) => t + 1);
    },
    [nodes, setSaved, selected, setDragging],
  );

  // Takes workspaces out of their repo box, or puts them back, without dragging. Removed
  // workspaces keep their arrangement and go just right of the box; returned ones go where
  // new members would. A box always keeps at least one workspace.
  const setDetached = useCallback(
    (wsIds: string | string[], detach: boolean) => {
      const ids = new Set(typeof wsIds === "string" ? [wsIds] : wsIds);
      const id = (n: Node) => (n.data as WorkspaceData).workspace.id;
      const data = (n: Node) => n.data as WorkspaceData;
      const workspaces = nodes.filter((n) => n.type === "workspace");
      const byGroup = new Map<string, Node[]>();
      for (const n of workspaces) {
        if (!ids.has(id(n)) || data(n).detached === detach) continue;
        byGroup.set(data(n).groupKey, [...(byGroup.get(data(n).groupKey) ?? []), n]);
      }
      const moved: SavedLayout = {};
      const returned: string[] = [];
      for (const [groupKey, members] of byGroup) {
        if (!detach) {
          returned.push(...members.map(id));
          continue;
        }
        const others = workspaces.filter((n) => !ids.has(id(n)) && data(n).groupKey === groupKey && !data(n).detached);
        if (others.length === 0) continue;
        const box = bounds(others.map(nodeRect));
        const from = bounds(members.map(nodeRect));
        const dx = box.x + box.w + 120 - from.x;
        const dy = box.y - from.y;
        for (const m of members) moved[id(m)] = { x: m.position.x + dx, y: m.position.y + dy, detached: true };
      }
      if (Object.keys(moved).length === 0 && returned.length === 0) return;
      setSaved((prev) => {
        const next: SavedLayout = { ...prev };
        if (Object.keys(next).length === 0) {
          for (const n of workspaces) next[id(n)] = { ...n.position };
        }
        Object.assign(next, moved);
        for (const r of returned) delete next[r];
        return next;
      });
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

  return { onNodeDragStart, onNodesChange, onNodeDragStop, currentPositions, applyLayout, setDetached };
}

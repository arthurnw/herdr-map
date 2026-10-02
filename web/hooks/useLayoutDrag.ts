import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useReactFlow, type Node, type NodeChange, type NodePositionChange } from "@xyflow/react";
import {
  emptyLayout,
  isDetachedDrop,
  snapCard,
  type CardDrag,
  type LayoutNode,
  type LayoutNodeOf,
  type Rect,
  type SavedLayout,
  type WorkspacePositions,
} from "../layout.ts";
import { putLayout, type Located } from "../state.ts";

type WorkspaceNode = LayoutNodeOf<"workspace">;
type NodeDragEvent = MouseEvent | TouchEvent;

function nodeRect(n: Node): Rect {
  return { x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 };
}

function bounds(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/** The saved workspace and card positions, loaded once from the server. Undefined until loaded. */
export function useSavedLayout() {
  const [saved, setSaved] = useState<SavedLayout>();

  useEffect(() => {
    fetch("/api/layout")
      .then((res) => res.json())
      .then((layout: SavedLayout) => setSaved(layout))
      .catch(() => setSaved(emptyLayout()));
  }, []);

  return [saved, setSaved] as const;
}

const NONE: ReadonlySet<string> = new Set();
const NO_PANES: ReadonlyMap<string, Located> = new Map();

/**
 * Workspace, group, and agent card dragging over the laid-out `nodes`, plus reading and
 * applying whole layouts. Settled positions are written back to the server. `selected` holds
 * the node IDs of box-selected workspaces, which move together.
 */
export function useLayoutDrag(
  nodes: LayoutNode[],
  saved: SavedLayout | undefined,
  setSaved: Dispatch<SetStateAction<SavedLayout | undefined>>,
  selected: ReadonlySet<string> = NONE,
  /** Told which workspace IDs a drag is moving, and `undefined` when it ends. */
  setDragging: (ids: ReadonlySet<string> | undefined) => void = () => {},
  /** Told where a dragged agent card is, and `undefined` when it's dropped. */
  setCardDrag: (drag: CardDrag | undefined) => void = () => {},
  /** Every pane in the fleet, including hidden ones; saved card positions for other panes are dropped. */
  panes: ReadonlyMap<string, Located> = NO_PANES,
) {
  // Bumped after a drag or reset; the effect below writes the settled layout.
  const [saveTick, setSaveTick] = useState(0);
  const { fitView } = useReactFlow();

  // An empty map means the fleet hasn't loaded, not that every pane is gone.
  const withLivePanes = useCallback(
    (layout: SavedLayout): SavedLayout =>
      panes.size === 0
        ? layout
        : { ...layout, cards: Object.fromEntries(Object.entries(layout.cards).filter(([id]) => panes.has(id))) },
    [panes],
  );

  useEffect(() => {
    if (saveTick > 0 && saved) void putLayout(withLivePanes(saved));
    // Only a new tick should trigger a write, not every drag frame.
  }, [saveTick]);

  const setWorkspaces = useCallback(
    (fn: (prev: WorkspacePositions) => WorkspacePositions) =>
      setSaved((prev) => {
        const base = prev ?? emptyLayout();
        return { ...base, workspaces: fn(base.workspaces) };
      }),
    [setSaved],
  );

  // Dragging a workspace moves it; dragging a group box moves its attached workspaces.
  // The first drag freezes the automatic layout by saving every current position.
  // Group drags apply offsets from the drag start, so repeated change events can't compound.
  const groupDrag = useRef<{ id: string; origin: { x: number; y: number }; members: WorkspacePositions }>(undefined);
  // Dragging one of several box-selected workspaces moves the others by the same offset.
  const bulkDrag = useRef<{ id: string; origin: { x: number; y: number }; members: WorkspacePositions }>(undefined);

  const onNodeDragStart = useCallback(
    (_event: NodeDragEvent, node: LayoutNode) => {
      if (node.type === "pane") {
        setCardDrag({ id: node.id, ...node.position });
        return;
      }
      if (node.type === "workspace" && selected.has(node.id) && selected.size > 1) {
        const members: WorkspacePositions = {};
        for (const n of nodes) {
          if (n.type !== "workspace" || n.id === node.id || !selected.has(n.id)) continue;
          const { data } = n;
          members[data.workspace.id] = { ...n.position, detached: data.detached || undefined };
        }
        bulkDrag.current = { id: node.id, origin: { ...node.position }, members };
      }
      if (node.type === "workspace") {
        const ids = new Set([node.data.workspace.id]);
        if (bulkDrag.current?.id === node.id) for (const id of Object.keys(bulkDrag.current.members)) ids.add(id);
        setDragging(ids);
      }
      if (node.type !== "group-box") return;
      const members: WorkspacePositions = {};
      for (const n of nodes) {
        if (n.type !== "workspace") continue;
        const id = n.data.workspace.id;
        if (node.data.memberIds.includes(id)) members[id] = { ...n.position, detached: false };
      }
      groupDrag.current = { id: node.id, origin: { ...node.position }, members };
    },
    [nodes, selected, setDragging, setCardDrag],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const moves = changes.filter((c): c is NodePositionChange => c.type === "position" && !!c.position);
      const isCard = (c: NodePositionChange) => byId.get(c.id)?.type === "pane";
      // A card's drag position stays out of the saved layout until the drop, so its tab keeps its size.
      for (const c of moves) {
        if (c.position && isCard(c)) setCardDrag({ id: c.id, ...snapCard(c.position) });
      }
      const workspaceMoves = moves.filter((c) => !isCard(c));
      if (workspaceMoves.length === 0) return;
      const bulk = bulkDrag.current;
      setWorkspaces((prev) => {
        const next: WorkspacePositions = { ...prev };
        if (Object.keys(next).length === 0) {
          for (const n of nodes) {
            if (n.type === "workspace") next[n.data.workspace.id] = { ...n.position };
          }
        }
        for (const change of workspaceMoves) {
          if (!change.position) continue;
          const node = byId.get(change.id);
          if (!node) continue;
          if (node.type === "workspace") {
            const id = node.data.workspace.id;
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
    [nodes, setWorkspaces, setCardDrag],
  );

  const onNodeDragStop = useCallback(
    (_event: NodeDragEvent, node: LayoutNode) => {
      if (node.type === "pane") {
        const mates = nodes.filter((n) => n.type === "pane" && n.parentId === node.parentId && n.id !== node.id);
        setSaved((prev) => {
          if (!prev) return prev;
          const cards = { ...prev.cards };
          // The first move in a tab pins the other cards where they are, so they don't restack.
          for (const n of mates) cards[n.id] ??= { ...n.position };
          cards[node.id] = snapCard(node.position);
          return { ...prev, cards };
        });
        setCardDrag(undefined);
        setSaveTick((t) => t + 1);
        return;
      }
      // Read before the ref is cleared below; the updater runs later.
      const bulk = bulkDrag.current;
      setWorkspaces((prev) => {
        const next = { ...prev };
        if (node.type === "workspace") {
          const wsId = (n: WorkspaceNode) => n.data.workspace.id;
          const moved = nodes.filter(
            (n): n is WorkspaceNode => n.type === "workspace" && (n.id === node.id || (bulk?.id === node.id && selected.has(n.id))),
          );
          const movedIds = new Set(moved.map((n) => n.id));
          const rect = (n: WorkspaceNode) => nodeRect({ ...n, position: n.id === node.id ? node.position : (next[wsId(n)] ?? n.position) });
          // Workspaces moved together detach from, or rejoin, their group as one, depending on
          // whether they land near the group members that stayed put.
          for (const m of moved) {
            const { groupKey } = m.data;
            const sameGroup = (n: WorkspaceNode) => n.data.groupKey === groupKey;
            const others = nodes.filter(
              (n) => n.type === "workspace" && !movedIds.has(n.id) && sameGroup(n) && !n.data.detached,
            );
            const detached = isDetachedDrop(bounds(moved.flatMap((n) => (sameGroup(n) ? [rect(n)] : []))), others.map(nodeRect));
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
    [nodes, setSaved, setWorkspaces, selected, setDragging, setCardDrag],
  );

  // Takes workspaces out of their repo box, or puts them back, without dragging. Removed
  // workspaces keep their arrangement and go just right of the box; returned ones go where
  // new members would. A box always keeps at least one workspace.
  const setDetached = useCallback(
    (wsIds: string | string[], detach: boolean) => {
      const ids = new Set(Array.isArray(wsIds) ? wsIds : [wsIds]);
      const id = (n: WorkspaceNode) => n.data.workspace.id;
      const data = (n: WorkspaceNode) => n.data;
      const workspaces = nodes.filter((n) => n.type === "workspace");
      const byGroup = new Map<string, WorkspaceNode[]>();
      for (const n of workspaces) {
        if (!ids.has(id(n)) || data(n).detached === detach) continue;
        byGroup.set(data(n).groupKey, [...(byGroup.get(data(n).groupKey) ?? []), n]);
      }
      const moved: WorkspacePositions = {};
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
      setWorkspaces((prev) => {
        const next: WorkspacePositions = { ...prev };
        if (Object.keys(next).length === 0) {
          for (const n of workspaces) next[id(n)] = { ...n.position };
        }
        Object.assign(next, moved);
        for (const r of returned) delete next[r];
        return next;
      });
      setSaveTick((t) => t + 1);
    },
    [nodes, setWorkspaces],
  );

  /** Puts a tab's cards back in the default stack. */
  const restackCards = useCallback(
    (tabId: string) => {
      const inTab = (paneId: string) =>
        panes.get(paneId)?.tabId === tabId || nodes.some((n) => n.id === paneId && n.parentId === `tab:${tabId}`);
      setSaved((prev) => prev && { ...prev, cards: Object.fromEntries(Object.entries(prev.cards).filter(([id]) => !inTab(id))) });
      setSaveTick((t) => t + 1);
    },
    [nodes, panes, setSaved],
  );

  // Saved positions for hidden workspaces are kept alongside the ones on screen.
  const currentPositions = useCallback((): SavedLayout => {
    const base = saved ?? emptyLayout();
    const workspaces: WorkspacePositions = { ...base.workspaces };
    for (const n of nodes) {
      if (n.type !== "workspace") continue;
      const { data } = n;
      workspaces[data.workspace.id] = { ...n.position, detached: data.detached || undefined };
    }
    return withLivePanes({ ...base, workspaces });
  }, [saved, nodes, withLivePanes]);

  const applyLayout = useCallback(
    (next: SavedLayout) => {
      setSaved(next);
      setSaveTick((t) => t + 1);
      requestAnimationFrame(() => fitView({ padding: 0.05 }));
    },
    [setSaved, fitView],
  );

  return { onNodeDragStart, onNodesChange, onNodeDragStop, currentPositions, applyLayout, setDetached, restackCards };
}

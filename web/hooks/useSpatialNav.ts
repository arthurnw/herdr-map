import { useReactFlow, useStoreApi } from "@xyflow/react";
import { moveOnBoard } from "../board.ts";
import type { LayoutNode } from "../layout.ts";
import { nearestInDirection, nearestToPoint, type Box, type Direction } from "../spatial.ts";
import { useShortcut } from "./useShortcut.ts";

type Select = (paneId: string, options?: { keepZoom?: boolean }) => void;

// The map and the board register the same descriptions, so the palette lists one row per key.
function useArrowKeys(enabled: boolean, move: (dir: Direction) => void) {
  useShortcut({ key: "ArrowLeft", description: "Select the agent to the left", enabled }, () => move("left"));
  useShortcut({ key: "ArrowRight", description: "Select the agent to the right", enabled }, () => move("right"));
  useShortcut({ key: "ArrowUp", description: "Select the agent above", enabled }, () => move("up"));
  useShortcut({ key: "ArrowDown", description: "Select the agent below", enabled }, () => move("down"));
}

/**
 * Arrow keys move the selection to the nearest agent card in that direction. With nothing
 * selected, the first press selects the card nearest the middle of the view.
 */
export function useSpatialNav(nodes: LayoutNode[], selectedId: string | undefined, select: Select, active = true) {
  const { getInternalNode } = useReactFlow();
  const store = useStoreApi();

  // Agents the status filter fades out are skipped, as they are in Needs you cycling.
  const agentIds = nodes.flatMap((n) =>
    n.type === "pane" && n.data.pane.agent && !n.className?.includes("status-filtered") ? [n.id] : [],
  );

  const move = (dir: Direction) => {
    const cards: Box[] = [];
    for (const id of agentIds) {
      const node = getInternalNode(id);
      if (!node) continue;
      const { x, y } = node.internals.positionAbsolute;
      cards.push({ id, x, y, w: node.measured.width ?? node.width ?? 0, h: node.measured.height ?? node.height ?? 0 });
    }
    const from = cards.find((c) => c.id === selectedId);
    let next: string | undefined;
    if (from) {
      next = nearestInDirection(from, cards, dir);
    } else {
      const { width, height, transform } = store.getState();
      const [tx, ty, zoom] = transform;
      next = nearestToPoint({ x: (width / 2 - tx) / zoom, y: (height / 2 - ty) / zoom }, cards);
    }
    if (next) select(next, { keepZoom: true });
  };

  useArrowKeys(active && agentIds.length > 0, move);
}

/** Arrow keys on the board: up and down within a column, left and right across columns. */
export function useBoardNav(columns: string[][], selectedId: string | undefined, select: Select, active: boolean) {
  useArrowKeys(active && columns.some((c) => c.length > 0), (dir) => {
    const next = moveOnBoard(columns, selectedId, dir);
    if (next) select(next, { keepZoom: true });
  });
}

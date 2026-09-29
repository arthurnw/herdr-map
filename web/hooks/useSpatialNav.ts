import { useReactFlow, useStoreApi, type Node } from "@xyflow/react";
import type { PaneData } from "../layout.ts";
import { nearestInDirection, nearestToPoint, type Box, type Direction } from "../spatial.ts";
import { useShortcut } from "./useShortcut.ts";

/**
 * Arrow keys move the selection to the nearest agent card in that direction. With nothing
 * selected, the first press selects the card nearest the middle of the view.
 */
export function useSpatialNav(nodes: Node[], selectedId: string | undefined, select: (paneId: string) => void) {
  const { getInternalNode } = useReactFlow();
  const store = useStoreApi();

  // Agents the status filter fades out are skipped, as they are in Needs you cycling.
  const agentIds = nodes
    .filter((n) => n.type === "pane" && (n.data as PaneData).pane.agent && !n.className?.includes("status-filtered"))
    .map((n) => n.id);

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
    if (next) select(next);
  };

  const enabled = agentIds.length > 0;
  useShortcut({ key: "ArrowLeft", description: "Select the agent to the left", enabled }, () => move("left"));
  useShortcut({ key: "ArrowRight", description: "Select the agent to the right", enabled }, () => move("right"));
  useShortcut({ key: "ArrowUp", description: "Select the agent above", enabled }, () => move("up"));
  useShortcut({ key: "ArrowDown", description: "Select the agent below", enabled }, () => move("down"));
}

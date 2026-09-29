import { useCallback, useMemo, useState } from "react";
import { useReactFlow, type Node } from "@xyflow/react";
import type { Located } from "../state.ts";

/** The hovered and pinned (selected) panes, and the map nodes with the selection outlined. */
export function useSelection(panes: Map<string, Located>, nodes: Node[]) {
  const [hovered, setHovered] = useState<string>();
  const [pinned, setPinned] = useState<string>();
  const { getInternalNode, getZoom, setCenter } = useReactFlow();

  // A pinned pane holds the preview until unpinned or closed; otherwise it follows the pointer.
  const pinnedPane = pinned ? panes.get(pinned) : undefined;
  const detailPane = pinnedPane ?? (hovered ? panes.get(hovered) : undefined);

  // Selecting an agent pins its preview and pans the map to it, zooming in only when
  // it would be too small to read. Arrow-key movement keeps the zoom so stepping
  // between cards doesn't jump in and out.
  const select = useCallback(
    (paneId: string, options: { keepZoom?: boolean } = {}) => {
      setPinned(paneId);
      const node = getInternalNode(paneId);
      if (!node) return;
      const { x, y } = node.internals.positionAbsolute;
      setCenter(x + (node.width ?? 0) / 2, y + (node.height ?? 0) / 2, {
        zoom: options.keepZoom ? getZoom() : Math.max(getZoom(), 0.9),
        duration: 350,
      });
    },
    [getInternalNode, getZoom, setCenter],
  );

  const clear = useCallback(() => {
    setPinned(undefined);
    setHovered(undefined);
  }, []);

  // Outline the selected agent so it's easy to find after the map pans to it.
  const shownNodes = useMemo(
    () =>
      pinned
        ? nodes.map((n) => (n.id === pinned ? { ...n, className: [n.className, "selected-pane"].filter(Boolean).join(" ") } : n))
        : nodes,
    [nodes, pinned],
  );

  return { hovered, setHovered, pinned, setPinned, select, clear, pinnedPane, detailPane, shownNodes };
}

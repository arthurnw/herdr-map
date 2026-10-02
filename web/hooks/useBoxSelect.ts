import { useCallback, useMemo, useRef, useState } from "react";
import { useReactFlow, type Node } from "@xyflow/react";
import { boxesTouching, rectFromPoints, type Box } from "../spatial.ts";
import { useShortcut } from "./useShortcut.ts";

const NONE: ReadonlySet<string> = new Set();

/**
 * Shift+drag on empty canvas, or on a repo box, draws a selection box, and the workspaces
 * it touches become selected. Esc, a click on empty canvas, or a Shift+click without a drag
 * clears the selection. `selected` holds workspace node IDs.
 */
export function useBoxSelect<N extends Node>(nodes: N[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(NONE);
  // The box being drawn, in client coordinates.
  const [box, setBox] = useState<Omit<Box, "id">>();
  const { getNodes, screenToFlowPosition } = useReactFlow();
  // The click that follows the mouseup of a drawn box must not clear it.
  const justDrew = useRef(false);

  const onMouseDownCapture = useCallback(
    (e: React.MouseEvent) => {
      if (!e.shiftKey || e.button !== 0) return;
      const { target } = e;
      if (!(target instanceof Element) || !target.closest(".react-flow__pane")) return;
      const node = target.closest(".react-flow__node");
      if (node && !node.classList.contains("react-flow__node-group-box")) return;
      // Keeps React Flow from starting a pan or a repo-box drag.
      e.stopPropagation();
      e.preventDefault();

      const start = { x: e.clientX, y: e.clientY };
      const workspaces: Box[] = getNodes()
        .filter((n) => n.type === "workspace")
        .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 }));
      const update = (ev: MouseEvent) => {
        const r = rectFromPoints(start, { x: ev.clientX, y: ev.clientY });
        setBox(r);
        const a = screenToFlowPosition({ x: r.x, y: r.y });
        const b = screenToFlowPosition({ x: r.x + r.w, y: r.y + r.h });
        setSelected(new Set(boxesTouching(rectFromPoints(a, b), workspaces)));
      };
      const end = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", update);
        window.removeEventListener("mouseup", end);
        setBox(undefined);
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) setSelected(NONE);
        justDrew.current = true;
        setTimeout(() => (justDrew.current = false), 0);
      };
      window.addEventListener("mousemove", update);
      window.addEventListener("mouseup", end);
    },
    [getNodes, screenToFlowPosition],
  );

  const clear = useCallback(() => setSelected(NONE), []);
  const onPaneClick = useCallback(() => {
    if (!justDrew.current) clear();
  }, [clear]);

  useShortcut({ key: "Escape", description: "Clear box selection", enabled: selected.size > 0 }, clear);

  const marked = useMemo(
    () =>
      selected.size === 0
        ? nodes
        : nodes.map((n) => (selected.has(n.id) ? { ...n, className: [n.className, "box-selected"].filter(Boolean).join(" ") } : n)),
    [nodes, selected],
  );

  return { nodes: marked, selected, box, onMouseDownCapture, onPaneClick, clear };
}

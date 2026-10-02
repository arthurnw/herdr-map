// Edges routed between card rects instead of fixed handles: lineage edges here, and the
// user's links in links.tsx.
import { memo, useCallback, useMemo } from "react";
import { BaseEdge, useStore, type EdgeProps, type InternalNode, type ReactFlowState } from "@xyflow/react";
import { routeEdge, type Route } from "./edge-route.ts";
import type { Rect } from "./layout.ts";

// Pane cards are children of tab nodes, so their own positions are relative to the tab.
export const nodeRect = (n: InternalNode): Rect => ({
  x: n.internals.positionAbsolute.x,
  y: n.internals.positionAbsolute.y,
  w: n.measured.width ?? n.width ?? 0,
  h: n.measured.height ?? n.height ?? 0,
});

type CardRect = Rect & { id: string };
type EdgeRects = { source?: Rect; target?: Rect; others: CardRect[] };

const sameRect = (a: Rect | undefined, b: Rect | undefined) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

// Store updates arrive on every pan, zoom, and data change, so the route is recomputed only
// when a card actually moves or resizes.
const sameEdgeRects = (a: EdgeRects, b: EdgeRects) =>
  sameRect(a.source, b.source) &&
  sameRect(a.target, b.target) &&
  a.others.length === b.others.length &&
  a.others.every((r, i) => r.id === b.others[i].id && sameRect(r, b.others[i]));

/** The route of an edge between two nodes, around the other agent cards on the map. */
export function useRoute(source: string, target: string): Route | undefined {
  const select = useCallback(
    (s: ReactFlowState): EdgeRects => {
      const from = s.nodeLookup.get(source);
      const to = s.nodeLookup.get(target);
      const others: CardRect[] = [];
      for (const n of s.nodeLookup.values()) {
        if (n.type === "pane" && !n.hidden && n.id !== source && n.id !== target) others.push({ id: n.id, ...nodeRect(n) });
      }
      return { source: from && nodeRect(from), target: to && nodeRect(to), others };
    },
    [source, target],
  );
  const rects = useStore(select, sameEdgeRects);
  return useMemo(
    () => (rects.source && rects.target ? routeEdge(rects.source, rects.target, rects.others) : undefined),
    [rects],
  );
}

/** A faint line from a parent agent to the agent it started, routed like a link. */
export const LineageEdge = memo(({ id, source, target, markerEnd, style, interactionWidth }: EdgeProps) => {
  const route = useRoute(source, target);
  if (!route) return null;
  return <BaseEdge id={id} path={route.path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />;
});

export const lineageEdgeTypes = { lineage: LineageEdge };

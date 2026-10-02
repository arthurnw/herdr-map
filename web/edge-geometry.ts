// Where a link edge meets its two cards: on the sides that face each other, so the edge
// runs through the gap between the cards instead of looping around them.
import type { Rect } from "./layout.ts";

export type Side = "top" | "right" | "bottom" | "left";

export interface Anchor {
  x: number;
  y: number;
  side: Side;
}

/** How far apart two spans are: positive for a gap, negative for an overlap. */
const spanGap = (a0: number, a1: number, b0: number, b1: number) => Math.max(b0 - a1, a0 - b1);

/** The side of `a` that faces `b`, and the side of `b` that faces `a`. */
export function facingSides(a: Rect, b: Rect): [Side, Side] {
  const gapX = spanGap(a.x, a.x + a.w, b.x, b.x + b.w);
  const gapY = spanGap(a.y, a.y + a.h, b.y, b.y + b.h);
  if (gapY > gapX) return b.y + b.h / 2 >= a.y + a.h / 2 ? ["bottom", "top"] : ["top", "bottom"];
  return b.x + b.w / 2 >= a.x + a.w / 2 ? ["right", "left"] : ["left", "right"];
}

/** Where along each side the edge attaches: the middle of the shared span when the sides overlap, else each side's middle. */
function along(a0: number, a1: number, b0: number, b1: number): [number, number] {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  if (lo <= hi) return [(lo + hi) / 2, (lo + hi) / 2];
  return [(a0 + a1) / 2, (b0 + b1) / 2];
}

function edgeOf(r: Rect, side: Side): number {
  if (side === "top") return r.y;
  if (side === "bottom") return r.y + r.h;
  if (side === "left") return r.x;
  return r.x + r.w;
}

export const isVertical = (side: Side) => side === "top" || side === "bottom";

/** Where on its side `side` of `r` an edge meets it, given the point along that side. */
const onSide = (r: Rect, side: Side, at: number): Anchor =>
  isVertical(side) ? { x: at, y: edgeOf(r, side), side } : { x: edgeOf(r, side), y: at, side };

/**
 * The start and end points of an edge that leaves `source` from `from` and enters `target`
 * at `to`. Parallel sides line up where their spans overlap; other pairs use each side's middle.
 */
export function anchorsFor(source: Rect, target: Rect, [from, to]: [Side, Side]): { source: Anchor; target: Anchor } {
  const spanOf = (r: Rect, side: Side): [number, number] => (isVertical(side) ? [r.x, r.x + r.w] : [r.y, r.y + r.h]);
  const [s0, s1] = spanOf(source, from);
  const [t0, t1] = spanOf(target, to);
  const [sa, ta] = isVertical(from) === isVertical(to) ? along(s0, s1, t0, t1) : [(s0 + s1) / 2, (t0 + t1) / 2];
  return { source: onSide(source, from, sa), target: onSide(target, to, ta) };
}

/** The start and end points of an edge from `source` to `target`. */
export function attachEdge(source: Rect, target: Rect): { source: Anchor; target: Anchor } {
  return anchorsFor(source, target, facingSides(source, target));
}

/** The start and end points of an edge from `source` to a bare point, such as the pointer while a link is drawn. */
export function attachToPoint(source: Rect, point: { x: number; y: number }): { source: Anchor; target: Anchor } {
  return attachEdge(source, { x: point.x, y: point.y, w: 0, h: 0 });
}

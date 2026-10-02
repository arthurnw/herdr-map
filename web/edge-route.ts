// The path an edge between two cards takes: a curve between the sides that face each other
// when nothing is in the way, else the curve or right-angled path that crosses the fewest
// other cards.
import { anchorsFor, attachEdge, isVertical as vertical, type Anchor, type Side } from "./edge-geometry.ts";
import type { Rect } from "./layout.ts";

type Point = { x: number; y: number };
type Ends = { source: Anchor; target: Anchor };

export interface Route extends Ends {
  path: string;
  /** Where a label goes: the curve's midpoint, or halfway along a right-angled path. */
  label: Point;
}

// Same control points as React Flow's `getBezierPath` with its default curvature, so a link
// looks as it did before routing, and the crossing check samples the curve that is drawn.
const CURVATURE = 0.25;
const controlOffset = (distance: number) => (distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance));

function control(side: Side, from: Point, to: Point): Point {
  if (side === "left") return { x: from.x - controlOffset(from.x - to.x), y: from.y };
  if (side === "right") return { x: from.x + controlOffset(to.x - from.x), y: from.y };
  if (side === "top") return { x: from.x, y: from.y - controlOffset(from.y - to.y) };
  return { x: from.x, y: from.y + controlOffset(to.y - from.y) };
}

function bezierControls(ends: Ends): [Point, Point, Point, Point] {
  const { source: s, target: t } = ends;
  return [s, control(s.side, s, t), control(t.side, t, s), t];
}

/** The curve between two anchors, leaving and entering each card square to its side. */
export function bezierRoute(ends: Ends): Route {
  const [s, c1, c2, t] = bezierControls(ends);
  return {
    ...ends,
    path: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`,
    label: {
      x: s.x * 0.125 + c1.x * 0.375 + c2.x * 0.375 + t.x * 0.125,
      y: s.y * 0.125 + c1.y * 0.375 + c2.y * 0.375 + t.y * 0.125,
    },
  };
}

const SAMPLES = 32;

function bezierPoints(ends: Ends): Point[] {
  const [p0, p1, p2, p3] = bezierControls(ends);
  const out: Point[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return out;
}

/** Whether the segment from `a` to `b` passes through the inside of `r`, not just along its border. */
function segmentHits(a: Point, b: Point, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    return t0 < t1;
  };
  return (
    clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y) && t1 - t0 > 1e-9
  );
}

/** How many of `rects` the polyline through `points` passes through. */
function crossings(points: Point[], rects: Rect[]): number {
  let n = 0;
  for (const r of rects) {
    for (let i = 1; i < points.length; i++) {
      if (segmentHits(points[i - 1], points[i], r)) {
        n++;
        break;
      }
    }
  }
  return n;
}

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 });

const length = (points: Point[]) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);

// Clearance kept from other cards, and the shortest leg out of or into a card.
const MARGIN = 4;
const STUB = 8;
const CORNER = 8;

/** +1 when leaving `side` moves along increasing x or y, else -1. */
const outward = (side: Side) => (side === "bottom" || side === "right" ? 1 : -1);

/** The sides of `a` toward `b`: across, then up or down. */
function sidesToward(a: Rect, b: Rect): [Side, Side] {
  return [b.x + b.w / 2 >= a.x + a.w / 2 ? "right" : "left", b.y + b.h / 2 >= a.y + a.h / 2 ? "bottom" : "top"];
}

/**
 * Right-angled paths between the four side pairs that face each other's way: one bend for a
 * side across and a side up or down, two bends through a channel for parallel sides. Channels
 * run just past the card edges, where the gaps between cards, tabs, and workspaces are.
 */
function orthogonalCandidates(source: Rect, target: Rect, obstacles: readonly Rect[]): { ends: Ends; points: Point[] }[] {
  const out: { ends: Ends; points: Point[] }[] = [];
  const all = [source, target, ...obstacles];
  for (const from of sidesToward(source, target)) {
    for (const to of sidesToward(target, source)) {
      const ends = anchorsFor(source, target, [from, to]);
      const { source: s, target: t } = ends;
      if (vertical(from) !== vertical(to)) {
        // One bend: along the source's direction until level with the target's anchor.
        const corner = vertical(from) ? { x: s.x, y: t.y } : { x: t.x, y: s.y };
        const leg1 = vertical(from) ? (corner.y - s.y) * outward(from) : (corner.x - s.x) * outward(from);
        const leg2 = vertical(to) ? (corner.y - t.y) * outward(to) : (corner.x - t.x) * outward(to);
        if (leg1 >= STUB && leg2 >= STUB) out.push({ ends, points: [s, corner, t] });
        continue;
      }
      const axis = vertical(from) ? "y" : "x";
      const size = axis === "y" ? "h" : "w";
      const channels = new Set<number>([(s[axis] + t[axis]) / 2, s[axis] + outward(from) * STUB * 2, t[axis] + outward(to) * STUB * 2]);
      for (const r of all) {
        channels.add(r[axis] - MARGIN * 2);
        channels.add(r[axis] + r[size] + MARGIN * 2);
      }
      for (const m of channels) {
        if ((m - s[axis]) * outward(from) < STUB || (m - t[axis]) * outward(to) < STUB) continue;
        const bends = axis === "y" ? [{ x: s.x, y: m }, { x: t.x, y: m }] : [{ x: m, y: s.y }, { x: m, y: t.y }];
        out.push({ ends, points: [s, ...bends, t] });
      }
    }
  }
  return out;
}

/** A right-angled path through `points`, with rounded corners. */
function orthogonalRoute(points: Point[], ends: Ends): Route {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [prev, p, next] = [points[i - 1], points[i], points[i + 1]];
    const lenIn = Math.hypot(p.x - prev.x, p.y - prev.y);
    const lenOut = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(CORNER, lenIn / 2, lenOut / 2);
    if (r === 0) continue;
    const a = { x: p.x - ((p.x - prev.x) / lenIn) * r, y: p.y - ((p.y - prev.y) / lenIn) * r };
    const b = { x: p.x + ((next.x - p.x) / lenOut) * r, y: p.y + ((next.y - p.y) / lenOut) * r };
    d += ` L${a.x},${a.y} Q${p.x},${p.y} ${b.x},${b.y}`;
  }
  const last = points.at(-1)!;
  d += ` L${last.x},${last.y}`;
  return { ...ends, path: d, label: pointAlong(points, length(points) / 2) };
}

function pointAlong(points: Point[], at: number): Point {
  let left = at;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len && len > 0) return { x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len };
    left -= len;
  }
  return points.at(-1)!;
}

/**
 * Routes an edge from `source` to `target` around `obstacles` (the other cards on the map).
 * The curve between the facing sides wins whenever it crosses nothing, so adjacent cards keep
 * their short, direct edge. Otherwise the other curves toward the target are tried, and then
 * right-angled paths; the fewest cards crossed wins, then the shorter path, then the earlier
 * candidate, so the same rects always give the same route.
 */
export function routeEdge(source: Rect, target: Rect, obstacles: readonly Rect[]): Route {
  const direct = attachEdge(source, target);
  // Overlapping cards, such as one dropped onto another, have no way around each other.
  if (obstacles.length === 0 || overlap(source, target)) return bezierRoute(direct);
  // The end cards count too, so a path can't cut back through them; they aren't inflated,
  // since every path starts and ends on their borders.
  const rects = [source, target, ...obstacles.map((r) => inflate(r, MARGIN))];

  let best = { route: direct, crossed: crossings(bezierPoints(direct), rects) };
  if (best.crossed === 0) return bezierRoute(direct);
  for (const from of sidesToward(source, target)) {
    for (const to of sidesToward(target, source)) {
      const ends = anchorsFor(source, target, [from, to]);
      const crossed = crossings(bezierPoints(ends), rects);
      if (crossed < best.crossed) best = { route: ends, crossed };
    }
  }
  if (best.crossed === 0) return bezierRoute(best.route);

  const paths = orthogonalCandidates(source, target, obstacles)
    .map((c, i) => ({ ...c, len: length(c.points), i }))
    .sort((a, b) => a.len - b.len || a.i - b.i);
  let detour: { ends: Ends; points: Point[]; crossed: number } | undefined;
  for (const c of paths) {
    const crossed = crossings(c.points, rects);
    if (crossed < (detour?.crossed ?? best.crossed)) detour = { ...c, crossed };
    if (crossed === 0) break;
  }
  return detour ? orthogonalRoute(detour.points, detour.ends) : bezierRoute(best.route);
}

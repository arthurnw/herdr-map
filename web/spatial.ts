// Picks the card to move to with the arrow keys, from the cards' positions on the canvas.

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Direction = "left" | "right" | "up" | "down";

/** The distance between two ranges on one axis, or 0 when they overlap. */
function gap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, b0 - a1, a0 - b1);
}

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/**
 * The nearest box in `dir` from `from`, or undefined when there is none. Boxes that start
 * past `from`'s far edge come first; when there are none, any box whose center lies past
 * `from`'s center counts, so a key still reaches a card that sits off at an angle.
 * Among candidates, boxes that line up with `from` (overlap it across the direction of
 * travel) win over closer ones off to the side, and center distance breaks ties.
 */
export function nearestInDirection(from: Box, boxes: Box[], dir: Direction): string | undefined {
  const horizontal = dir === "left" || dir === "right";
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  const c0 = center(from);
  // Edges along the direction of travel, flipped so that "further" is always larger.
  const span = (b: Box) => {
    const [lo, hi] = horizontal ? [b.x, b.x + b.w] : [b.y, b.y + b.h];
    return sign > 0 ? { near: lo, far: hi } : { near: -hi, far: -lo };
  };
  // A box may start up to a quarter of `from`'s size before `from` ends and still count as past it.
  const slack = (horizontal ? from.w : from.h) / 4;
  const pick = (strict: boolean) => {
    let best: { id: string; score: number; dist: number } | undefined;
    for (const b of boxes) {
      if (b.id === from.id) continue;
      const c = center(b);
      if (strict ? span(b).near < span(from).far - slack : (horizontal ? c.x - c0.x : c.y - c0.y) * sign <= 0) continue;
      const along = horizontal ? gap(from.x, from.x + from.w, b.x, b.x + b.w) : gap(from.y, from.y + from.h, b.y, b.y + b.h);
      const across = horizontal ? gap(from.y, from.y + from.h, b.y, b.y + b.h) : gap(from.x, from.x + from.w, b.x, b.x + b.w);
      const score = along + across * 3;
      const dist = Math.hypot(c.x - c0.x, c.y - c0.y);
      if (!best || score < best.score || (score === best.score && dist < best.dist)) best = { id: b.id, score, dist };
    }
    return best?.id;
  };
  return pick(true) ?? pick(false);
}

/** The box nearest a point: 0 when the point is inside it, then by center distance. */
export function nearestToPoint(point: { x: number; y: number }, boxes: Box[]): string | undefined {
  let best: { id: string; edge: number; dist: number } | undefined;
  for (const b of boxes) {
    const edge = Math.hypot(gap(point.x, point.x, b.x, b.x + b.w), gap(point.y, point.y, b.y, b.y + b.h));
    const c = center(b);
    const dist = Math.hypot(c.x - point.x, c.y - point.y);
    if (!best || edge < best.edge || (edge === best.edge && dist < best.dist)) best = { id: b.id, edge, dist };
  }
  return best?.id;
}

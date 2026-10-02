import assert from "node:assert/strict";
import { test } from "node:test";
import { attachEdge } from "../web/edge-geometry.ts";
import { bezierRoute, routeEdge, type Route } from "../web/edge-route.ts";
import type { Rect } from "../web/layout.ts";

const rect = (x: number, y: number, w = 276, h = 116): Rect => ({ x, y, w, h });

// The e2e fixture's first row: three workspaces side by side, with two stacked cards in the
// middle one, and a second row of workspaces below.
const parent = rect(26, 110);
const child = rect(666, 110);
const between = [rect(346, 110, 276, 72), rect(346, 186, 276, 72)];
const below = [rect(26, 442), rect(346, 442)];

/** The corners of a right-angled route, from its path. */
function corners(route: Route): { x: number; y: number }[] {
  const nums = route.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const out = [];
  for (let i = 0; i < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1] });
  return out;
}

const inside = (p: { x: number; y: number }, r: Rect) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;

test("with nothing in the way, the edge is the curve between the facing sides", () => {
  const direct = bezierRoute(attachEdge(parent, child));
  assert.deepEqual(routeEdge(parent, child, []), direct);
  assert.deepEqual(routeEdge(parent, child, below), direct);
  // Stacked cards a few pixels apart keep their short edge straight down.
  const [upper, lower] = between;
  assert.deepEqual(routeEdge(upper, lower, [parent, child, ...below]), bezierRoute(attachEdge(upper, lower)));
});

test("a card between the two ends sends the edge around it", () => {
  const route = routeEdge(parent, child, [...between, ...below]);
  assert.ok(!route.path.includes("C"), `the curves all cross the middle cards, so the path should be right-angled: ${route.path}`);
  assert.deepEqual([route.source.side, route.target.side], ["bottom", "bottom"]);
  const points = corners(route);
  // Every leg is horizontal or vertical, so checking along each leg covers the whole path.
  for (let i = 1; i < points.length; i++) {
    for (let t = 0; t <= 1; t += 0.05) {
      const p = { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t };
      for (const r of [parent, child, ...between, ...below]) assert.ok(!inside(p, r), `${JSON.stringify(p)} is inside ${JSON.stringify(r)}`);
    }
  }
  // It runs below the stacked cards, above the next row.
  const lowest = Math.max(...points.map((p) => p.y));
  assert.ok(lowest > 258 && lowest < 442, `the detour should pass between the rows: ${route.path}`);
});

test("when the facing curve crosses a card, the side pair that crosses fewest wins", () => {
  const a = rect(0, 0, 100, 50);
  const b = rect(300, 300, 100, 50);
  // Facing sides are bottom to top, and that curve's middle is at (200, 175).
  assert.deepEqual([attachEdge(a, b).source.side, attachEdge(a, b).target.side], ["bottom", "top"]);
  const route = routeEdge(a, b, [rect(150, 150, 100, 50)]);
  assert.ok(route.path.includes("C"), `a curve that clears the card should be kept: ${route.path}`);
  assert.deepEqual([route.source.side, route.target.side], ["right", "top"]);
});

test("the same cards always give the same route", () => {
  const obstacles = [...between, ...below];
  const first = routeEdge(parent, child, obstacles);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(routeEdge({ ...parent }, { ...child }, obstacles.map((r) => ({ ...r }))), first);
  }
});

test("overlapping cards keep the direct curve", () => {
  const a = rect(0, 0, 100, 50);
  const b = rect(60, 30, 100, 50);
  assert.deepEqual(routeEdge(a, b, [rect(200, 0, 100, 50)]), bezierRoute(attachEdge(a, b)));
});

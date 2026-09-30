import assert from "node:assert/strict";
import { test } from "node:test";
import { attachEdge, facingSides } from "../web/edge-geometry.ts";
import type { Rect } from "../web/layout.ts";

const rect = (x: number, y: number, w = 280, h = 72): Rect => ({ x, y, w, h });

// Two compact agent rows in one tab: same column, 4px apart.
const upper = rect(0, 0);
const lower = rect(0, 76);

test("stacked cards attach bottom to top, straight down the shared column", () => {
  assert.deepEqual(attachEdge(upper, lower), {
    source: { x: 140, y: 72, side: "bottom" },
    target: { x: 140, y: 76, side: "top" },
  });
});

test("a target above attaches top to bottom", () => {
  assert.deepEqual(attachEdge(lower, upper), {
    source: { x: 140, y: 76, side: "top" },
    target: { x: 140, y: 72, side: "bottom" },
  });
});

test("side-by-side cards attach right to left, or left to right", () => {
  const left = rect(0, 0);
  const right = rect(300, 20);
  // The rows overlap from y 20 to 72, so both ends sit at its middle.
  assert.deepEqual(attachEdge(left, right), {
    source: { x: 280, y: 46, side: "right" },
    target: { x: 300, y: 46, side: "left" },
  });
  assert.deepEqual(facingSides(right, left), ["left", "right"]);
});

test("diagonal cards use the axis with the wider gap and each side's middle", () => {
  const a = rect(0, 0, 100, 50);
  // 20px apart across, 200px apart down.
  const b = rect(120, 250, 100, 50);
  assert.deepEqual(attachEdge(a, b), {
    source: { x: 50, y: 50, side: "bottom" },
    target: { x: 170, y: 250, side: "top" },
  });
  // 200px apart across, 20px apart down.
  assert.deepEqual(facingSides(a, rect(300, 70, 100, 50)), ["right", "left"]);
});

test("overlapping cards use the axis they overlap less on", () => {
  const a = rect(0, 0, 100, 50);
  assert.deepEqual(facingSides(a, rect(10, 30, 100, 50)), ["bottom", "top"]);
  assert.deepEqual(facingSides(a, rect(-70, 5, 100, 50)), ["left", "right"]);
});

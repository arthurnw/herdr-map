import assert from "node:assert/strict";
import { test } from "node:test";
import { nearestInDirection, nearestToPoint, type Box } from "../web/spatial.ts";

const box = (id: string, x: number, y: number, w = 100, h = 50): Box => ({ id, x, y, w, h });

// Two columns of stacked cards, like two compact workspaces side by side, plus one far
// below the left column:
//   a1  b1
//   a2  b2
//   a3
//
//   c
const a1 = box("a1", 0, 0);
const a2 = box("a2", 0, 50);
const a3 = box("a3", 0, 100);
const b1 = box("b1", 140, 0);
const b2 = box("b2", 140, 50);
const c = box("c", 0, 400);
const all = [a1, a2, a3, b1, b2, c];

test("moves to the adjacent card in each direction", () => {
  assert.equal(nearestInDirection(a2, all, "right"), "b2");
  assert.equal(nearestInDirection(b2, all, "left"), "a2");
  assert.equal(nearestInDirection(a2, all, "up"), "a1");
  assert.equal(nearestInDirection(a2, all, "down"), "a3");
});

test("returns undefined at the edge", () => {
  assert.equal(nearestInDirection(a1, all, "up"), undefined);
  assert.equal(nearestInDirection(a1, all, "left"), undefined);
  assert.equal(nearestInDirection(b1, all, "right"), undefined);
});

test("prefers a card in line over a closer one off to the side", () => {
  // From a3, right: b2 sits a row up and is the only card to the right.
  assert.equal(nearestInDirection(a3, all, "right"), "b2");
  // From b2, down: nothing overlaps b2's column below it, so the nearest card off to the side wins.
  assert.equal(nearestInDirection(b2, all, "down"), "a3");
  // In line but farther beats diagonal but nearer.
  const from = box("from", 0, 0);
  const inLine = box("inLine", 300, 0);
  const diagonal = box("diagonal", 120, 120);
  assert.equal(nearestInDirection(from, [from, inLine, diagonal], "right"), "inLine");
});

test("a card below beats one to the side that overlaps the start vertically", () => {
  // Like an agent in one workspace, the second agent in the next workspace, and an agent
  // in the workspace below.
  const from = box("from", 0, 0, 300, 127);
  const beside = box("beside", 350, 83, 300, 79);
  const below = box("below", 0, 363, 300, 127);
  assert.equal(nearestInDirection(from, [from, beside, below], "down"), "below");
  assert.equal(nearestInDirection(from, [from, beside, below], "right"), "beside");
  assert.equal(nearestInDirection(below, [from, beside, below], "up"), "from");
});

test("skips cards whose center isn't past the start in that direction", () => {
  // Side-by-side panes share a center row, so neither is above or below the other.
  const left = box("left", 0, 0);
  const right = box("right", 100, 0);
  assert.equal(nearestInDirection(left, [left, right], "down"), undefined);
  assert.equal(nearestInDirection(left, [left, right], "right"), "right");
});

test("nearestToPoint picks the card under or closest to a point", () => {
  assert.equal(nearestToPoint({ x: 150, y: 60 }, all), "b2");
  assert.equal(nearestToPoint({ x: 50, y: 300 }, all), "c");
  assert.equal(nearestToPoint({ x: 0, y: 0 }, []), undefined);
});

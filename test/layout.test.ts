import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFleet, StatusClock } from "../shared/model.ts";
import { isDetachedDrop, layoutFleet } from "../web/layout.ts";
import { snapshotFixture } from "./fixtures.ts";

function fleet() {
  const snap = snapshotFixture();
  return buildFleet(snap, new StatusClock().observe(snap.agents, 1000));
}

test("agentsOnly hides workspaces without agents", () => {
  const all = layoutFleet(fleet(), { agentsOnly: false });
  const agents = layoutFleet(fleet(), { agentsOnly: true });
  assert.ok(all.nodes.some((n) => n.id === "ws:w3"));
  assert.ok(!agents.nodes.some((n) => n.id === "ws:w3" || n.id === "group:__other__"));
});

test("every child node follows its parent in node order", () => {
  const { nodes } = layoutFleet(fleet(), { agentsOnly: false });
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.parentId) assert.ok(seen.has(n.parentId), `${n.id} before ${n.parentId}`);
    seen.add(n.id);
  }
});

test("draws a lineage edge from the parent token", () => {
  const { edges } = layoutFleet(fleet(), { agentsOnly: true });
  assert.deepEqual(
    edges.map((e) => [e.source, e.target]),
    [["w1:p1", "w2:p1"]],
  );
});

test("saved positions override the automatic layout and group boxes follow members", () => {
  const { nodes } = layoutFleet(fleet(), { agentsOnly: true }, { w1: { x: 1000, y: 500 }, w2: { x: 2000, y: 500 } });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.deepEqual(byId.get("ws:w1")?.position, { x: 1000, y: 500 });
  const group = byId.get("group:/r/api/.git")!;
  assert.ok(group.position.x < 1000 && group.position.y < 500);
  assert.ok(group.position.x + group.width! > 2000);
});

test("a detached workspace leaves its group box", () => {
  const { nodes } = layoutFleet(fleet(), { agentsOnly: true }, { w1: { x: 0, y: 100 }, w2: { x: 5000, y: 5000, detached: true } });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const group = byId.get("group:/r/api/.git")!;
  assert.ok(group.position.x + group.width! < 5000);
  assert.deepEqual((group.data as { memberIds: string[] }).memberIds, ["w1"]);
  assert.equal((byId.get("ws:w2")!.data as { detached: boolean }).detached, true);
});

test("a new workspace in a saved layout goes to the right of its group", () => {
  const { nodes } = layoutFleet(fleet(), { agentsOnly: true }, { w1: { x: 100, y: 200 } });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const w1 = byId.get("ws:w1")!;
  const w2 = byId.get("ws:w2")!;
  assert.equal(w2.position.y, 200);
  assert.ok(w2.position.x >= 100 + w1.width!);
});

test("isDetachedDrop detaches only when clear of the other members", () => {
  const member = { x: 0, y: 0, w: 300, h: 200 };
  assert.equal(isDetachedDrop({ x: 320, y: 0, w: 300, h: 200 }, [member]), false);
  assert.equal(isDetachedDrop({ x: 2000, y: 0, w: 300, h: 200 }, [member]), true);
  assert.equal(isDetachedDrop({ x: 2000, y: 0, w: 300, h: 200 }, []), false);
});

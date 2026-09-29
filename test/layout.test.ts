import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFleet, StatusClock } from "../shared/model.ts";
import { layoutFleet } from "../web/layout.ts";
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

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

test("agentPanesOnly keeps only agent panes, as equal rows, and drops agentless tabs", () => {
  const f = fleet();
  // Give the lead tab a second agent to the left of the first one.
  const tab = f.groups[0].workspaces[0].tabs[0];
  tab.panes[0].rect = { x: 0.2, y: 0, w: 0.4, h: 1 };
  tab.panes.push({
    id: "w1:p3",
    rect: { x: 0, y: 0, w: 0.2, h: 1 },
    title: "codex",
    focused: false,
    agent: { kind: "codex", status: "idle", since: 0, sinceApprox: false },
  });
  const { nodes } = layoutFleet(f, { agentsOnly: false, agentPanesOnly: true });
  const panes = nodes.filter((n) => n.type === "pane" && n.parentId === "tab:w1:t1");
  assert.deepEqual(
    panes.map((n) => n.id),
    ["w1:p3", "w1:p1"],
  );
  assert.equal(panes[0].height, panes[1].height);
  assert.equal(panes[0].width, panes[1].width);
  assert.ok(panes[1].position.y > panes[0].position.y, "the second agent sits below the first");
  assert.ok(!nodes.some((n) => n.id === "w1:p2"), "the hunk pane is hidden");
  assert.ok(!nodes.some((n) => n.id === "ws:w3"), "a workspace with no agents has nothing to draw");
});

test("hiddenStatuses removes those agents, and agentsOnly ignores them", () => {
  // In the fixture, w1 has a working agent and w2 a blocked one.
  const compact = layoutFleet(fleet(), { agentsOnly: true, agentPanesOnly: true, hiddenStatuses: ["blocked"] });
  assert.ok(compact.nodes.some((n) => n.id === "w1:p1"));
  assert.ok(!compact.nodes.some((n) => n.id === "w2:p1" || n.id === "ws:w2"));

  // The full layout keeps filtered agents in place but marks them.
  const full = layoutFleet(fleet(), { agentsOnly: false, hiddenStatuses: ["blocked"] });
  assert.equal(full.nodes.find((n) => n.id === "w2:p1")?.className, "status-filtered");
  assert.equal(full.nodes.find((n) => n.id === "w1:p1")?.className, undefined);
});

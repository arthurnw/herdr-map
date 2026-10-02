import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFleet, StatusClock } from "../shared/model.ts";
import { isDetachedDrop, layoutFleet, snapCard, WS_HEADER, type LayoutNode, type LayoutNodeOf, type LayoutOptions } from "../web/layout.ts";
import { fleetWith, snapshotFixture } from "./fixtures.ts";

function fleet() {
  const snap = snapshotFixture();
  return buildFleet(snap, new StatusClock().observe(snap.agents, 1000));
}

/** The node with `id`, checked to be of `type`. */
function nodeOf<T extends LayoutNode["type"]>(nodes: LayoutNode[], id: string, type: T): LayoutNodeOf<T> {
  const n = nodes.find((x): x is LayoutNodeOf<T> => x.id === id && x.type === type);
  assert.ok(n, `no ${type} node ${id}`);
  return n;
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
  assert.deepEqual(nodeOf(nodes, "group:/r/api/.git", "group-box").data.memberIds, ["w1"]);
  assert.equal(nodeOf(nodes, "ws:w2", "workspace").data.detached, true);
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

test("while dragging, the repo box ignores the dragged workspace and the drag gets a drop hint", () => {
  // w1 and w2 share the api repo; w2 is dragged far away.
  const saved = { w1: { x: 0, y: 100 }, w2: { x: 4000, y: 4000 } };
  const { nodes } = layoutFleet(fleet(), { agentsOnly: true, dragging: new Set(["w2"]) }, saved);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const group = byId.get("group:/r/api/.git")!;
  assert.ok(group.position.x + group.width! < 4000, "the box should not stretch to the dragged workspace");
  assert.equal(nodeOf(nodes, "ws:w2", "workspace").data.dropHint, "detach");
  // Dropped back next to w1, the hint says it stays in (no hint for an attached workspace).
  const near = layoutFleet(fleet(), { agentsOnly: true, dragging: new Set(["w2"]) }, { w1: { x: 0, y: 100 }, w2: { x: 340, y: 100 } });
  assert.equal(nodeOf(near.nodes, "ws:w2", "workspace").data.dropHint, undefined);
  // A detached workspace dragged back over the box gets the rejoin hint.
  const back = layoutFleet(fleet(), { agentsOnly: true, dragging: new Set(["w2"]) }, { w1: { x: 0, y: 100 }, w2: { x: 340, y: 100, detached: true } });
  assert.equal(nodeOf(back.nodes, "ws:w2", "workspace").data.dropHint, "rejoin");
});

test("workspaces know how many others share their repo box", () => {
  const { nodes } = layoutFleet(fleet(), { agentsOnly: true }, {});
  const mates = (id: string) => nodeOf(nodes, id, "workspace").data.groupMates;
  assert.equal(mates("ws:w1"), 1);
  assert.equal(mates("ws:w2"), 1);
});

test("a collapsed workspace is drawn as its header, and its repo box shrinks", () => {
  const saved = { w1: { x: 0, y: 100 }, w2: { x: 0, y: 400 } };
  const open = layoutFleet(fleet(), { agentsOnly: true }, saved);
  const closed = layoutFleet(fleet(), { agentsOnly: true, workspaceMeta: { w2: { collapsed: true } } }, saved);
  const find = (nodes: typeof open.nodes, id: string) => nodes.find((n) => n.id === id)!;
  assert.equal(find(closed.nodes, "ws:w2").height, WS_HEADER);
  assert.equal(nodeOf(closed.nodes, "ws:w2", "workspace").data.collapsed, true);
  assert.ok(!closed.nodes.some((n) => n.parentId === "ws:w2" && n.type === "tab"), "no tabs for a collapsed workspace");
  assert.ok(!closed.nodes.some((n) => n.id === "w2:p1"), "no panes for a collapsed workspace");
  assert.ok(closed.nodes.some((n) => n.id === "label:w2"), "the zoomed-out label stays");
  assert.ok(find(closed.nodes, "group:/r/api/.git").height! < find(open.nodes, "group:/r/api/.git").height!);
  // The lineage edge into the collapsed workspace's agent goes away with the pane.
  assert.deepEqual(closed.edges, []);
});

// Agent cards in the agent-panes view: stacked rows at x 2 and y 24, 100, 176 for three agents.
const cardsView = (opts: Partial<LayoutOptions> = {}) =>
  layoutFleet(fleetWith({ "w1:p1": "idle", "w1:p2": "idle", "w1:p3": "idle" }), { agentsOnly: true, agentPanesOnly: true, ...opts });
const node = (nodes: ReturnType<typeof layoutFleet>["nodes"], id: string) => nodes.find((n) => n.id === id)!;

test("saved card positions move cards within their tab, and the tab and workspace grow to hold them", () => {
  const stacked = cardsView();
  const moved = cardsView({ cards: { "w1:p1": { x: 2, y: 24 }, "w1:p2": { x: 290, y: 24 }, "w1:p3": { x: 2, y: 100 } } });
  assert.deepEqual(node(moved.nodes, "w1:p2").position, { x: 290, y: 24 });
  assert.equal(node(moved.nodes, "w1:p2").draggable, undefined, "cards are draggable in this view");
  for (const id of ["w1:p1", "w1:p2", "w1:p3"]) {
    assert.equal(node(moved.nodes, id).width, node(stacked.nodes, id).width, "cards keep their size");
    assert.equal(node(moved.nodes, id).height, node(stacked.nodes, id).height, "cards keep their size");
  }
  const card = node(moved.nodes, "w1:p2");
  assert.equal(node(moved.nodes, "tab:w1:t1").width, 290 + card.width! + 2);
  assert.equal(node(moved.nodes, "tab:w1:t1").height, node(stacked.nodes, "tab:w1:t1").height, "no taller than it needs");
  assert.ok(node(moved.nodes, "ws:w1").width! > node(stacked.nodes, "ws:w1").width!);

  const low = cardsView({ cards: { "w1:p1": { x: 2, y: 600 } } });
  const tab = node(low.nodes, "tab:w1:t1");
  assert.ok(tab.height! >= 600 + card.height!, "a card moved down makes the tab taller");
  assert.ok(node(low.nodes, "ws:w1").height! > tab.height!, "and its workspace");
});

test("cards without a saved position go below the lowest saved card", () => {
  const { nodes } = cardsView({ cards: { "w1:p1": { x: 290, y: 24 }, "w1:p3": { x: 2, y: 200 } } });
  const p2 = node(nodes, "w1:p2");
  const p3 = node(nodes, "w1:p3");
  assert.equal(p2.position.x, 2);
  assert.equal(p2.position.y, p3.position.y + p3.height! + 4);
});

test("saved cards stay inside the tab body, and dragged ones snap to an 8px grid", () => {
  const { nodes } = cardsView({ cards: { "w1:p1": { x: -50, y: 0 } } });
  assert.deepEqual(node(nodes, "w1:p1").position, { x: 2, y: 24 });
  assert.deepEqual(snapCard({ x: 13, y: 20 }), { x: 10, y: 24 });
  assert.deepEqual(snapCard({ x: 300, y: 107 }), { x: 298, y: 104 });
  assert.deepEqual(snapCard({ x: -400, y: -400 }), { x: 2, y: 24 });
});

test("while a card is dragged, it follows the drag and its tab keeps its size", () => {
  const stacked = cardsView();
  const { nodes } = cardsView({ cardDrag: { id: "w1:p2", x: 600, y: 24 } });
  assert.deepEqual(node(nodes, "w1:p2").position, { x: 600, y: 24 });
  assert.equal(node(nodes, "tab:w1:t1").width, node(stacked.nodes, "tab:w1:t1").width);
  assert.equal(node(nodes, "ws:w1").width, node(stacked.nodes, "ws:w1").width);
});

test("the full layout ignores saved card positions and keeps panes fixed", () => {
  const f = () => fleetWith({ "w1:p1": "idle", "w1:p2": "idle" });
  const cards = { "w1:p2": { x: 600, y: 300 } };
  const plain = layoutFleet(f(), { agentsOnly: true });
  const full = layoutFleet(f(), { agentsOnly: true, cards });
  assert.deepEqual(node(full.nodes, "w1:p2").position, node(plain.nodes, "w1:p2").position);
  assert.equal(node(full.nodes, "tab:w1:t1").width, node(plain.nodes, "tab:w1:t1").width);
  assert.equal(node(full.nodes, "w1:p2").draggable, false);
  assert.equal(nodeOf(full.nodes, "ws:w1", "workspace").data.arrangedTabs, undefined);
});

test("a workspace lists the tabs whose cards were moved", () => {
  const arranged = (opts: Partial<LayoutOptions>) => nodeOf(cardsView(opts).nodes, "ws:w1", "workspace").data.arrangedTabs;
  assert.deepEqual(arranged({}), []);
  assert.deepEqual(arranged({ cards: { "w1:p2": { x: 290, y: 24 } } }), [{ id: "w1:t1", label: "1" }]);
  // Positions of panes elsewhere don't count.
  assert.deepEqual(arranged({ cards: { "w9:p1": { x: 290, y: 24 } } }), []);
});

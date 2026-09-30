import assert from "node:assert/strict";
import { test } from "node:test";
import type { Node } from "@xyflow/react";
import type { FleetAgent, SubagentInfo } from "../shared/model.ts";
import { FINISHED_SHOW_MS, FINISHED_TURN_MS, MAX_CARDS, subagentNodes, subagentTree, visibleSubagents } from "../web/subagent-cards.ts";

const NOW = 1_000_000_000;
const agent = (status: FleetAgent["status"], subagents: SubagentInfo[]): FleetAgent => ({ kind: "claude", status, since: 0, sinceApprox: false, subagents });
const done = (id: string, ago: number): SubagentInfo => ({ id, status: "done", endedAt: NOW - ago });

test("running subagents always show; finished ones for a few minutes, or while their agent's turn is on screen", () => {
  const list = [{ id: "r", status: "running" as const }, done("recent", FINISHED_SHOW_MS - 1), done("turn", FINISHED_TURN_MS - 1), done("old", FINISHED_TURN_MS + 1)];
  assert.deepEqual(visibleSubagents(agent("idle", list), NOW).map((s) => s.id), ["r", "recent"]);
  for (const status of ["working", "blocked", "done"] as const) {
    assert.deepEqual(visibleSubagents(agent(status, list), NOW).map((s) => s.id), ["r", "recent", "turn"]);
  }
});

test("nested subagents follow the one that started them; orphans go to the top level", () => {
  const list: SubagentInfo[] = [
    { id: "b", status: "running" },
    { id: "a1", status: "running", parent: "a" },
    { id: "a", status: "running" },
    { id: "a1x", status: "done", parent: "a1" },
    { id: "z1", status: "done", parent: "gone" },
  ];
  assert.deepEqual(
    subagentTree(list).map(({ sub, depth }) => `${sub.id}:${depth}`),
    ["b:0", "a:0", "a1:1", "a1x:2", "z1:0"],
  );
});

function mapNodes(subagents: SubagentInfo[], className?: string): Node[] {
  return [
    { id: "ws:w1", type: "workspace", position: { x: 100, y: 200 }, data: {} },
    { id: "tab:t1", type: "tab", parentId: "ws:w1", position: { x: 12, y: 30 }, data: {} },
    {
      id: "w1:p1",
      type: "pane",
      parentId: "tab:t1",
      position: { x: 2, y: 24 },
      width: 276,
      height: 72,
      className,
      data: { pane: { id: "w1:p1", rect: { x: 0, y: 0, w: 1, h: 1 }, title: "", focused: false, agent: agent("working", subagents) } },
    },
  ];
}

test("cards show only for the selected or pointed-at agent, right of its card and indented by depth", () => {
  const subs: SubagentInfo[] = [{ id: "a", status: "running" }, { id: "a1", status: "running", parent: "a" }];
  const none = subagentNodes(mapNodes(subs), NOW, new Set());
  assert.equal(none.above.length + none.below.length, 0, "no cards for an agent that isn't selected or pointed at");
  const peek = subagentNodes(mapNodes(subs), NOW, new Set(), "w1:p1");
  assert.equal(peek.below.length, 0);
  assert.deepEqual(
    peek.above.map((n) => [n.id, n.position.x, n.position.y, n.zIndex, n.className]),
    [
      ["sub:w1:p1:a", 100 + 12 + 2 + 276 + 10, 200 + 30 + 24, 1500, "peek"],
      ["sub:w1:p1:a1", 100 + 12 + 2 + 276 + 10 + 14, 200 + 30 + 24 + 68, 1500, "peek"],
    ],
  );
  const raised = subagentNodes(mapNodes(subs), NOW, new Set(["w1:p1"]));
  assert.deepEqual(raised.above.map((n) => n.className), ["raised", "raised"]);
});

test("a long list ends with a count of the rest; filtered agents get no cards; no subagents means the same empty lists", () => {
  const many = Array.from({ length: MAX_CARDS + 3 }, (_, i): SubagentInfo => ({ id: `s${i}`, status: "running" }));
  const sel = new Set(["w1:p1"]);
  const { above } = subagentNodes(mapNodes(many), NOW, sel);
  assert.equal(above.length, MAX_CARDS + 1);
  assert.deepEqual(above.at(-1)!.data, { pane: "w1:p1", depth: 0, more: 3 });
  assert.equal(subagentNodes(mapNodes(many, "status-filtered"), NOW, sel).above.length, 0);
  assert.equal(subagentNodes(mapNodes(many, "dim"), NOW, sel).above[0].className, "dim raised");
  const a = subagentNodes(mapNodes([]), NOW, new Set());
  const b = subagentNodes(mapNodes([]), NOW + 5000, new Set());
  assert.equal(a.below, b.below);
  assert.equal(a.above, b.above);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FleetAgent, SubagentInfo } from "../shared/model.ts";
import { FINISHED_SHOW_MS, FINISHED_TURN_MS, subagentTree, visibleSubagents } from "../web/subagent-cards.ts";

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

test("when a finished subagent drops off the list, its children move to the top level", () => {
  const list: SubagentInfo[] = [
    { id: "a", status: "running" },
    { id: "a1", status: "done", parent: "a", endedAt: NOW - FINISHED_TURN_MS - 1 },
    { id: "a1x", status: "running", parent: "a1" },
    { id: "a2", status: "running", parent: "a" },
  ];
  assert.deepEqual(
    subagentTree(visibleSubagents(agent("idle", list), NOW)).map(({ sub, depth }) => `${sub.id}:${depth}`),
    ["a:0", "a2:1", "a1x:0"],
  );
  assert.deepEqual(subagentTree([]), []);
});

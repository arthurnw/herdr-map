import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStatus, FleetAgent, FleetWorkspace } from "../shared/model.ts";
import { boardColumns, columnFor, moveOnBoard, type BoardCard } from "../web/board.ts";

const workspace: FleetWorkspace = { id: "w1", label: "api", number: 1, focused: false, linkedWorktree: false, agentCount: 1, tabs: [] };

function agent(status: AgentStatus, since: number, extra: Partial<FleetAgent> = {}): FleetAgent {
  return { kind: "claude", status, since, sinceApprox: false, ...extra };
}

function card(id: string, a: FleetAgent): BoardCard {
  return { pane: { id, rect: { x: 0, y: 0, w: 1, h: 1 }, title: id, focused: false, agent: a }, tabId: "t1", tabLabel: "main", workspace, repo: "api" };
}

const none = () => 0;
const everyone = () => true;
const ids = (cards: BoardCard[]) => cards.map((c) => c.pane.id);

test("columnFor follows status, with Needs you taking blocked, stuck, and unread notes", () => {
  assert.equal(columnFor(agent("blocked", 0), 0), "needs");
  assert.equal(columnFor(agent("working", 0, { stuck: { reason: "no-output", since: 0 } }), 0), "needs");
  assert.equal(columnFor(agent("idle", 0), 2), "needs");
  assert.equal(columnFor(agent("done", 0), 0), "done");
  assert.equal(columnFor(agent("done", 0), 1), "needs", "a finished agent with unread notes still needs you");
  assert.equal(columnFor(agent("working", 0), 0), "working");
  assert.equal(columnFor(agent("idle", 0), 0), "idle");
  assert.equal(columnFor(agent("unknown", 0), 0), "unknown");
});

test("boardColumns lists Unknown only when an agent is in it, even a filtered one", () => {
  const cards = [card("a", agent("working", 0)), card("b", agent("idle", 0))];
  const opts = { unread: none, isStarred: () => false, shown: everyone };
  assert.deepEqual(boardColumns(cards, opts).map((c) => c.id), ["needs", "working", "done", "idle"]);
  const withUnknown = [...cards, card("c", agent("unknown", 0))];
  assert.deepEqual(boardColumns(withUnknown, opts).map((c) => c.title), ["Needs you", "Working", "Done", "Idle", "Unknown"]);
  const hidden = boardColumns(withUnknown, { ...opts, shown: (c) => c.pane.agent!.status !== "unknown" });
  assert.equal(hidden.at(-1)!.id, "unknown");
  assert.deepEqual(hidden.at(-1)!.cards, []);
});

test("boardColumns leaves out the cards the filters hide", () => {
  const cards = [card("a", agent("idle", 0)), card("b", agent("idle", 1)), card("c", agent("working", 0))];
  const cols = boardColumns(cards, { unread: none, isStarred: () => false, shown: (c) => c.pane.id !== "a" });
  assert.deepEqual(ids(cols.find((c) => c.id === "idle")!.cards), ["b"]);
});

test("boardColumns puts starred cards first, then oldest first in Needs you and Done, newest first elsewhere", () => {
  const cards = [
    card("blocked-new", agent("blocked", 300)),
    card("blocked-old", agent("blocked", 100)),
    // Working since 10 but stuck since 200: its wait counts from when it got stuck.
    card("stuck", agent("working", 10, { stuck: { reason: "no-output", since: 200 } })),
    card("done-new", agent("done", 300)),
    card("done-old", agent("done", 100)),
    card("work-old", agent("working", 100)),
    card("work-new", agent("working", 300)),
    card("work-starred", agent("working", 50)),
    card("idle-old", agent("idle", 100)),
    card("idle-new", agent("idle", 300)),
  ];
  const cols = boardColumns(cards, { unread: none, isStarred: (id) => id === "work-starred" || id === "done-new", shown: everyone });
  const col = (id: string) => ids(cols.find((c) => c.id === id)!.cards);
  assert.deepEqual(col("needs"), ["blocked-old", "stuck", "blocked-new"]);
  assert.deepEqual(col("done"), ["done-new", "done-old"]);
  assert.deepEqual(col("working"), ["work-starred", "work-new", "work-old"]);
  assert.deepEqual(col("idle"), ["idle-new", "idle-old"]);
});

test("moveOnBoard steps within a column and stops at its ends", () => {
  const cols = [["a1", "a2"], [], ["c1"]];
  assert.equal(moveOnBoard(cols, "a1", "down"), "a2");
  assert.equal(moveOnBoard(cols, "a2", "down"), undefined);
  assert.equal(moveOnBoard(cols, "a2", "up"), "a1");
  assert.equal(moveOnBoard(cols, "a1", "up"), undefined);
});

test("moveOnBoard crosses to the nearest column with cards, keeping the row where it can", () => {
  const cols = [["a1", "a2", "a3"], [], ["c1", "c2"]];
  assert.equal(moveOnBoard(cols, "a1", "right"), "c1", "the empty column is skipped");
  assert.equal(moveOnBoard(cols, "a3", "right"), "c2", "a shorter column gives its last card");
  assert.equal(moveOnBoard(cols, "c2", "left"), "a2");
  assert.equal(moveOnBoard(cols, "c1", "right"), undefined);
  assert.equal(moveOnBoard(cols, "a1", "left"), undefined);
});

test("moveOnBoard picks the first card when nothing on the board is selected", () => {
  const cols = [[], ["b1", "b2"]];
  assert.equal(moveOnBoard(cols, undefined, "down"), "b1");
  assert.equal(moveOnBoard(cols, "gone", "left"), "b1");
  assert.equal(moveOnBoard([[], []], undefined, "right"), undefined);
});

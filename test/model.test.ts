import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFleet, FINISH_GRACE_MS, paneTitle, StatusClock } from "../shared/model.ts";
import { snapshotFixture } from "./fixtures.ts";

test("groups workspaces by repo in workspace order, with non-repo workspaces last", () => {
  const snap = snapshotFixture();
  const fleet = buildFleet(snap, new StatusClock().observe(snap.agents, 1000));
  assert.deepEqual(
    fleet.groups.map((g) => [g.label, g.workspaces.map((w) => w.id)]),
    [
      ["api", ["w1", "w2"]],
      ["Other workspaces", ["w3"]],
    ],
  );
  assert.equal(fleet.groups[0].workspaces[1].linkedWorktree, true);
});

test("maps layout rects to fractions and falls back to columns without a layout", () => {
  const snap = snapshotFixture();
  const fleet = buildFleet(snap, new StatusClock().observe(snap.agents, 1000));
  const [agentPane, hunkPane] = fleet.groups[0].workspaces[0].tabs[0].panes;
  assert.deepEqual(agentPane.rect, { x: 0, y: 0, w: 0.6, h: 1 });
  assert.deepEqual(hunkPane.rect, { x: 0.6, y: 0, w: 0.4, h: 1 });
  const lone = fleet.groups[1].workspaces[0].tabs[0].panes[0];
  assert.deepEqual(lone.rect, { x: 0, y: 0, w: 1, h: 1 });
});

test("carries agent status, name, summary, parent token, and counts", () => {
  const snap = snapshotFixture();
  const fleet = buildFleet(snap, new StatusClock().observe(snap.agents, 1000));
  const lead = fleet.groups[0].workspaces[0].tabs[0].panes[0];
  assert.equal(lead.agent?.name, "lead");
  assert.equal(lead.agent?.summary, "Refactor the auth middleware");
  const child = fleet.groups[0].workspaces[1].tabs[0].panes[0];
  assert.equal(child.parent, "w1:p1");
  assert.equal(fleet.counts.working, 1);
  assert.equal(fleet.counts.blocked, 1);
  assert.equal(fleet.groups[0].workspaces[0].agentCount, 1);
  assert.equal(fleet.groups[0].workspaces[0].tabs[0].panes[1].focused, true);
});

test("StatusClock keeps the start time until the status changes", () => {
  const clock = new StatusClock();
  const first = clock.observe([{ pane_id: "a", agent_status: "working" }], 1000);
  assert.deepEqual(first.get("a"), { status: "working", since: 1000, approx: true });
  const same = clock.observe([{ pane_id: "a", agent_status: "working" }], 5000);
  assert.equal(same.get("a")?.since, 1000);
  const changed = clock.observe([{ pane_id: "a", agent_status: "done" }], 9000);
  assert.deepEqual(changed.get("a"), { status: "done", since: 9000, approx: false });
  const gone = clock.observe([], 10_000);
  assert.equal(gone.size, 0);
});

test("paneTitle shortens shell prompts", () => {
  assert.equal(paneTitle("anw@host:~/code/x"), "shell ~/code/x");
  assert.equal(paneTitle("nvim AGENTS.md"), "nvim AGENTS.md");
  assert.equal(paneTitle(undefined), "shell");
});

test("StatusClock holds done after a turn ends until the pane is focused", () => {
  const clock = new StatusClock();
  const at = (status: "working" | "idle" | "done", now: number, focused?: string) =>
    clock.observe([{ pane_id: "a", agent_status: status }], now, focused)?.get("a")?.status;
  assert.equal(at("working", 0, "b"), "working");
  // A brief idle inside the grace period is not a finished turn.
  assert.equal(at("idle", 1000, "b"), "idle");
  assert.equal(at("idle", 1000 + FINISH_GRACE_MS, "b"), "done");
  // herdr has already dropped done to idle; the hold keeps it.
  assert.equal(at("idle", 60_000, "b"), "done");
  // Focus moving to the pane counts as looking at it.
  assert.equal(at("idle", 61_000, "a"), "idle");
  assert.equal(at("idle", 62_000, "a"), "idle");
});

test("StatusClock keeps herdr's own done and clears it with markSeen", () => {
  const clock = new StatusClock();
  clock.observe([{ pane_id: "a", agent_status: "working" }], 0);
  assert.equal(clock.observe([{ pane_id: "a", agent_status: "done" }], 1)?.get("a")?.status, "done");
  assert.equal(clock.observe([{ pane_id: "a", agent_status: "idle" }], 2)?.get("a")?.status, "done");
  clock.markSeen("a");
  assert.equal(clock.observe([{ pane_id: "a", agent_status: "idle" }], 3)?.get("a")?.status, "idle");
});

test("StatusClock doesn't hold agents that were already idle at startup", () => {
  const clock = new StatusClock();
  assert.equal(clock.observe([{ pane_id: "a", agent_status: "idle" }], 0)?.get("a")?.status, "idle");
  assert.equal(clock.observe([{ pane_id: "a", agent_status: "idle" }], 10_000)?.get("a")?.status, "idle");
});

test("buildFleet reports the held status and counts it", () => {
  const snap = snapshotFixture();
  const clock = new StatusClock();
  clock.observe(snap.agents, 0);
  const idle = { ...snap, agents: snap.agents.map((a) => (a.pane_id === "w1:p1" ? { ...a, agent_status: "idle" as const } : a)) };
  clock.observe(idle.agents, 1000);
  const fleet = buildFleet(idle, clock.observe(idle.agents, 1000 + FINISH_GRACE_MS));
  assert.equal(fleet.groups[0].workspaces[0].tabs[0].panes[0].agent?.status, "done");
  assert.equal(fleet.counts.done, 1);
  assert.equal(fleet.counts.working, 0);
});

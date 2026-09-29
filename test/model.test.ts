import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFleet, paneTitle, StatusClock } from "../shared/model.ts";
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

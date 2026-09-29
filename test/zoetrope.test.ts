import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFleet, fleetPanes, StatusClock } from "../shared/model.ts";
import { hasZoetropeSession } from "../shared/zoetrope.ts";
import { snapshotFixture } from "./fixtures.ts";

test("buildFleet carries a session ID only when herdr reports an id", () => {
  const snap = snapshotFixture();
  const [first, second] = snap.panes.filter((p) => p.agent);
  first.agent_session = { source: "herdr:claude", agent: "claude", kind: "id", value: "abc" };
  second.agent_session = { source: "herdr:pi", agent: "pi", kind: "path", value: "/tmp/s.jsonl" };
  const panes = fleetPanes(buildFleet(snap, new StatusClock().observe(snap.agents, 1000)));
  assert.equal(panes.find((p) => p.id === first.pane_id)?.agent?.sessionId, "abc");
  assert.equal(panes.find((p) => p.id === second.pane_id)?.agent?.sessionId, undefined);
});

test("hasZoetropeSession needs a Claude Code or Codex agent with a session ID", () => {
  const base = { status: "working" as const, since: 0, sinceApprox: false };
  assert.equal(hasZoetropeSession({ ...base, kind: "claude", sessionId: "abc" }), true);
  assert.equal(hasZoetropeSession({ ...base, kind: "codex", sessionId: "abc" }), true);
  assert.equal(hasZoetropeSession({ ...base, kind: "pi", sessionId: "abc" }), false);
  assert.equal(hasZoetropeSession({ ...base, kind: "claude" }), false);
  assert.equal(hasZoetropeSession(undefined), false);
});

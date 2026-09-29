import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFleet, StatusClock } from "../shared/model.ts";
import { detectBanner, screenFingerprint } from "../shared/stuck.ts";
import { markStuck, StuckTracker, workingPanes } from "../server/stuck.ts";
import { snapshotFixture } from "./fixtures.ts";

const MIN = 60_000;

test("detectBanner finds rate-limit banners near the bottom of the screen", () => {
  assert.equal(detectBanner("⎿ API Error: 429 rate_limit_error · Retrying in 4 seconds"), "rate-limit");
  assert.equal(detectBanner("Claude usage limit reached. Your limit will reset at 3pm"), "rate-limit");
  assert.equal(detectBanner("■ You've hit your usage limit. Try again later."), "rate-limit");
  assert.equal(detectBanner("stream error: exceeded retry limit, last status: 429 Too Many Requests"), "rate-limit");
  assert.equal(detectBanner("Rate limited, waiting"), "rate-limit");
});

test("detectBanner finds API and overload errors", () => {
  assert.equal(detectBanner(`⎿ API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}`), "error");
  assert.equal(detectBanner("⎿ API Error (Connection error.) · Retrying in 8 seconds"), "error");
  assert.equal(detectBanner("The server is currently overloaded"), "error");
});

test("detectBanner ignores ordinary output and banners scrolled far up", () => {
  assert.equal(detectBanner("I'll add a rate limiter to the login endpoint.\nEditing src/limit.ts"), undefined);
  assert.equal(detectBanner("Added an overloaded method for parse()\nline 429 of parser.ts"), undefined);
  const old = ["API Error: 500", ...Array.from({ length: 20 }, (_, i) => `step ${i}`)].join("\n");
  assert.equal(detectBanner(old), undefined);
});

test("screenFingerprint ignores spinner lines and ticking numbers", () => {
  const a = "Edited 3 files\n✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)\n> ";
  const b = "Edited 3 files\n✳ Pondering… (48s · ↑ 3.4k tokens · esc to interrupt)\n> ";
  assert.equal(screenFingerprint(a), screenFingerprint(b));
  assert.notEqual(screenFingerprint(a), screenFingerprint("Edited 3 files\nRunning tests\n> "));
  assert.equal(screenFingerprint("• Working (5s • esc to interrupt)\ndone 10%"), screenFingerprint("• Working (9s • esc to interrupt)\ndone 90%"));
});

test("StuckTracker flags a screen that hasn't changed for the threshold", () => {
  const t = new StuckTracker(5 * MIN);
  t.observe("a", "compiling", 0);
  t.observe("a", "compiling", 4 * MIN);
  assert.equal(t.stuck(4 * MIN).size, 0);
  t.observe("a", "compiling", 5 * MIN);
  assert.deepEqual(t.stuck(5 * MIN).get("a"), { reason: "no-output", since: 0 });
  t.observe("a", "tests passed", 6 * MIN);
  assert.equal(t.stuck(6 * MIN).size, 0, "new output clears it");
});

test("StuckTracker flags a banner at once and keeps when it first appeared", () => {
  const t = new StuckTracker(5 * MIN);
  t.observe("a", "API Error: 429 Too Many Requests", 1000);
  t.observe("a", "API Error: 429 Too Many Requests\nRetrying", 2000);
  assert.deepEqual(t.stuck(2000).get("a"), { reason: "rate-limit", since: 1000 });
  t.observe("a", "back to work", 3000);
  assert.equal(t.stuck(3000).size, 0);
});

test("StuckTracker forgets panes that stopped working", () => {
  const t = new StuckTracker(0);
  t.observe("a", "x", 0);
  t.observe("b", "x", 0);
  t.retain(["b"]);
  assert.deepEqual([...t.stuck(1).keys()], ["b"]);
});

test("markStuck only marks agents that are still working", () => {
  const snap = snapshotFixture();
  const fleet = buildFleet(snap, new StatusClock().observe(snap.agents, 1000));
  const working = workingPanes(fleet);
  assert.equal(working.length, 1);
  const stuck = { reason: "rate-limit" as const, since: 5 };
  const all = new Map(snap.agents.map((a) => [a.pane_id, stuck]));
  markStuck(fleet, all);
  const marked = snap.agents.filter((a) => {
    for (const g of fleet.groups)
      for (const ws of g.workspaces)
        for (const tab of ws.tabs) for (const p of tab.panes) if (p.id === a.pane_id && p.agent?.stuck) return true;
    return false;
  });
  assert.deepEqual(
    marked.map((a) => a.pane_id),
    working,
  );
});

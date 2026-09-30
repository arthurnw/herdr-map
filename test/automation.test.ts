import assert from "node:assert/strict";
import { test } from "node:test";
import { textHash } from "../shared/automation.ts";
import { FINISH_GRACE_MS, type AgentStatus } from "../shared/model.ts";
import { indexPanes } from "../server/agents.ts";
import { TurnWatcher } from "../server/automation.ts";
import { handoffPrompt, HANDOFF_CHARS, trimOutput } from "../server/prompts.ts";
import { fleetWith } from "./fixtures.ts";

const statuses = (s: Record<string, AgentStatus>) => new Map(Object.entries(s));

test("a turn finishes on done, or after idle outlasts the grace period, and is reported once", () => {
  const w = new TurnWatcher();
  assert.deepEqual(w.observe(statuses({ a: "working", b: "working" }), 0), []);
  assert.deepEqual(w.observe(statuses({ a: "done", b: "idle" }), 1000), ["a"]);
  assert.deepEqual(w.observe(statuses({ a: "done", b: "idle" }), 2000), [], "a short idle is not a finish");
  assert.deepEqual(w.observe(statuses({ a: "done", b: "idle" }), 1000 + FINISH_GRACE_MS), ["b"]);
  assert.deepEqual(w.observe(statuses({ a: "idle", b: "idle" }), 60_000), [], "no second report for the same turn");
  assert.deepEqual(w.observe(statuses({ a: "working", b: "idle" }), 61_000), []);
  assert.deepEqual(w.observe(statuses({ a: "done", b: "idle" }), 62_000), ["a"], "a new turn reports again");
});

test("a short idle between steps doesn't end the turn", () => {
  const w = new TurnWatcher();
  w.observe(statuses({ a: "working" }), 0);
  assert.deepEqual(w.observe(statuses({ a: "idle" }), 100), []);
  assert.deepEqual(w.observe(statuses({ a: "working" }), 1000), []);
  assert.deepEqual(w.observe(statuses({ a: "idle" }), 2000), []);
  assert.deepEqual(w.observe(statuses({ a: "idle" }), 2000 + FINISH_GRACE_MS - 1), []);
  assert.deepEqual(w.observe(statuses({ a: "idle" }), 2000 + FINISH_GRACE_MS), ["a"]);
});

test("agents already idle or done when first seen have no turn to finish", () => {
  const w = new TurnWatcher();
  assert.deepEqual(w.observe(statuses({ a: "done", b: "idle" }), 0), []);
  assert.deepEqual(w.observe(statuses({ a: "done", b: "idle" }), 10_000), []);
});

test("blocked counts as part of a turn", () => {
  const w = new TurnWatcher();
  w.observe(statuses({ a: "blocked" }), 0);
  assert.deepEqual(w.observe(statuses({ a: "done" }), 100), ["a"]);
});

test("handoff prompts name the agent and keep the end of long output", () => {
  const info = indexPanes(fleetWith({ "w1:p1": "done" })).get("w1:p1");
  const text = handoffPrompt(info, "w1:p1", "line\n".repeat(5000) + "the result\n\n");
  assert.match(text, /^Handoff from "agent-w1-p1" \(claude\) in workspace "api", pane w1:p1/);
  assert.ok(text.endsWith("the result"));
  assert.ok(trimOutput("x\n".repeat(HANDOFF_CHARS)).length <= HANDOFF_CHARS);
  assert.match(handoffPrompt(info, "w1:p1", { error: "timeout" }), /herdr agent read w1:p1/);
});

test("text hashes differ for different text", () => {
  assert.equal(textHash("a"), textHash("a"));
  assert.notEqual(textHash("a"), textHash("b"));
});

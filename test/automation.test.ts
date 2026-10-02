import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeTiming, isTiming, nextRun, scheduleStep, textHash } from "../shared/automation.ts";
import { FINISH_GRACE_MS, type AgentStatus } from "../shared/model.ts";
import { indexPanes } from "../server/agents.ts";
import { handoffOutput, TurnWatcher } from "../server/automation.ts";
import { handoffPrompt, HANDOFF_CHARS, trimOutput } from "../server/prompts.ts";
import { openQueue } from "../server/queue.ts";
import { addSchedule, editSchedule, removeSchedule, runSchedules, setArmed } from "../server/schedules.ts";
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
  const text = handoffPrompt(info, "w1:p1", { screen: "line\n".repeat(5000) + "the result\n\n" });
  assert.match(text, /^Handoff from "agent-w1-p1" \(claude\) in workspace "api", pane w1:p1/);
  assert.match(text, /Its latest output \(from its terminal, no transcript found\):/);
  assert.ok(text.endsWith("the result"));
  assert.ok(trimOutput("x\n".repeat(HANDOFF_CHARS)).length <= HANDOFF_CHARS);
  assert.match(handoffPrompt(info, "w1:p1", { error: "timeout" }), /herdr agent read w1:p1/);
});

test("a handoff sends the final reply, noting when it was trimmed", () => {
  const info = indexPanes(fleetWith({ "w1:p1": "done" })).get("w1:p1");
  assert.equal(
    handoffPrompt(info, "w1:p1", { reply: "Fixed the flaky test." }),
    'Handoff from "agent-w1-p1" (claude) in workspace "api", pane w1:p1, which just finished a turn. Its final reply:\n\nFixed the flaky test.',
  );
  assert.match(handoffPrompt(info, "w1:p1", { reply: "…end", trimmed: true }), /Its final reply \(trimmed to its last 8,000 characters\):\n\n…end$/);
});

test("a handoff falls back to the terminal only when the transcript has no reply", async () => {
  const screens: string[] = [];
  const readScreen = async (pane: string) => (screens.push(pane), "screen text");
  assert.deepEqual(await handoffOutput("w1:p1", async () => ({ text: "The reply.", path: "/t.jsonl" }), readScreen), { reply: "The reply." });
  assert.deepEqual(await handoffOutput("w1:p1", async () => ({ text: "…", trimmed: true }), readScreen), { reply: "…", trimmed: true });
  assert.deepEqual(screens, [], "the terminal isn't read when the transcript has the reply");
  for (const lastReply of [async () => ({ path: "/t.jsonl" }), async () => ({ error: "transcript not found" }), () => Promise.reject(new Error("probe timed out"))]) {
    assert.deepEqual(await handoffOutput("w1:p1", lastReply, readScreen), { screen: "screen text" });
  }
  assert.deepEqual(screens, ["w1:p1", "w1:p1", "w1:p1"]);
  const broken = async () => Promise.reject(new Error("herdr is gone"));
  assert.deepEqual(await handoffOutput("w1:p1", async () => ({}), broken), { error: "herdr is gone" });
});

test("interval and daily timings", () => {
  const t = new Date(2026, 8, 30, 10, 15).getTime();
  assert.equal(nextRun({ kind: "interval", minutes: 30 }, t), t + 30 * 60_000);
  assert.equal(nextRun({ kind: "daily", time: "10:30" }, t), new Date(2026, 8, 30, 10, 30).getTime());
  assert.equal(nextRun({ kind: "daily", time: "10:15" }, t), new Date(2026, 9, 1, 10, 15).getTime(), "strictly after");
  assert.equal(nextRun({ kind: "daily", time: "09:00" }, t), new Date(2026, 9, 1, 9, 0).getTime());
  assert.equal(describeTiming({ kind: "interval", minutes: 120 }), "Every 2 hours");
  assert.equal(describeTiming({ kind: "interval", minutes: 45 }), "Every 45 minutes");
  assert.ok(isTiming({ kind: "daily", time: "23:59" }));
  for (const bad of [{ kind: "daily", time: "24:00" }, { kind: "interval", minutes: 0 }, { kind: "interval", minutes: 1.5 }, null]) {
    assert.ok(!isTiming(bad), JSON.stringify(bad));
  }
});

test("missed runs collapse into one, counted from now", () => {
  const timing = { kind: "interval" as const, minutes: 10 };
  assert.deepEqual(scheduleStep(timing, 1000, 999), { due: false, nextRunAt: 1000 });
  // Asleep for five intervals: one run is due, and the next one is an interval from waking.
  const woke = 1000 + 50 * 60_000;
  assert.deepEqual(scheduleStep(timing, 1000, woke), { due: true, nextRunAt: woke + 10 * 60_000 });
});

async function scheduleSetup() {
  const path = join(await mkdtemp(join(tmpdir(), "herdr-map-sched-")), "queue.json");
  const deps = { path, view: () => ({ fleet: fleetWith({ "w1:p1": "idle" }), updatedAt: 0 }), send: async () => {} };
  const queue = await openQueue(deps);
  const panes = indexPanes(fleetWith({ "w1:p1": "idle" }));
  const s = addSchedule(queue, { target: "w1:p1", targetLabel: "lead", text: "status?", timing: { kind: "interval", minutes: 5 } }, 0);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- addSchedule returns the schedule or an error message
  assert.ok(typeof s !== "string");
  return { queue, panes, s, deps };
}

test("a schedule does nothing until armed, then queues once per due run", async () => {
  const { queue, panes, s } = await scheduleSetup();
  runSchedules(queue, panes, 60 * 60_000);
  assert.equal(queue.data.items.length, 0, "not armed");
  setArmed(queue, s.id, true, 0);
  assert.equal(s.nextRunAt, 5 * 60_000);
  runSchedules(queue, panes, 5 * 60_000 - 1);
  assert.equal(queue.data.items.length, 0);
  // Down for an hour: one run, not twelve.
  runSchedules(queue, panes, 65 * 60_000);
  assert.equal(queue.data.items.length, 1);
  assert.equal(queue.data.items[0].source.scheduleId, s.id);
  assert.equal(s.lastResult, "Queued");
  assert.equal(s.nextRunAt, 70 * 60_000);
  runSchedules(queue, panes, 70 * 60_000);
  assert.equal(queue.data.items.length, 1, "no second item while the first is still queued");
  assert.match(s.lastResult!, /still queued/);
});

test("a due run while paused is skipped, not saved for later", async () => {
  const { queue, panes, s } = await scheduleSetup();
  setArmed(queue, s.id, true, 0);
  queue.setPaused(true);
  runSchedules(queue, panes, 5 * 60_000);
  assert.equal(queue.data.items.length, 0);
  assert.match(s.lastResult!, /paused/);
  queue.setPaused(false);
  runSchedules(queue, panes, 6 * 60_000);
  assert.equal(queue.data.items.length, 0, "the skipped run doesn't come back");
});

test("editing target, text, or timing disarms and drops the queued run; other edits don't", async () => {
  const { queue, panes, s } = await scheduleSetup();
  for (const patch of [{ text: "new text" }, { timing: { kind: "daily" as const, time: "09:00" } }, { target: "w1:p2", targetLabel: "x" }]) {
    setArmed(queue, s.id, true, 0);
    runSchedules(queue, panes, 5 * 60_000);
    editSchedule(queue, s.id, patch, 1);
    assert.equal(s.armed, false, JSON.stringify(patch));
    assert.equal(s.nextRunAt, undefined);
    assert.equal(queue.data.items.filter((i) => i.state === "pending").length, 0, "the queued run is cancelled");
    editSchedule(queue, s.id, { target: "w1:p1" }, 2);
  }
  setArmed(queue, s.id, true, 0);
  editSchedule(queue, s.id, { text: s.text, timing: { ...s.timing } }, 3);
  assert.equal(s.armed, true, "saving the same values keeps it armed");
});

test("schedules survive a restart, armed or not", async () => {
  const { queue, s, deps } = await scheduleSetup();
  setArmed(queue, s.id, true, 0);
  await queue.save();
  const again = await openQueue(deps);
  assert.equal(again.data.schedules[0].armed, true);
  assert.equal(again.data.schedules[0].nextRunAt, 5 * 60_000);
  removeSchedule(again, s.id);
  assert.equal(again.data.schedules.length, 0);
});

test("text hashes differ for different text", () => {
  assert.equal(textHash("a"), textHash("a"));
  assert.notEqual(textHash("a"), textHash("b"));
});

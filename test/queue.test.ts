import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentStatus } from "../shared/model.ts";
import { COOLDOWN_MS, GONE_KEEP_MS, MAX_ATTEMPTS, loadQueueFile, openQueue, type FleetView } from "../server/queue.ts";
import { fleetWith } from "./fixtures.ts";

const source = { kind: "manual" as const, label: "test" };

/** A queue over a temp file, a fleet whose statuses tests set, and a record of what was sent. */
async function setup(statuses: Record<string, AgentStatus | null> = { "w1:p1": "idle", "w1:p2": "idle" }) {
  const path = join(await mkdtemp(join(tmpdir(), "herdr-map-queue-")), "queue.json");
  const sent: { pane: string; text: string }[] = [];
  const state = { statuses, updatedAt: 0, error: undefined as string | undefined, fail: undefined as string | undefined };
  const deps = {
    path,
    view: (): FleetView => ({ fleet: fleetWith(state.statuses), updatedAt: state.updatedAt, error: state.error }),
    send: async (pane: string, text: string) => {
      if (state.fail) throw new Error(state.fail);
      sent.push({ pane, text });
    },
  };
  const queue = await openQueue(deps);
  const add = (target: string, text: string, now: number) => queue.enqueue({ target, targetLabel: target, text, source }, now);
  return { path, deps, queue, sent, state, add };
}

test("delivers only to idle or done agents", async () => {
  const { queue, sent, state, add } = await setup({ "w1:p1": "working" });
  add("w1:p1", "hello", 1);
  await queue.tick(10);
  assert.equal(sent.length, 0, "working");
  state.statuses = { "w1:p1": "blocked" };
  await queue.tick(20);
  assert.equal(sent.length, 0, "blocked");
  state.statuses = { "w1:p1": "done" };
  await queue.tick(30);
  assert.deepEqual(sent, [{ pane: "w1:p1", text: "hello" }]);
  assert.equal(queue.data.items.length, 0);
  assert.equal(queue.data.history.at(-1)?.text, "hello");
  assert.equal(queue.data.history.at(-1)?.deliveredAt, 30);
});

test("sends one item per target per turn, oldest first", async () => {
  const { queue, sent, state, add } = await setup();
  add("w1:p1", "second", 20);
  add("w1:p1", "first", 10);
  add("w1:p2", "other", 30);
  await queue.tick(100);
  assert.deepEqual(sent.map((s) => s.text), ["first", "other"]);
  // Until a newer snapshot arrives, and for a cooldown after the delivery, the target waits.
  await queue.tick(100 + COOLDOWN_MS);
  assert.equal(sent.length, 2, "needs a snapshot newer than the delivery");
  state.updatedAt = 101;
  await queue.tick(100 + COOLDOWN_MS - 1);
  assert.equal(sent.length, 2, "cooldown");
  await queue.tick(100 + COOLDOWN_MS);
  assert.deepEqual(sent.map((s) => s.text), ["first", "other", "second"]);
});

test("backs off after a failure and gives up after a few attempts, keeping the error", async () => {
  const { queue, sent, state, add } = await setup();
  state.fail = "pane is busy";
  const item = add("w1:p1", "hello", 0);
  assert.ok(typeof item !== "string");
  let now = 0;
  await queue.tick(now);
  assert.equal(item.attempts, 1);
  assert.ok(item.notBefore! > now);
  await queue.tick(item.notBefore! - 1);
  assert.equal(item.attempts, 1, "waits out the backoff");
  while (item.state === "pending") {
    now = item.notBefore!;
    await queue.tick(now);
  }
  assert.equal(item.state, "failed");
  assert.equal(item.attempts, MAX_ATTEMPTS);
  assert.equal(item.lastError, "pane is busy");
  await queue.tick(now + 600_000);
  assert.equal(item.attempts, MAX_ATTEMPTS, "a failed item isn't retried on its own");
  state.fail = undefined;
  queue.retry(item.id);
  await queue.tick(now + 600_000);
  assert.equal(sent.length, 1);
});

test("the pause stops delivery, except for Send now", async () => {
  const { queue, sent, add } = await setup();
  queue.setPaused(true);
  const a = add("w1:p1", "a", 1);
  const b = add("w1:p2", "b", 2);
  assert.ok(typeof a !== "string" && typeof b !== "string");
  await queue.tick(10);
  assert.equal(sent.length, 0);
  queue.sendNow(b.id);
  await queue.tick(20);
  assert.deepEqual(sent.map((s) => s.text), ["b"]);
  queue.setPaused(false);
  await queue.tick(30);
  assert.deepEqual(sent.map((s) => s.text), ["b", "a"]);
});

test("Send now goes ahead of older items for its target", async () => {
  const { queue, sent, add } = await setup();
  add("w1:p1", "old", 1);
  const late = add("w1:p1", "late", 2);
  assert.ok(typeof late !== "string");
  queue.sendNow(late.id);
  await queue.tick(10);
  assert.deepEqual(sent.map((s) => s.text), ["late"]);
});

test("items for a pane that's gone are marked and later dropped; nothing happens without a fresh snapshot", async () => {
  const { queue, sent, state, add } = await setup();
  const item = add("w9:p9", "nobody", 1);
  assert.ok(typeof item !== "string");
  state.error = "herdr api snapshot: connection refused";
  await queue.tick(10);
  assert.equal(item.state, "pending", "a failed poll says nothing about panes");
  state.error = undefined;
  await queue.tick(20);
  assert.equal(item.state, "gone");
  assert.equal(sent.length, 0);
  await queue.tick(20 + GONE_KEEP_MS);
  assert.equal(queue.data.items.length, 0);
});

test("a pane without an agent waits", async () => {
  const { queue, sent, add } = await setup({ "w1:p1": null });
  const item = add("w1:p1", "hello", 1);
  await queue.tick(10);
  assert.equal(sent.length, 0);
  assert.ok(typeof item !== "string" && item.state === "pending");
});

test("coalescing replaces a pending item from the same link", async () => {
  const { queue } = await setup({ "w1:p1": "working" });
  const link = { kind: "handoff" as const, linkId: "l1", label: "Handoff" };
  queue.enqueue({ target: "w1:p1", targetLabel: "", text: "turn 1", source: link, coalesce: true }, 1);
  queue.enqueue({ target: "w1:p1", targetLabel: "", text: "turn 2", source: link, coalesce: true }, 2);
  assert.deepEqual(queue.data.items.map((i) => i.text), ["turn 2"]);
});

test("the queue, history, and pause survive a restart", async () => {
  const { deps, queue, add } = await setup({ "w1:p1": "working", "w1:p2": "idle" });
  add("w1:p1", "waiting", 1);
  add("w1:p2", "delivered", 2);
  queue.setPaused(true);
  queue.sendNow(queue.data.items[1].id);
  await queue.tick(10);
  await queue.save();
  const again = await openQueue(deps);
  assert.equal(again.data.paused, true);
  assert.deepEqual(again.data.items.map((i) => i.text), ["waiting"]);
  assert.deepEqual(again.data.history.map((i) => i.text), ["delivered"]);
});

test("a queue file with bad entries keeps the good ones", async () => {
  const { path } = await setup();
  const good = { id: "a", target: "w1:p1", text: "hi", createdAt: 1, attempts: 0, state: "pending", source };
  await writeFile(
    path,
    JSON.stringify({ paused: "yes", items: [good, { id: "b" }, good, null], history: "x" }),
  );
  const data = await loadQueueFile(path);
  assert.equal(data.paused, false);
  assert.deepEqual(data.items.map((i) => i.id), ["a"]);
  assert.deepEqual(data.history, []);
  await writeFile(path, "{ not json");
  assert.deepEqual((await loadQueueFile(path)).items, []);
});

test("saves are written whole", async () => {
  const { path, queue, add } = await setup();
  for (let i = 0; i < 20; i++) add("w1:p1", `item ${i}`, i);
  await queue.save();
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.items.length, 20);
});

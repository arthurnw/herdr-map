import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadStore } from "../server/layout-store.ts";
import { openQueue } from "../server/queue.ts";
import { linksRoutes } from "../server/routes/links.ts";
import { notesRoutes } from "../server/routes/notes.ts";
import { queueRoutes } from "../server/routes/queue.ts";
import { schedulesRoutes } from "../server/routes/schedules.ts";
import { textHash } from "../shared/automation.ts";
import { fleetWith } from "./fixtures.ts";
import { routeContext, serveRoutes } from "./http.ts";

/** Serves the automation routes over fresh files, with three agents and one plain pane. */
async function serve(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-map-"));
  const layoutPath = join(dir, "layout.json");
  const fleet = fleetWith({ "w1:p1": "working", "w1:p2": "idle", "w1:p3": "idle", "w1:p4": null });
  const poller = { state: () => ({ fleet, updatedAt: 1 }) };
  const queue = await openQueue({ path: join(dir, "queue.json"), view: poller.state, send: async () => {} });
  const ctx = routeContext({ layoutPath, poller, automation: { queue, tick: async () => {} } });
  const call = await serveRoutes(t, [...linksRoutes(ctx), ...notesRoutes(ctx), ...queueRoutes(ctx), ...schedulesRoutes(ctx)]);
  return { call, queue, store: () => loadStore(layoutPath) };
}

const pane = (id: string) => ({ kind: "pane", id });

test("a handoff link is stored and queues nothing until its source finishes", async (t) => {
  const { call, queue, store } = await serve(t);
  const res = await call("POST", "/api/links", { from: pane("w1:p1"), to: pane("w1:p2"), kind: "handoff" });
  assert.equal(res.status, 201);
  assert.equal((await store()).links.length, 1);
  assert.equal(queue.data.items.length, 0);
  assert.equal((await call("POST", "/api/links", { from: pane("w1:p1"), to: pane("w1:p2"), kind: "handoff" })).status, 409);
});

test("a handoff that would close a loop is refused", async (t) => {
  const { call } = await serve(t);
  assert.equal((await call("POST", "/api/links", { from: pane("w1:p1"), to: pane("w1:p2"), kind: "handoff" })).status, 201);
  assert.equal((await call("POST", "/api/links", { from: pane("w1:p2"), to: pane("w1:p3"), kind: "handoff" })).status, 201);
  const loop = await call("POST", "/api/links", { from: pane("w1:p3"), to: pane("w1:p1"), kind: "handoff" });
  assert.equal(loop.status, 409);
  assert.match(loop.body.error, /loop/);
  assert.equal((await call("POST", "/api/links", { from: pane("w1:p3"), to: pane("w1:p1"), kind: "context" })).status, 201, "context links can point back");
});

test("links must go from an agent or note to another agent", async (t) => {
  const { call, store } = await serve(t);
  for (const body of [
    { from: pane("w1:p1"), to: pane("w1:p1"), kind: "handoff" },
    { from: pane("w1:p1"), to: pane("w1:p4"), kind: "handoff" },
    { from: pane("w1:p4"), to: pane("w1:p2"), kind: "context" },
    { from: pane("w9:p9"), to: pane("w1:p2"), kind: "context" },
    { from: pane("w1:p1"), to: { kind: "note", id: "n" }, kind: "context" },
    { from: pane("w1:p1"), to: pane("w1:p2"), kind: "other" },
    { from: { kind: "note", id: "n" }, to: pane("w1:p2"), kind: "handoff" },
  ]) {
    assert.equal((await call("POST", "/api/links", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("POST", "/api/links", { from: { kind: "note", id: "missing" }, to: pane("w1:p2"), kind: "context" })).status, 409);
  assert.equal((await store()).links.length, 0);
});

test("a context link queues the read instructions once", async (t) => {
  const { call, queue, store } = await serve(t);
  const res = await call("POST", "/api/links", { from: pane("w1:p1"), to: pane("w1:p2"), kind: "context" });
  assert.equal(res.status, 201);
  assert.equal(queue.data.items.length, 1);
  const [item] = queue.data.items;
  assert.equal(item.target, "w1:p2");
  assert.equal(item.source.kind, "context");
  assert.match(item.text, /herdr agent read w1:p1 --lines 200/);
  assert.ok((await store()).links[0].sent?.at);
});

test("a note link sends the note, records what it sent, and can send an edit again", async (t) => {
  const { call, queue, store } = await serve(t);
  const note = (await call("POST", "/api/notes", { x: 0, y: 0, text: "check the flaky test" })).body;
  const res = await call("POST", "/api/links", { from: { kind: "note", id: note.id }, to: pane("w1:p2"), kind: "context" });
  assert.equal(res.status, 201);
  assert.equal(queue.data.items[0].text, "A note from the user:\n\ncheck the flaky test");
  assert.equal((await store()).links[0].sent?.hash, textHash("check the flaky test"));
  await call("PATCH", `/api/notes/${note.id}`, { text: "check the flaky test in CI" });
  queue.cancelWhere(() => true);
  assert.equal((await call("POST", `/api/links/${res.body.id}/send`)).status, 200);
  assert.match(queue.data.items[0].text, /in CI$/);
  assert.equal((await store()).links[0].sent?.hash, textHash("check the flaky test in CI"));
});

test("an empty note isn't linked", async (t) => {
  const { call, queue } = await serve(t);
  const note = (await call("POST", "/api/notes", { x: 0, y: 0 })).body;
  const res = await call("POST", "/api/links", { from: { kind: "note", id: note.id }, to: pane("w1:p2"), kind: "context" });
  assert.equal(res.status, 409);
  assert.equal(queue.data.items.length, 0);
});

test("deleting a link cancels what it queued", async (t) => {
  const { call, queue, store } = await serve(t);
  const link = (await call("POST", "/api/links", { from: pane("w1:p1"), to: pane("w1:p2"), kind: "handoff" })).body;
  const source = { kind: "handoff" as const, linkId: link.id, label: "Handoff" };
  queue.enqueue({ target: "w1:p2", targetLabel: "", text: "a handoff", source });
  assert.equal(queue.data.items.length, 1);
  assert.equal((await call("DELETE", `/api/links/${link.id}`)).status, 200);
  assert.equal(queue.data.items.length, 0);
  assert.equal((await store()).links.length, 0);
  assert.equal((await call("DELETE", `/api/links/${link.id}`)).status, 404);
});

test("queue routes: manual items, cancel, send now, retry, pause, and the combined state", async (t) => {
  const { call, queue } = await serve(t);
  assert.equal((await call("POST", "/api/queue", { target: "w1:p4", text: "hi" })).status, 400);
  assert.equal((await call("POST", "/api/queue", { target: "w1:p2", text: "  " })).status, 400);
  const item = (await call("POST", "/api/queue", { target: "w1:p2", text: "hi" })).body;
  assert.equal(item.source.kind, "manual");
  assert.equal((await call("POST", `/api/queue/${item.id}/send-now`)).body.sendNow, true);
  assert.equal((await call("POST", `/api/queue/${item.id}/retry`)).status, 200);
  assert.equal((await call("POST", "/api/automation/pause", { paused: "yes" })).status, 400);
  assert.equal((await call("POST", "/api/automation/pause", { paused: true })).body.paused, true);
  const state = (await call("GET", "/api/automation")).body;
  assert.equal(state.paused, true);
  assert.equal(state.items.length, 1);
  assert.deepEqual(state.links, []);
  assert.equal((await call("POST", `/api/queue/${item.id}/cancel`)).status, 200);
  assert.equal((await call("POST", `/api/queue/${item.id}/cancel`)).status, 404);
  assert.equal(queue.data.items.length, 0);
});

test("schedule routes: create unarmed, arm, edit disarms, delete", async (t) => {
  const { call } = await serve(t);
  const bad = [
    { target: "w1:p4", text: "x", timing: { kind: "interval", minutes: 5 } },
    { target: "w1:p2", text: "", timing: { kind: "interval", minutes: 5 } },
    { target: "w1:p2", text: "x", timing: { kind: "interval", minutes: 0 } },
    { target: "w1:p2", text: "x", timing: { kind: "daily", time: "7:00" } },
  ];
  for (const body of bad) assert.equal((await call("POST", "/api/schedules", body)).status, 400, JSON.stringify(body));
  const s = (await call("POST", "/api/schedules", { target: "w1:p2", text: "status?", timing: { kind: "daily", time: "09:00" } })).body;
  assert.equal(s.armed, false);
  assert.equal(s.nextRunAt, undefined);
  const armed = (await call("POST", `/api/schedules/${s.id}/arm`)).body;
  assert.equal(armed.armed, true);
  assert.ok(armed.nextRunAt > Date.now());
  const edited = (await call("PATCH", `/api/schedules/${s.id}`, { text: "status, please" })).body;
  assert.equal(edited.armed, false);
  assert.equal((await call("DELETE", `/api/schedules/${s.id}`)).status, 200);
  assert.equal((await call("POST", `/api/schedules/${s.id}/arm`)).status, 404);
});

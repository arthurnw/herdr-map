import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Context } from "../server/context.ts";
import { loadStore } from "../server/layout-store.ts";
import { openQueue } from "../server/queue.ts";
import { createRouter } from "../server/router.ts";
import { linksRoutes } from "../server/routes/links.ts";
import { queueRoutes } from "../server/routes/queue.ts";
import { fleetWith } from "./fixtures.ts";

/** Serves the automation routes over fresh files, with three agents and one plain pane. */
async function serve(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-map-"));
  const layoutPath = join(dir, "layout.json");
  const fleet = fleetWith({ "w1:p1": "working", "w1:p2": "idle", "w1:p3": "idle", "w1:p4": null });
  const poller = { state: () => ({ fleet, updatedAt: 1 }) };
  const queue = await openQueue({ path: join(dir, "queue.json"), view: poller.state, send: async () => {} });
  const ctx = { layoutPath, poller, automation: { queue, tick: async () => {} } } as unknown as Context;
  const routes = [...linksRoutes(ctx), ...queueRoutes(ctx)];
  const server = createServer(createRouter(routes, (_req, res) => res.end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
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
});

test("links must go from an agent to another agent", async (t) => {
  const { call, store } = await serve(t);
  for (const body of [
    { from: pane("w1:p1"), to: pane("w1:p1"), kind: "handoff" },
    { from: pane("w1:p1"), to: pane("w1:p4"), kind: "handoff" },
    { from: pane("w1:p4"), to: pane("w1:p2"), kind: "context" },
    { from: pane("w9:p9"), to: pane("w1:p2"), kind: "context" },
    { from: pane("w1:p1"), to: { kind: "note", id: "n" }, kind: "context" },
    { from: pane("w1:p1"), to: pane("w1:p2"), kind: "other" },
    { from: { kind: "note", id: "n" }, to: pane("w1:p2"), kind: "handoff" },
    { from: { kind: "note", id: "n" }, to: pane("w1:p2"), kind: "context" },
  ]) {
    assert.equal((await call("POST", "/api/links", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await store()).links.length, 0);
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


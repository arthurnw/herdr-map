import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Context } from "../server/context.ts";
import { openQueue } from "../server/queue.ts";
import { createRouter } from "../server/router.ts";
import { queueRoutes } from "../server/routes/queue.ts";
import { fleetWith } from "./fixtures.ts";

/** Serves the queue routes over a fresh queue file, with three agents and one plain pane. */
async function serve(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-map-"));
  const layoutPath = join(dir, "layout.json");
  const fleet = fleetWith({ "w1:p1": "working", "w1:p2": "idle", "w1:p3": "idle", "w1:p4": null });
  const poller = { state: () => ({ fleet, updatedAt: 1 }) };
  const queue = await openQueue({ path: join(dir, "queue.json"), view: poller.state, send: async () => {} });
  const ctx = { layoutPath, poller, automation: { queue, tick: async () => {} } } as unknown as Context;
  const routes = [...queueRoutes(ctx)];
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
  return { call, queue };
}

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
  assert.equal((await call("POST", `/api/queue/${item.id}/cancel`)).status, 200);
  assert.equal((await call("POST", `/api/queue/${item.id}/cancel`)).status, 404);
  assert.equal(queue.data.items.length, 0);
});


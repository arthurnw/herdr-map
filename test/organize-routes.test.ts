import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Context } from "../server/context.ts";
import { loadStore } from "../server/layout-store.ts";
import { createRouter } from "../server/router.ts";
import { metaRoutes } from "../server/routes/meta.ts";

/** Serves the organize routes over a fresh layout file. */
async function serve(t: TestContext) {
  const layoutPath = join(await mkdtemp(join(tmpdir(), "herdr-map-")), "layout.json");
  const ctx = { layoutPath } as Context;
  const server = createServer(createRouter([...metaRoutes(ctx)], (_req, res) => res.end()));
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
  return { call, store: () => loadStore(layoutPath) };
}

test("collapses and expands workspaces, dropping empty metadata", async (t) => {
  const { call, store } = await serve(t);
  assert.deepEqual((await call("GET", "/api/meta")).body, { workspaces: {}, groups: {} });
  const res = await call("POST", "/api/meta/workspaces", { ids: ["w1", "w2", "w1"], collapsed: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.workspaces, { w1: { collapsed: true }, w2: { collapsed: true } });
  await call("POST", "/api/meta/workspaces", { ids: ["w1"], collapsed: false });
  assert.deepEqual((await store()).workspaces, { w2: { collapsed: true } });
});

test("rejects bad workspace changes", async (t) => {
  const { call, store } = await serve(t);
  for (const body of [
    [],
    { ids: [] },
    { ids: "w1" },
    { ids: [""] },
    { ids: ["__proto__"], collapsed: true },
    { ids: ["x".repeat(600)] },
    { ids: Array.from({ length: 501 }, (_, i) => `w${i}`) },
    { ids: ["w1"], collapsed: "yes" },
  ]) {
    const res = await call("POST", "/api/meta/workspaces", body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await store()).workspaces, {});
});

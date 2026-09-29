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
import { notesRoutes } from "../server/routes/notes.ts";

/** Serves the organize routes over a fresh layout file. */
async function serve(t: TestContext) {
  const layoutPath = join(await mkdtemp(join(tmpdir(), "herdr-map-")), "layout.json");
  const ctx = { layoutPath } as Context;
  const server = createServer(createRouter([...metaRoutes(ctx), ...notesRoutes(ctx)], (_req, res) => res.end()));
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

test("colors workspaces and repo boxes from the allowed list", async (t) => {
  const { call, store } = await serve(t);
  await call("POST", "/api/meta/workspaces", { ids: ["w1"], color: "teal", collapsed: true });
  await call("POST", "/api/meta/groups", { key: "/r/api/.git", color: "purple" });
  assert.deepEqual(await store().then((s) => [s.workspaces, s.groups]), [
    { w1: { color: "teal", collapsed: true } },
    { "/r/api/.git": { color: "purple" } },
  ]);
  await call("POST", "/api/meta/workspaces", { ids: ["w1"], color: null });
  const res = await call("POST", "/api/meta/groups", { key: "/r/api/.git", color: null });
  assert.deepEqual(res.body, { workspaces: { w1: { collapsed: true } }, groups: {} });

  for (const [path, body] of [
    ["/api/meta/workspaces", { ids: ["w1"], color: "#ff0000" }],
    ["/api/meta/groups", { key: "/r/api/.git", color: "chartreuse" }],
    ["/api/meta/groups", { key: "/r/api/.git" }],
    ["/api/meta/groups", { key: "constructor", color: "red" }],
    ["/api/meta/groups", { color: "red" }],
  ] as const) {
    assert.equal((await call("POST", path, body)).status, 400, JSON.stringify(body));
  }
});

test("adds and removes tags, keeping each once", async (t) => {
  const { call, store } = await serve(t);
  await call("POST", "/api/meta/workspaces", { ids: ["w1", "w2"], addTags: ["infra", "urgent"] });
  await call("POST", "/api/meta/workspaces", { ids: ["w1"], addTags: ["infra", "v2.1"], removeTags: ["urgent"] });
  assert.deepEqual((await store()).workspaces, { w1: { tags: ["infra", "v2.1"] }, w2: { tags: ["infra", "urgent"] } });
  await call("POST", "/api/meta/workspaces", { ids: ["w2"], removeTags: ["infra", "urgent"] });
  assert.deepEqual((await store()).workspaces, { w1: { tags: ["infra", "v2.1"] } });

  for (const addTags of [["Infra"], ["has space"], ["-dash"], ["x".repeat(25)], "infra", [3], Array(13).fill("a")]) {
    assert.equal((await call("POST", "/api/meta/workspaces", { ids: ["w1"], addTags })).status, 400, JSON.stringify(addTags));
  }
});

test("creates, edits, and deletes notes", async (t) => {
  const { call, store } = await serve(t);
  const created = await call("POST", "/api/notes", { x: 10, y: -20, text: "remember", color: "yellow", w: 200, h: 120 });
  assert.equal(created.status, 201);
  const { id, createdAt } = created.body;
  assert.equal(typeof id, "string");
  assert.deepEqual((await call("GET", "/api/notes")).body, [created.body]);

  const edited = await call("PATCH", `/api/notes/${id}`, { text: "remember the milk", x: 30, color: null, extra: 1 });
  assert.equal(edited.status, 200);
  const note = (await store()).notes[0];
  assert.deepEqual({ ...note, updatedAt: 0 }, { id, text: "remember the milk", x: 30, y: -20, w: 200, h: 120, createdAt, updatedAt: 0 });

  assert.equal((await call("DELETE", `/api/notes/${id}`)).status, 200);
  assert.deepEqual((await store()).notes, []);
  assert.equal((await call("DELETE", `/api/notes/${id}`)).status, 404);
  assert.equal((await call("PATCH", "/api/notes/missing", { text: "x" })).status, 404);
});

test("rejects bad notes", async (t) => {
  const { call, store } = await serve(t);
  for (const body of [
    { y: 0 },
    { x: 0, y: "1" },
    { x: 1e9, y: 0 },
    { x: 0, y: 0, w: 10 },
    { x: 0, y: 0, h: 99999 },
    { x: 0, y: 0, text: 5 },
    { x: 0, y: 0, text: "x".repeat(10_001) },
    { x: 0, y: 0, color: "#fff" },
  ]) {
    assert.equal((await call("POST", "/api/notes", body)).status, 400, JSON.stringify(body));
  }
  const { body: note } = await call("POST", "/api/notes", { x: 0, y: 0 });
  assert.equal((await call("PATCH", `/api/notes/${note.id}`, { x: null })).status, 400);
  assert.equal((await call("PUT", `/api/notes/${note.id}`, {})).status, 405);
  assert.deepEqual((await store()).notes.map((n) => n.text), [""]);
});

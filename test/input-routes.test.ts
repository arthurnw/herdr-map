import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createRouter } from "../server/router.ts";
import { inputRoutes } from "../server/routes/input.ts";
import type { JsonValue } from "./fixtures.ts";
import { listen, routeContext, serveRoutes } from "./http.ts";

/** Serves the input routes against a stand-in herdr that records each command it gets. */
async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-map-input-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\n`);
  chmodSync(bin, 0o755);
  const seen: string[] = [];
  const ctx = routeContext({ herdr: { bin }, poller: { markSeen: (id) => void seen.push(id), poll: async () => {} } });
  const call = await serveRoutes(t, inputRoutes(ctx));
  const server = createServer(createRouter(inputRoutes(ctx), (_req, res) => void res.end()));
  const base = await listen(server);
  t.after(() => server.close());
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { call, calls, seen, base };
}

test("focus accepts an agent, tab, or workspace and sends the matching command", async (t) => {
  const { call, calls, seen } = await setup(t);
  assert.equal((await call("POST", "/api/focus", { kind: "agent", id: "w1:p2" })).status, 200);
  assert.equal((await call("POST", "/api/focus", { kind: "tab", id: "w1:t1" })).status, 200);
  assert.equal((await call("POST", "/api/focus", { kind: "workspace", id: "w1" })).status, 200);
  assert.deepEqual(calls(), ["agent focus w1:p2", "tab focus w1:t1", "workspace focus w1"]);
  assert.deepEqual(seen, ["w1:p2"]);
});

test("focus refuses a missing or unknown kind and a non-string id before reaching herdr", async (t) => {
  const { call, calls } = await setup(t);
  for (const body of [{ id: "w1" }, { kind: "pane", id: "w1" }, { kind: "agent", id: 5 }, { kind: "agent", id: "w1 p2" }, ["agent"]]) {
    const res = await call("POST", "/api/focus", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error);
  }
  assert.deepEqual(calls(), []);
});

test("prompt, text, and keys refuse bad panes, text, keys, and dialog answers", async (t) => {
  const { call, calls } = await setup(t);
  const bad: [string, JsonValue][] = [
    ["/api/prompt", { pane: 5, text: "hi" }],
    ["/api/prompt", { text: "hi" }],
    ["/api/prompt", { pane: "w1:p1", text: "" }],
    ["/api/text", { pane: "w1:p1", text: 3 }],
    ["/api/keys", { pane: "w1:p1", keys: "enter" }],
    ["/api/keys", { pane: "w1:p1", keys: ["rm -rf"] }],
    ["/api/keys", { pane: "w1:p1", keys: ["1"], expect: { key: 1 } }],
  ];
  for (const [path, body] of bad) assert.equal((await call("POST", path, body)).status, 400, `${path} ${JSON.stringify(body)}`);
  assert.deepEqual(calls(), []);
});

test("a body that isn't JSON is a bad request", async (t) => {
  const { calls, base } = await setup(t);
  const res = await fetch(`${base}/api/focus`, { method: "POST", body: "{" });
  assert.equal(res.status, 400);
  assert.deepEqual(calls(), []);
});

test("valid prompt, text, and keys reach herdr", async (t) => {
  const { call, calls } = await setup(t);
  assert.equal((await call("POST", "/api/prompt", { pane: "w1:p1", text: "hello" })).status, 200);
  assert.equal((await call("POST", "/api/text", { pane: "w1:p1", text: "draft" })).status, 200);
  assert.equal((await call("POST", "/api/keys", { pane: "w1:p1", keys: ["enter"] })).status, 200);
  assert.equal(calls().length, 3);
});

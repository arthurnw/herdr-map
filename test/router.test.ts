import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createRouter, matchRoute, type Route } from "../server/router.ts";

const ok = () => {};
const routes: Route[] = [
  { path: "/api/fleet", handle: ok },
  { method: "POST", path: "/api/focus", handle: ok },
  { path: "/api/layouts", handle: ok },
  { path: "/api/layouts/", prefix: true, handle: ok },
];

test("matches exact paths for any method when none is given", () => {
  assert.equal(matchRoute(routes, "GET", "/api/fleet"), routes[0]);
  assert.equal(matchRoute(routes, "DELETE", "/api/fleet"), routes[0]);
  assert.equal(matchRoute(routes, "GET", "/api/fleet/x"), undefined);
});

test("matches prefix routes, including the bare prefix", () => {
  assert.equal(matchRoute(routes, "PUT", "/api/layouts/focus%20mode"), routes[3]);
  assert.equal(matchRoute(routes, "GET", "/api/layouts/"), routes[3]);
  assert.equal(matchRoute(routes, "GET", "/api/layouts"), routes[2]);
});

test("skips a route whose method does not match", () => {
  assert.equal(matchRoute(routes, "POST", "/api/focus"), routes[1]);
  assert.equal(matchRoute(routes, "GET", "/api/focus"), undefined);
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("dispatches, 404s unknown API paths, falls back for the rest, and turns throws into 500", async (t) => {
  const server = createServer(
    createRouter(
      [
        { path: "/api/hello", handle: (_req, res) => res.end("hi") },
        { method: "POST", path: "/api/only-post", handle: (_req, res) => res.end("posted") },
        {
          path: "/api/boom",
          handle: async () => {
            throw new Error("kaboom");
          },
        },
      ],
      (_req, res, url) => res.end(`static ${url.pathname}`),
    ),
  );
  const base = await listen(server);
  t.after(() => server.close());

  assert.equal(await (await fetch(`${base}/api/hello`)).text(), "hi");

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "application/json");
  assert.deepEqual(await missing.json(), { error: "not found" });

  const wrongMethod = await fetch(`${base}/api/only-post`);
  assert.equal(wrongMethod.status, 404);
  assert.deepEqual(await wrongMethod.json(), { error: "not found" });

  assert.equal(await (await fetch(`${base}/index.html`)).text(), "static /index.html");
  assert.equal(await (await fetch(`${base}/api`)).text(), "static /api");

  const boom = await fetch(`${base}/api/boom`);
  assert.equal(boom.status, 500);
  assert.deepEqual(await boom.json(), { error: "kaboom" });
});

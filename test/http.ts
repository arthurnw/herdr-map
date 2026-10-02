import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import type { Context } from "../server/context.ts";
import { createRouter, type Route } from "../server/router.ts";
import type { JsonValue } from "./fixtures.ts";

/** Context fields and poller methods a route test provides; the routes under test read nothing else. */
export type ContextParts = { [K in keyof Context]?: Partial<Context[K]> };

export function routeContext(parts: ContextParts): Context {
  // SAFETY: each test passes every field and poller method its routes read.
  return parts as Context;
}

/** Starts `server` on a free local port; resolves to its base URL. */
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo.
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Serves `routes` until the test ends. Returns a client that sends JSON and reads the JSON reply. */
export async function serveRoutes(t: TestContext, routes: Route[]) {
  const server = createServer(createRouter(routes, (_req, res) => void res.end()));
  const base = await listen(server);
  t.after(() => server.close());
  return async (method: string, path: string, body?: JsonValue) => {
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(base + path, init);
    // Tests read reply fields directly; the assertions check them.
    const reply: any = await res.json();
    return { status: res.status, body: reply };
  };
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { errorMessage } from "../shared/errors.ts";
import { sendJson } from "./http.ts";

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

export interface Route {
  /** Omit to match any method. */
  method?: string;
  path: string;
  /** Match every pathname that starts with `path`, not only `path` itself. */
  prefix?: boolean;
  handle: Handler;
}

export function matchRoute(routes: Route[], method: string | undefined, pathname: string): Route | undefined {
  return routes.find(
    (r) => (r.method === undefined || r.method === method) && (r.prefix ? pathname.startsWith(r.path) : pathname === r.path),
  );
}

/**
 * Dispatches to the first matching route. An unmatched `/api/` path gets a JSON 404;
 * anything else goes to `fallback` (static files).
 */
export function createRouter(routes: Route[], fallback: Handler) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const route = matchRoute(routes, req.method, url.pathname);
      if (route) return await route.handle(req, res, url);
      if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
      return await fallback(req, res, url);
    } catch (err) {
      return sendJson(res, 500, { error: errorMessage(err) });
    }
  };
}

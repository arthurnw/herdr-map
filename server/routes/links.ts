import { randomUUID } from "node:crypto";
import { MAX_LINKS } from "../../shared/automation.ts";
import type { Endpoint, Link } from "../../shared/layout-types.ts";
import type { Context } from "../context.ts";
import { readBody, sendJson } from "../http.ts";
import { loadStore, updateStore } from "../layout-store.ts";
import type { Route } from "../router.ts";
import { agentPane, isObject } from "./queue.ts";

function parseEndpoint(v: unknown): Endpoint | undefined {
  if (!isObject(v) || (v.kind !== "pane" && v.kind !== "note") || typeof v.id !== "string" || !v.id) return undefined;
  return { kind: v.kind, id: v.id };
}

const sameEnd = (a: Endpoint, b: Endpoint) => a.kind === b.kind && a.id === b.id;

/** Whether handoffs already lead from pane `from` to pane `to`, so a handoff back would loop forever. */
function handoffReaches(links: Link[], from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const pane = queue.shift()!;
    if (pane === to) return true;
    for (const l of links) {
      if (l.kind === "handoff" && l.from.kind === "pane" && l.from.id === pane && !seen.has(l.to.id)) {
        seen.add(l.to.id);
        queue.push(l.to.id);
      }
    }
  }
  return false;
}

export function linksRoutes(ctx: Context): Route[] {
  const { layoutPath } = ctx;
  return [
    {
      path: "/api/links",
      handle: async (req, res) => {
        if (req.method === "GET") return sendJson(res, 200, (await loadStore(layoutPath)).links);
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const body = await readBody(req);
        if (!isObject(body)) return sendJson(res, 400, { error: "expected an object" });
        const from = parseEndpoint(body.from);
        const to = parseEndpoint(body.to);
        const kind = body.kind;
        if (kind !== "handoff") return sendJson(res, 400, { error: "kind must be handoff" });
        if (!from || !to || from.kind !== "pane" || to.kind !== "pane" || !agentPane(ctx, from.id) || !agentPane(ctx, to.id)) {
          return sendJson(res, 400, { error: "a link goes from an agent to another agent" });
        }
        if (sameEnd(from, to)) return sendJson(res, 400, { error: "an agent can't link to itself" });
        const result = await updateStore(layoutPath, (store): Link | string => {
          if (store.links.length >= MAX_LINKS) return `at most ${MAX_LINKS} links`;
          if (store.links.some((l) => l.kind === kind && sameEnd(l.from, from) && sameEnd(l.to, to))) return "that link already exists";
          if (handoffReaches(store.links, to.id, from.id)) {
            return "handoffs already lead back from that agent, so this one would loop";
          }
          const link: Link = { id: randomUUID(), from, to, kind, createdAt: Date.now() };
          store.links.push(link);
          return link;
        });
        if (typeof result === "string") return sendJson(res, 409, { error: result });
        void ctx.automation.tick();
        return sendJson(res, 201, result);
      },
    },
    {
      path: "/api/links/",
      prefix: true,
      handle: async (req, res, url) => {
        const [id, action] = url.pathname.slice("/api/links/".length).split("/").map(decodeURIComponent);
        if (req.method === "DELETE" && !action) {
          const removed = await updateStore(layoutPath, (store) => {
            const before = store.links.length;
            store.links = store.links.filter((l) => l.id !== id);
            return store.links.length < before;
          });
          if (!removed) return sendJson(res, 404, { error: "no such link" });
          // A deleted link sends nothing more, including what it had queued.
          ctx.automation.queue.cancelWhere((i) => i.source.linkId === id && i.state !== "gone");
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      },
    },
  ];
}

import type { AutomationState } from "../../shared/automation.ts";
import { indexPanes, paneLabel } from "../agents.ts";
import type { Context } from "../context.ts";
import { readBody, sendJson } from "../http.ts";
import { checkText } from "../queue.ts";
import type { Route } from "../router.ts";

type Obj = Record<string, unknown>;
export const isObject = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** The pane if it's an agent in the current fleet. */
export function agentPane(ctx: Context, id: unknown) {
  if (typeof id !== "string") return undefined;
  const info = indexPanes(ctx.poller.state().fleet).get(id);
  return info?.status ? info : undefined;
}

export function queueRoutes(ctx: Context): Route[] {
  const { queue } = ctx.automation;
  return [
    {
      method: "GET",
      path: "/api/automation",
      handle: async (_req, res) => {
        const { paused, items, history } = queue.data;
        return sendJson(res, 200, { paused, items, history } satisfies AutomationState);
      },
    },
    {
      method: "POST",
      path: "/api/automation/pause",
      handle: async (req, res) => {
        const body = await readBody(req);
        if (!isObject(body) || typeof body.paused !== "boolean") return sendJson(res, 400, { error: "paused must be true or false" });
        queue.setPaused(body.paused);
        if (!body.paused) void ctx.automation.tick();
        return sendJson(res, 200, { paused: queue.data.paused });
      },
    },
    {
      method: "POST",
      path: "/api/queue",
      handle: async (req, res) => {
        const body = await readBody(req);
        if (!isObject(body)) return sendJson(res, 400, { error: "expected an object" });
        const target = agentPane(ctx, body.target);
        if (!target) return sendJson(res, 400, { error: "target must be an agent pane" });
        const text = checkText(body.text);
        if (!text) return sendJson(res, 400, { error: "text must not be empty" });
        const item = queue.enqueue({
          target: target.paneId,
          targetLabel: paneLabel(target, target.paneId),
          text,
          source: { kind: "manual", label: "Queued by you" },
        });
        if (typeof item === "string") return sendJson(res, 409, { error: item });
        void ctx.automation.tick();
        return sendJson(res, 201, item);
      },
    },
    {
      method: "POST",
      path: "/api/queue/",
      prefix: true,
      handle: async (_req, res, url) => {
        const [id, action] = url.pathname.slice("/api/queue/".length).split("/").map(decodeURIComponent);
        if (action === "cancel") {
          return queue.cancel(id) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "no such item" });
        }
        const item = action === "send-now" ? queue.sendNow(id) : action === "retry" ? queue.retry(id) : null;
        if (item === null) return sendJson(res, 404, { error: "not found" });
        if (!item) return sendJson(res, 404, { error: "no such item, or its agent is gone" });
        void ctx.automation.tick();
        return sendJson(res, 200, item);
      },
    },
  ];
}

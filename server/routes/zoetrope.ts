import { fleetPanes } from "../../shared/model.ts";
import { isObject } from "../../shared/parse.ts";
import { hasZoetropeSession, ZOETROPE_PLUGIN } from "../../shared/zoetrope.ts";
import type { Context } from "../context.ts";
import { activateApp, assertId, focus, invokePluginAction, pluginEnabled } from "../herdr.ts";
import { readBody, sendJson } from "../http.ts";
import type { Route } from "../router.ts";

// The plugin's default: an overlay on the agent's pane that restores the layout when closed.
const OPEN_ACTION = "open";

export function zoetropeRoutes(ctx: Context): Route[] {
  return [
    {
      method: "GET",
      path: "/api/zoetrope",
      handle: async (_req, res) => {
        const available = await pluginEnabled(ctx.herdr, ZOETROPE_PLUGIN).catch(() => false);
        return sendJson(res, 200, { available });
      },
    },
    {
      method: "POST",
      path: "/api/zoetrope",
      handle: async (req, res) => {
        const body = await readBody(req);
        const pane = assertId(isObject(body) && typeof body.pane === "string" ? body.pane : "");
        const agent = fleetPanes(ctx.poller.state().fleet).find((p) => p.id === pane)?.agent;
        if (!hasZoetropeSession(agent)) {
          return sendJson(res, 400, { error: "herdr doesn't know this agent's Claude Code or Codex session." });
        }
        // The plugin opens the session of whichever pane herdr has focused.
        await focus(ctx.herdr, { kind: "agent", id: pane });
        ctx.poller.markSeen(pane);
        await invokePluginAction(ctx.herdr, ZOETROPE_PLUGIN, OPEN_ACTION);
        if (ctx.activate) await activateApp(ctx.activate);
        void ctx.poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
  ];
}

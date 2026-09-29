import { fleetPanes } from "../../shared/model.ts";
import { agentNameError } from "../../shared/names.ts";
import type { Context } from "../context.ts";
import { assertId, renameAgent } from "../herdr.ts";
import { readBody, sendJson } from "../http.ts";
import type { Route } from "../router.ts";

function otherNames(ctx: Context, paneId: string): string[] {
  return fleetPanes(ctx.poller.state().fleet).flatMap((p) => (p.id !== paneId && p.agent?.name ? [p.agent.name] : []));
}

export function renameRoutes(ctx: Context): Route[] {
  return [
    {
      method: "POST",
      path: "/api/rename",
      handle: async (req, res) => {
        const body = (await readBody(req)) as { pane?: unknown; name?: unknown };
        const pane = assertId(typeof body.pane === "string" ? body.pane : "");
        const invalid = agentNameError(body.name, otherNames(ctx, pane));
        if (invalid) return sendJson(res, 400, { error: invalid });
        try {
          await renameAgent(ctx.herdr, pane, body.name as string);
        } catch (err) {
          return sendJson(res, 502, { error: (err as Error).message });
        }
        void ctx.poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
  ];
}

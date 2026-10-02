import { fleetPanes } from "../../shared/model.ts";
import { errorMessage } from "../../shared/errors.ts";
import { agentNameError } from "../../shared/names.ts";
import { isObject } from "../../shared/parse.ts";
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
        const body = await readBody(req);
        const { pane: paneId, name } = isObject(body) ? body : {};
        const pane = assertId(typeof paneId === "string" ? paneId : "");
        const invalid = agentNameError(name, otherNames(ctx, pane));
        if (invalid) return sendJson(res, 400, { error: invalid });
        try {
          // SAFETY: agentNameError accepts only a string.
          await renameAgent(ctx.herdr, pane, name as string);
        } catch (err) {
          return sendJson(res, 502, { error: errorMessage(err) });
        }
        void ctx.poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
  ];
}

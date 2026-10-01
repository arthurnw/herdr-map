import { fleetPanes } from "../../shared/model.ts";
import type { Context } from "../context.ts";
import { sendJson } from "../http.ts";
import type { Route } from "../router.ts";

/**
 * The end of an agent's conversation from its transcript, for previews of agents whose terminal
 * keeps no scrollback. Only agents in the current fleet are read; the probe finds the transcript.
 */
export function transcriptRoutes(ctx: Context): Route[] {
  return [
    {
      method: "GET",
      path: "/api/history",
      handle: async (_req, res, url) => {
        const id = url.searchParams.get("pane") ?? "";
        const agent = fleetPanes(ctx.poller.state().fleet).find((p) => p.id === id)?.agent;
        if (!agent) return sendJson(res, 404, { error: "no such agent" });
        const out = await ctx.poller.history(id);
        if (out.error) return sendJson(res, 404, { error: out.error });
        return sendJson(res, 200, { text: out.text ?? "", kind: agent.kind, truncated: !!out.truncated });
      },
    },
  ];
}

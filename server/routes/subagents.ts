import type { Context } from "../context.ts";
import { sendJson } from "../http.ts";
import type { Route } from "../router.ts";

export function subagentRoutes(ctx: Context): Route[] {
  return [
    {
      method: "GET",
      path: "/api/subagent",
      handle: async (_req, res, url) => {
        const pane = url.searchParams.get("pane") ?? "";
        const id = url.searchParams.get("id") ?? "";
        try {
          return sendJson(res, 200, await ctx.poller.subagentTranscript(pane, id));
        } catch (err) {
          return sendJson(res, 404, { error: (err as Error).message });
        }
      },
    },
  ];
}

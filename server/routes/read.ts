import type { Context } from "../context.ts";
import { readPane } from "../herdr.ts";
import { sendJson } from "../http.ts";
import type { Route } from "../router.ts";

export function readRoutes(ctx: Context): Route[] {
  return [
    {
      path: "/api/read",
      handle: async (_req, res, url) => {
        const source = url.searchParams.get("source") === "recent" ? "recent" : "visible";
        const lines = Number(url.searchParams.get("lines") ?? 60);
        const text = await readPane(ctx.herdr, url.searchParams.get("pane") ?? "", source, lines);
        return sendJson(res, 200, { text });
      },
    },
  ];
}

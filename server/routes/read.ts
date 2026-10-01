import type { Context } from "../context.ts";
import { previewSource, readPane } from "../herdr.ts";
import { sendJson } from "../http.ts";
import type { Route } from "../router.ts";

export function readRoutes(ctx: Context): Route[] {
  return [
    {
      path: "/api/read",
      handle: async (_req, res, url) => {
        const pane = url.searchParams.get("pane") ?? "";
        const asked = url.searchParams.get("source") === "recent" ? "recent" : "visible";
        const source = previewSource(ctx.poller.pane(pane), asked);
        const lines = Number(url.searchParams.get("lines") ?? 60);
        const text = await readPane(ctx.herdr, pane, source, lines);
        // The pane has no scrollback to show, so the preview shows its transcript above the screen.
        return sendJson(res, 200, source === asked ? { text } : { text, history: true });
      },
    },
  ];
}

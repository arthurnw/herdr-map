import type { Context } from "../context.ts";
import { sendJson } from "../http.ts";
import type { Route } from "../router.ts";

export function fleetRoutes(ctx: Context): Route[] {
  const { poller } = ctx;
  return [
    {
      path: "/api/events",
      handle: (req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(poller.state())}\n\n`);
        poller.clients.add(res);
        req.on("close", () => poller.clients.delete(res));
      },
    },
    { path: "/api/fleet", handle: (_req, res) => sendJson(res, 200, poller.state()) },
  ];
}

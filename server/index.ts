import { createServer } from "node:http";
import { parseArgs } from "node:util";
import type { Context } from "./context.ts";
import type { HerdrOptions } from "./herdr.ts";
import { serveStatic } from "./http.ts";
import { defaultLayoutPath } from "./layout-store.ts";
import { createPoller } from "./poller.ts";
import { createRouter } from "./router.ts";
import { fleetRoutes } from "./routes/fleet.ts";
import { inputRoutes } from "./routes/input.ts";
import { layoutRoutes } from "./routes/layout.ts";
import { metaRoutes } from "./routes/meta.ts";
import { readRoutes } from "./routes/read.ts";
import { renameRoutes } from "./routes/rename.ts";
import { zoetropeRoutes } from "./routes/zoetrope.ts";

const { values: args } = parseArgs({
  options: {
    ssh: { type: "string" },
    herdr: { type: "string", default: "herdr" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "4747" },
    interval: { type: "string", default: "1500" },
    "stuck-minutes": { type: "string", default: "5" },
    activate: { type: "string", default: "Ghostty" },
    "no-activate": { type: "boolean", default: false },
    layout: { type: "string", default: defaultLayoutPath() },
    "probe-node": { type: "string" },
    "no-probe": { type: "boolean", default: false },
  },
});

const herdr: HerdrOptions = { ssh: args.ssh, bin: args.herdr! };
const intervalMs = Number(args.interval);
const ctx: Context = {
  herdr,
  layoutPath: args.layout!,
  activate: args["no-activate"] ? undefined : args.activate,
  poller: createPoller(
    herdr,
    intervalMs,
    Number(args["stuck-minutes"]) * 60_000,
    // Locally, the probe runs on this server's own Node unless told otherwise.
    args["no-probe"] ? undefined : { ssh: args.ssh, node: args["probe-node"] ?? (args.ssh ? "node" : process.execPath) },
  ),
};

const routes = [
  ...fleetRoutes(ctx),
  ...inputRoutes(ctx),
  ...layoutRoutes(ctx),
  ...metaRoutes(ctx),
  ...readRoutes(ctx),
  ...renameRoutes(ctx),
  ...zoetropeRoutes(ctx),
];
const server = createServer(createRouter(routes, (_req, res, url) => serveStatic(url.pathname, res)));

server.listen(Number(args.port), args.host, () => {
  const source = herdr.ssh ? `ssh ${herdr.ssh}` : "local herdr";
  console.log(`herdr-map on http://${args.host}:${args.port} (${source}, every ${intervalMs}ms)`);
  void ctx.poller.poll();
});

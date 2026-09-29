import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { buildFleet, StatusClock, type Fleet } from "../shared/model.ts";
import {
  activateApp,
  focus,
  promptAgent,
  readPane,
  sendKeys,
  sendText,
  snapshot,
  type FocusTarget,
  type HerdrOptions,
} from "./herdr.ts";
import { defaultLayoutPath, isLayoutName, isSavedLayout, loadStore, updateStore } from "./layout-store.ts";

const { values: args } = parseArgs({
  options: {
    ssh: { type: "string" },
    herdr: { type: "string", default: "herdr" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "4747" },
    interval: { type: "string", default: "1500" },
    activate: { type: "string", default: "Ghostty" },
    "no-activate": { type: "boolean", default: false },
    layout: { type: "string", default: defaultLayoutPath() },
  },
});
const layoutPath = args.layout!;

const herdr: HerdrOptions = { ssh: args.ssh, bin: args.herdr! };
const intervalMs = Number(args.interval);
const activate = args["no-activate"] ? undefined : args.activate;
const distDir = join(import.meta.dirname, "..", "dist");

interface State {
  fleet?: Fleet;
  error?: string;
  updatedAt?: number;
}

const clock = new StatusClock();
const clients = new Set<ServerResponse>();
let state: State = {};
let lastPayload = "";
let pollTimer: NodeJS.Timeout | undefined;
let polling = false;
let pollAgain = false;

function broadcast(payload: string) {
  for (const res of clients) res.write(`data: ${payload}\n\n`);
}

async function poll(): Promise<void> {
  // A focus request asks for an immediate poll; never run two at once.
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;
  clearTimeout(pollTimer);
  try {
    const snap = await snapshot(herdr);
    const now = Date.now();
    state = { fleet: buildFleet(snap, clock.observe(snap.agents, now)), updatedAt: now };
  } catch (err) {
    state = { ...state, error: (err as Error).message };
  }
  const { updatedAt, ...rest } = state;
  const payload = JSON.stringify(rest);
  // Only push when something visible changed; clients age timestamps locally.
  if (payload !== lastPayload) {
    lastPayload = payload;
    broadcast(JSON.stringify(state));
  }
  polling = false;
  if (pollAgain) {
    pollAgain = false;
    return poll();
  }
  pollTimer = setTimeout(poll, intervalMs);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("request body too large");
  }
  return JSON.parse(raw || "{}");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

async function serveStatic(path: string, res: ServerResponse) {
  // normalize() resolves `..` against the leading `/`, so rel stays inside distDir.
  const rel = normalize(path === "/" ? "/index.html" : path);
  try {
    const body = await readFile(join(distDir, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(path === "/" ? "dist/ not found. Run `npm run build` first." : "not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/fleet") return sendJson(res, 200, state);
    if (url.pathname === "/api/focus" && req.method === "POST") {
      const target = (await readBody(req)) as FocusTarget;
      await focus(herdr, target);
      if (activate) await activateApp(activate);
      void poll();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/layout") {
      if (req.method === "PUT") {
        const layout = await readBody(req);
        if (!isSavedLayout(layout)) return sendJson(res, 400, { error: "invalid layout" });
        await updateStore(layoutPath, (store) => {
          store.current = layout;
        });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 200, (await loadStore(layoutPath)).current);
    }
    if (url.pathname === "/api/layouts") return sendJson(res, 200, (await loadStore(layoutPath)).named);
    if (url.pathname.startsWith("/api/layouts/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/layouts/".length));
      if (!isLayoutName(name)) return sendJson(res, 400, { error: "invalid layout name" });
      if (req.method === "PUT") {
        const layout = await readBody(req);
        if (!isSavedLayout(layout)) return sendJson(res, 400, { error: "invalid layout" });
        await updateStore(layoutPath, (store) => {
          store.named[name] = { savedAt: Date.now(), layout };
        });
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        await updateStore(layoutPath, (store) => {
          delete store.named[name];
        });
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (url.pathname === "/api/read") {
      const source = url.searchParams.get("source") === "recent" ? "recent" : "visible";
      const lines = Number(url.searchParams.get("lines") ?? 60);
      const text = await readPane(herdr, url.searchParams.get("pane") ?? "", source, lines);
      return sendJson(res, 200, { text });
    }
    if (req.method === "POST" && ["/api/prompt", "/api/keys", "/api/text"].includes(url.pathname)) {
      const body = (await readBody(req)) as { pane?: string; text?: unknown; keys?: unknown };
      const pane = body.pane ?? "";
      if (url.pathname === "/api/prompt") await promptAgent(herdr, pane, body.text);
      else if (url.pathname === "/api/keys") await sendKeys(herdr, pane, body.keys);
      else await sendText(herdr, pane, body.text);
      void poll();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
    return serveStatic(url.pathname, res);
  } catch (err) {
    return sendJson(res, 500, { error: (err as Error).message });
  }
});

// SSE proxies and browsers drop idle streams; a comment line keeps them open.
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 20_000);

server.listen(Number(args.port), args.host, () => {
  const source = herdr.ssh ? `ssh ${herdr.ssh}` : "local herdr";
  console.log(`herdr-map on http://${args.host}:${args.port} (${source}, every ${intervalMs}ms)`);
  void poll();
});

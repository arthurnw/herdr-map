import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const distDir = join(import.meta.dirname, "..", "dist");

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- any value JSON.stringify accepts
export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- the body is unparsed; each route checks it
export async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("request body too large");
  }
  return JSON.parse(raw || "{}");
}

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript"],
  [".css", "text/css"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".woff2", "font/woff2"],
  [".webmanifest", "application/manifest+json"],
]);

export async function serveStatic(path: string, res: ServerResponse) {
  // normalize() resolves `..` against the leading `/`, so rel stays inside distDir.
  const rel = normalize(path === "/" ? "/index.html" : path);
  try {
    const body = await readFile(join(distDir, rel));
    res.writeHead(200, { "content-type": MIME.get(extname(rel)) ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(path === "/" ? "dist/ not found. Run `npm run build` first." : "not found");
  }
}

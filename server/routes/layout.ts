import type { Context } from "../context.ts";
import { readBody, sendJson } from "../http.ts";
import { isLayoutName, isSavedLayout, loadStore, updateStore } from "../layout-store.ts";
import type { Route } from "../router.ts";

export function layoutRoutes(ctx: Context): Route[] {
  const { layoutPath } = ctx;
  return [
    {
      path: "/api/layout",
      handle: async (req, res) => {
        if (req.method === "PUT") {
          const layout = await readBody(req);
          if (!isSavedLayout(layout)) return sendJson(res, 400, { error: "invalid layout" });
          await updateStore(layoutPath, (store) => {
            store.current = layout;
          });
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 200, (await loadStore(layoutPath)).current);
      },
    },
    { path: "/api/layouts", handle: async (_req, res) => sendJson(res, 200, (await loadStore(layoutPath)).named) },
    {
      path: "/api/layouts/",
      prefix: true,
      handle: async (req, res, url) => {
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
      },
    },
  ];
}

import type { Context } from "../context.ts";
import { sendJson } from "../http.ts";
import { stepHistory, updateStore } from "../layout-store.ts";
import type { Route } from "../router.ts";

/**
 * Undo and redo for the current layout. Every change saved through PUT /api/layout goes
 * on the store's history; undo moves back through it and redo forward again.
 */
export function historyRoutes(ctx: Context): Route[] {
  const { layoutPath } = ctx;
  return (["undo", "redo"] as const).map((direction) => ({
    method: "POST",
    path: `/api/layout/${direction}`,
    handle: async (_req, res) => {
      const result = await updateStore(layoutPath, (store) => {
        const layout = stepHistory(store, direction);
        return { layout, undo: store.history.length, redo: store.future?.length ?? 0 };
      });
      if (!result.layout) return sendJson(res, 409, { error: `nothing to ${direction}`, ...result });
      return sendJson(res, 200, result);
    },
  }));
}

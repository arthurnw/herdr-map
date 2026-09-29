import type { Context } from "../context.ts";
import { readBody, sendJson } from "../http.ts";
import { isRecordKey, loadStore, updateStore } from "../layout-store.ts";
import type { Route } from "../router.ts";
import { applyWorkspacePatch, type MetaState, type WorkspacePatch } from "../../shared/organize.ts";
import type { LayoutStore } from "../../shared/layout-types.ts";

const MAX_IDS = 500;
const MAX_KEY_LENGTH = 512;

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

/** A workspace id or repo box key: usable as a record key and of a sane length. */
function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_KEY_LENGTH && isRecordKey(value);
}

/** Checks a workspace change request; returns the patch or an error message. */
export function parseWorkspacePatch(body: unknown): WorkspacePatch | string {
  if (!isObject(body)) return "expected an object";
  const { ids, collapsed } = body;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every(isKey)) {
    return `ids must be 1 to ${MAX_IDS} workspace ids`;
  }
  const patch: WorkspacePatch = { ids: [...new Set(ids)] };
  if (collapsed !== undefined) {
    if (typeof collapsed !== "boolean") return "collapsed must be true or false";
    patch.collapsed = collapsed;
  }
  return patch;
}

const metaOf = (store: LayoutStore): MetaState => ({ workspaces: store.workspaces, groups: store.groups });

export function metaRoutes(ctx: Context): Route[] {
  const { layoutPath } = ctx;
  return [
    { method: "GET", path: "/api/meta", handle: async (_req, res) => sendJson(res, 200, metaOf(await loadStore(layoutPath))) },
    {
      method: "POST",
      path: "/api/meta/workspaces",
      handle: async (req, res) => {
        const patch = parseWorkspacePatch(await readBody(req));
        if (typeof patch === "string") return sendJson(res, 400, { error: patch });
        const meta = await updateStore(layoutPath, (store) => {
          applyWorkspacePatch(store.workspaces, patch);
          return metaOf(store);
        });
        return sendJson(res, 200, meta);
      },
    },
  ];
}

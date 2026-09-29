import type { Context } from "../context.ts";
import { readBody, sendJson } from "../http.ts";
import { isRecordKey, loadStore, updateStore } from "../layout-store.ts";
import type { Route } from "../router.ts";
import {
  applyGroupPatch,
  applyWorkspacePatch,
  COLORS,
  isColor,
  isTag,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  type GroupPatch,
  type MetaState,
  type WorkspacePatch,
} from "../../shared/organize.ts";
import type { LayoutStore } from "../../shared/layout-types.ts";

const MAX_IDS = 500;
const MAX_KEY_LENGTH = 512;
const COLOR_ERROR = `color must be null or one of ${COLORS.join(", ")}`;

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

/** A workspace id or repo box key: usable as a record key and of a sane length. */
function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_KEY_LENGTH && isRecordKey(value);
}

/** Checks a workspace change request; returns the patch or an error message. */
export function parseWorkspacePatch(body: unknown): WorkspacePatch | string {
  if (!isObject(body)) return "expected an object";
  const { ids, collapsed, color } = body;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every(isKey)) {
    return `ids must be 1 to ${MAX_IDS} workspace ids`;
  }
  const patch: WorkspacePatch = { ids: [...new Set(ids)] };
  if (collapsed !== undefined) {
    if (typeof collapsed !== "boolean") return "collapsed must be true or false";
    patch.collapsed = collapsed;
  }
  if (color !== undefined) {
    if (color !== null && !isColor(color)) return COLOR_ERROR;
    patch.color = color;
  }
  for (const field of ["addTags", "removeTags"] as const) {
    const tags = body[field];
    if (tags === undefined) continue;
    if (!Array.isArray(tags) || tags.length > MAX_TAGS || !tags.every(isTag)) {
      return `${field} must be up to ${MAX_TAGS} tags of lowercase letters, digits, ".", "_", or "-" (at most ${MAX_TAG_LENGTH} characters)`;
    }
    patch[field] = tags;
  }
  return patch;
}

/** Checks a repo box color request; returns the patch or an error message. */
export function parseGroupPatch(body: unknown): GroupPatch | string {
  if (!isObject(body)) return "expected an object";
  if (!isKey(body.key)) return "key must be a repo box key";
  if (body.color !== null && !isColor(body.color)) return COLOR_ERROR;
  return { key: body.key, color: body.color };
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
    {
      method: "POST",
      path: "/api/meta/groups",
      handle: async (req, res) => {
        const patch = parseGroupPatch(await readBody(req));
        if (typeof patch === "string") return sendJson(res, 400, { error: patch });
        const meta = await updateStore(layoutPath, (store) => {
          applyGroupPatch(store.groups, patch);
          return metaOf(store);
        });
        return sendJson(res, 200, meta);
      },
    },
  ];
}

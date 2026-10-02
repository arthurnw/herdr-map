import { randomUUID } from "node:crypto";
import type { Context } from "../context.ts";
import { readBody, sendJson } from "../http.ts";
import { loadStore, updateStore } from "../layout-store.ts";
import type { Route } from "../router.ts";
import type { Note } from "../../shared/layout-types.ts";
import {
  COLORS,
  isColor,
  MAX_COORD,
  MAX_NOTES,
  NOTE_MAX,
  NOTE_MIN,
  NOTE_TEXT_MAX,
  type NotePatch,
} from "../../shared/organize.ts";
import { isFiniteNumber, isObject } from "../../shared/parse.ts";

const inRange = (v: unknown, min: number, max: number): v is number => isFiniteNumber(v) && v >= min && v <= max;

/** Checks note fields; `x` and `y` are required when creating. Returns the patch or an error message. */
export function parseNotePatch(body: unknown, creating: boolean): NotePatch | string {
  if (!isObject(body)) return "expected an object";
  const patch: NotePatch = {};
  for (const axis of ["x", "y"] as const) {
    const v = body[axis];
    if (v === undefined && !creating) continue;
    if (!inRange(v, -MAX_COORD, MAX_COORD)) return `${axis} must be a number within ±${MAX_COORD}`;
    patch[axis] = v;
  }
  for (const side of ["w", "h"] as const) {
    const v = body[side];
    if (v === undefined) continue;
    if (!inRange(v, NOTE_MIN[side], NOTE_MAX)) return `${side} must be between ${NOTE_MIN[side]} and ${NOTE_MAX}`;
    patch[side] = v;
  }
  if (body.text !== undefined) {
    if (typeof body.text !== "string" || body.text.length > NOTE_TEXT_MAX) return `text must be a string of at most ${NOTE_TEXT_MAX} characters`;
    patch.text = body.text;
  }
  if (body.color !== undefined) {
    if (body.color !== null && !isColor(body.color)) return `color must be null or one of ${COLORS.join(", ")}`;
    patch.color = body.color;
  }
  return patch;
}

function applyNotePatch(note: Note, patch: NotePatch, now: number) {
  const { color, ...rest } = patch;
  Object.assign(note, rest);
  if (color) note.color = color;
  if (color === null) delete note.color;
  note.updatedAt = now;
}

export function notesRoutes(ctx: Context): Route[] {
  const { layoutPath } = ctx;
  return [
    {
      path: "/api/notes",
      handle: async (req, res) => {
        if (req.method === "GET") return sendJson(res, 200, (await loadStore(layoutPath)).notes);
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const patch = parseNotePatch(await readBody(req), true);
        if (typeof patch === "string") return sendJson(res, 400, { error: patch });
        const note = await updateStore(layoutPath, (store) => {
          if (store.notes.length >= MAX_NOTES) return undefined;
          const now = Date.now();
          const created: Note = { id: randomUUID(), text: "", x: 0, y: 0, createdAt: now, updatedAt: now };
          applyNotePatch(created, patch, now);
          store.notes.push(created);
          return created;
        });
        if (!note) return sendJson(res, 409, { error: `at most ${MAX_NOTES} notes` });
        return sendJson(res, 201, note);
      },
    },
    {
      path: "/api/notes/",
      prefix: true,
      handle: async (req, res, url) => {
        const id = decodeURIComponent(url.pathname.slice("/api/notes/".length));
        if (req.method === "PATCH") {
          const patch = parseNotePatch(await readBody(req), false);
          if (typeof patch === "string") return sendJson(res, 400, { error: patch });
          const note = await updateStore(layoutPath, (store) => {
            const found = store.notes.find((n) => n.id === id);
            if (found) applyNotePatch(found, patch, Date.now());
            return found;
          });
          return note ? sendJson(res, 200, note) : sendJson(res, 404, { error: "no such note" });
        }
        if (req.method === "DELETE") {
          const removed = await updateStore(layoutPath, (store) => {
            const before = store.notes.length;
            store.notes = store.notes.filter((n) => n.id !== id);
            return store.notes.length < before;
          });
          return removed ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "no such note" });
        }
        return sendJson(res, 405, { error: "method not allowed" });
      },
    },
  ];
}

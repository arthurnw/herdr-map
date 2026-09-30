import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Endpoint,
  GroupMeta,
  LayoutStore,
  Link,
  NamedLayout,
  Note,
  SavedLayout,
  WorkspaceMeta,
} from "../shared/layout-types.ts";

export type { LayoutStore, NamedLayout, SavedLayout } from "../shared/layout-types.ts";

export const LAYOUT_VERSION = 2;
export const HISTORY_LIMIT = 50;

export function defaultLayoutPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "herdr-map", "layout.json");
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPosition(p: unknown): p is SavedLayout[string] {
  return (
    isObject(p) &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    (p.detached === undefined || typeof p.detached === "boolean")
  );
}

export function isSavedLayout(value: unknown): value is SavedLayout {
  return isObject(value) && Object.values(value).every(isPosition);
}

const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function isLayoutName(name: string): boolean {
  return (
    name.trim() === name &&
    name.length > 0 &&
    name.length <= 64 &&
    !/[\u0000-\u001f]/.test(name) &&
    !RESERVED_NAMES.has(name)
  );
}

// Assigning "__proto__" on a plain object replaces its prototype instead of adding a key.
export function isRecordKey(key: string): boolean {
  return key.length > 0 && !RESERVED_NAMES.has(key);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function emptyStore(): LayoutStore {
  return { version: 2, current: {}, named: {}, workspaces: {}, groups: {}, notes: [], links: [], history: [] };
}

// The parsers below copy valid entries one by one, so a single bad value costs only
// that entry rather than the whole file.

function parseLayout(value: unknown): SavedLayout {
  const out: SavedLayout = {};
  if (!isObject(value)) return out;
  for (const [id, p] of Object.entries(value)) {
    if (!isRecordKey(id) || !isPosition(p)) continue;
    out[id] = p.detached === undefined ? { x: p.x, y: p.y } : { x: p.x, y: p.y, detached: p.detached };
  }
  return out;
}

function parseNamed(value: unknown): Record<string, NamedLayout> {
  const out: Record<string, NamedLayout> = {};
  if (!isObject(value)) return out;
  for (const [name, e] of Object.entries(value)) {
    if (isLayoutName(name) && isObject(e) && Number.isFinite(e.savedAt) && isObject(e.layout)) {
      out[name] = { savedAt: e.savedAt as number, layout: parseLayout(e.layout) };
    }
  }
  return out;
}

function parseColor(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseWorkspaceMeta(value: Obj): WorkspaceMeta {
  const out: WorkspaceMeta = {};
  if (Array.isArray(value.tags)) out.tags = [...new Set(value.tags.filter(isId))];
  const color = parseColor(value.color);
  if (color) out.color = color;
  if (typeof value.collapsed === "boolean") out.collapsed = value.collapsed;
  return out;
}

function parseGroupMeta(value: Obj): GroupMeta {
  const color = parseColor(value.color);
  return color ? { color } : {};
}

function parseRecord<T>(value: unknown, parse: (entry: Obj) => T): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isObject(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (isRecordKey(key) && isObject(entry)) out[key] = parse(entry);
  }
  return out;
}

function parseNote(n: unknown): Note | undefined {
  if (!isObject(n) || !isId(n.id) || typeof n.text !== "string") return undefined;
  if (![n.x, n.y, n.createdAt, n.updatedAt].every(Number.isFinite)) return undefined;
  const note: Note = {
    id: n.id,
    text: n.text,
    x: n.x as number,
    y: n.y as number,
    createdAt: n.createdAt as number,
    updatedAt: n.updatedAt as number,
  };
  // Bad optional fields fall back to the UI defaults rather than dropping the note.
  if (Number.isFinite(n.w) && (n.w as number) > 0) note.w = n.w as number;
  if (Number.isFinite(n.h) && (n.h as number) > 0) note.h = n.h as number;
  const color = parseColor(n.color);
  if (color) note.color = color;
  return note;
}

function parseEndpoint(e: unknown): Endpoint | undefined {
  if (!isObject(e) || (e.kind !== "pane" && e.kind !== "note") || !isId(e.id)) return undefined;
  return { kind: e.kind, id: e.id };
}

function parseLink(l: unknown): Link | undefined {
  if (!isObject(l) || !isId(l.id) || (l.kind !== "context" && l.kind !== "handoff")) return undefined;
  const from = parseEndpoint(l.from);
  const to = parseEndpoint(l.to);
  if (!from || !to || !Number.isFinite(l.createdAt)) return undefined;
  const link: Link = { id: l.id, from, to, kind: l.kind, createdAt: l.createdAt as number };
  if (isObject(l.sent) && Number.isFinite(l.sent.at)) {
    link.sent = { at: l.sent.at as number };
  }
  return link;
}

/** Parses each entry and drops invalid ones and repeated ids (first one wins). */
function parseList<T extends { id: string }>(value: unknown, parse: (entry: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of value) {
    const item = parse(entry);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

interface ReadResult {
  store: LayoutStore;
  /** The version the file declared; 1 for files from before versioning. */
  fileVersion: number;
  /** The file exists but isn't valid JSON. */
  corrupt?: boolean;
}

function parseStore(value: unknown): ReadResult {
  if (!isObject(value)) return { store: emptyStore(), fileVersion: LAYOUT_VERSION };
  // v1 files from before named layouts existed hold just the current layout.
  if (!("current" in value) && !("version" in value)) {
    return { store: { ...emptyStore(), current: parseLayout(value) }, fileVersion: 1 };
  }
  return {
    store: {
      version: 2,
      current: parseLayout(value.current),
      named: parseNamed(value.named),
      workspaces: parseRecord(value.workspaces, parseWorkspaceMeta),
      groups: parseRecord(value.groups, parseGroupMeta),
      notes: parseList(value.notes, parseNote),
      links: parseList(value.links, parseLink),
      history: Array.isArray(value.history) ? value.history.filter(isObject).map(parseLayout) : [],
      // Left out when empty, so files written before redo existed read back unchanged.
      ...(Array.isArray(value.future) && value.future.length > 0
        ? { future: value.future.filter(isObject).map(parseLayout) }
        : {}),
    },
    fileVersion: Number.isFinite(value.version) ? (value.version as number) : 1,
  };
}

async function readStore(path: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { store: emptyStore(), fileVersion: LAYOUT_VERSION };
  }
  try {
    return parseStore(JSON.parse(raw));
  } catch {
    return { store: emptyStore(), fileVersion: LAYOUT_VERSION, corrupt: true };
  }
}

/** Reads and migrates the store. Files from a newer version load as far as this version understands them. */
export async function loadStore(path: string): Promise<LayoutStore> {
  return (await readStore(path)).store;
}

export async function saveStore(path: string, store: LayoutStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...store, version: LAYOUT_VERSION }, null, 2) + "\n");
}

// Requests can arrive back to back (a drag stop, then a save), so read-modify-write
// cycles run one at a time.
let queue: Promise<unknown> = Promise.resolve();

export function updateStore<T>(path: string, fn: (store: LayoutStore) => T): Promise<T> {
  const run = queue.then(async () => {
    const { store, fileVersion, corrupt } = await readStore(path);
    // Writing would drop fields this version doesn't know about.
    if (fileVersion > LAYOUT_VERSION) {
      throw new Error(
        `${path} uses layout version ${fileVersion}, newer than this herdr-map supports (${LAYOUT_VERSION}); not overwriting it`,
      );
    }
    // Keep an unreadable file (say, hand-edited with a typo) before starting a new one.
    if (corrupt) await copyFile(path, `${path}.corrupt-${new Date().toISOString().replaceAll(":", "-")}`);
    const result = fn(store);
    await saveStore(path, store);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Appends a previous `current` layout to the undo history, keeping the newest `limit` entries. */
export function pushHistory(store: LayoutStore, layout: SavedLayout, limit = HISTORY_LIMIT): void {
  store.history.push(layout);
  if (store.history.length > limit) store.history.splice(0, store.history.length - limit);
}

/** True when two layouts place the same workspaces at the same spots, in or out of their boxes. */
export function sameLayout(a: SavedLayout, b: SavedLayout): boolean {
  const ids = Object.keys(a);
  if (ids.length !== Object.keys(b).length) return false;
  return ids.every((id) => {
    const p = a[id];
    const q = b[id];
    return q !== undefined && p.x === q.x && p.y === q.y && !!p.detached === !!q.detached;
  });
}

/**
 * Makes `layout` current. A real change records the old layout for undo and drops the redo
 * list; returns whether anything changed.
 */
export function setCurrent(store: LayoutStore, layout: SavedLayout): boolean {
  if (sameLayout(store.current, layout)) return false;
  pushHistory(store, store.current);
  delete store.future;
  store.current = layout;
  return true;
}

/** Steps back to the previous layout, or forward again with `redo`. Returns the new current layout, if any. */
export function stepHistory(store: LayoutStore, direction: "undo" | "redo"): SavedLayout | undefined {
  const from = direction === "undo" ? store.history : (store.future ??= []);
  const to = direction === "undo" ? (store.future ??= []) : store.history;
  const layout = from.pop();
  if (layout) {
    to.push(store.current);
    if (to.length > HISTORY_LIMIT) to.splice(0, to.length - HISTORY_LIMIT);
    store.current = layout;
  }
  if (store.future?.length === 0) delete store.future;
  return layout;
}

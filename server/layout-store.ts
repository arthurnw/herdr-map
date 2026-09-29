import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SavedLayout = Record<string, { x: number; y: number; detached?: boolean }>;

export interface NamedLayout {
  savedAt: number;
  layout: SavedLayout;
}

/** The layout in use plus named layouts the user saved to restore later. */
export interface LayoutStore {
  current: SavedLayout;
  named: Record<string, NamedLayout>;
}

export function defaultLayoutPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "herdr-map", "layout.json");
}

export function isSavedLayout(value: unknown): value is SavedLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (p) =>
      p !== null &&
      typeof p === "object" &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      (p.detached === undefined || typeof p.detached === "boolean"),
  );
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

function parseStore(value: unknown): LayoutStore {
  if (value && typeof value === "object" && "current" in value) {
    const { current, named } = value as { current: unknown; named?: unknown };
    const out: LayoutStore = { current: isSavedLayout(current) ? current : {}, named: {} };
    if (named && typeof named === "object") {
      for (const [name, entry] of Object.entries(named)) {
        const e = entry as Partial<NamedLayout> | null;
        if (isLayoutName(name) && e && Number.isFinite(e.savedAt) && isSavedLayout(e.layout)) {
          out.named[name] = e as NamedLayout;
        }
      }
    }
    return out;
  }
  // Files written before named layouts existed hold just the current layout.
  return { current: isSavedLayout(value) ? value : {}, named: {} };
}

export async function loadStore(path: string): Promise<LayoutStore> {
  try {
    return parseStore(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { current: {}, named: {} };
  }
}

export async function saveStore(path: string, store: LayoutStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + "\n");
}

// Requests can arrive back to back (a drag stop, then a save), so read-modify-write
// cycles run one at a time.
let queue: Promise<unknown> = Promise.resolve();

export function updateStore<T>(path: string, fn: (store: LayoutStore) => T): Promise<T> {
  const run = queue.then(async () => {
    const store = await loadStore(path);
    const result = fn(store);
    await saveStore(path, store);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

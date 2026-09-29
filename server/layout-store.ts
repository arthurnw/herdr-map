import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SavedLayout = Record<string, { x: number; y: number; detached?: boolean }>;

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

export async function loadLayout(path: string): Promise<SavedLayout> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isSavedLayout(value) ? value : {};
  } catch {
    return {};
  }
}

export async function saveLayout(path: string, layout: SavedLayout): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(layout, null, 2) + "\n");
}

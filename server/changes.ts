import { readFileSync } from "node:fs";
import type { ChangesRequest, DiffRequest } from "../probe/changes.ts";
import type { ChangedFile, ChangeScope, ChangesOutput, FileDiff } from "../shared/changes.ts";
import type { Fleet, FleetWorkspace } from "../shared/model.ts";
import { bundleProbe, runScript, type ProbeOptions } from "./probe.ts";

const CHANGES_SOURCE = bundleProbe(["../probe/git.ts", "../probe/changes.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")));

/** The changes probe source with a call that prints the summary for `req`. */
export function changesScript(req: ChangesRequest): string {
  return `${CHANGES_SOURCE}\nprocess.stdout.write(JSON.stringify(changesSummary(${JSON.stringify(req)})));\n`;
}

/** The changes probe source with a call that prints one file's diff. */
export function diffScript(req: DiffRequest): string {
  return `${CHANGES_SOURCE}\nprocess.stdout.write(JSON.stringify(changesDiff(${JSON.stringify(req)})));\n`;
}

export function readChanges(opts: ProbeOptions, req: ChangesRequest, timeoutMs = 30_000): Promise<ChangesOutput> {
  return runScript(opts, changesScript(req), timeoutMs);
}

export function readDiff(opts: ProbeOptions, req: DiffRequest, timeoutMs = 30_000): Promise<FileDiff> {
  return runScript(opts, diffScript(req), timeoutMs);
}

export function findWorkspace(fleet: Fleet | undefined, id: string): FleetWorkspace | undefined {
  for (const g of fleet?.groups ?? []) for (const ws of g.workspaces) if (ws.id === id) return ws;
  return undefined;
}

const MAX_PATH = 4096;

/** A repo-relative path as git prints it: no NUL, not absolute, and no `..` segment. */
export function assertChangePath(path: string): string {
  if (!path) throw new Error("path is required");
  if (path.length > MAX_PATH) throw new Error("path is too long");
  if (path.includes("\0")) throw new Error("path contains a NUL byte");
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) throw new Error("path must be relative to the repo root");
  if (path.split(/[\\/]/).includes("..")) throw new Error("path must not contain ..");
  return path;
}

// The file list a summary reported is kept this long, so a diff request can be checked against
// it without listing the changes again.
export const LIST_TTL_MS = 60_000;

/** The files each root and scope's latest summary listed. */
export function createChangesCache(ttlMs = LIST_TTL_MS, now = Date.now) {
  const lists = new Map<string, { at: number; files: Map<string, ChangedFile> }>();
  const key = (root: string, scope: ChangeScope) => `${scope}\0${root}`;
  return {
    set(root: string, scope: ChangeScope, files: ChangedFile[]) {
      lists.set(key(root, scope), { at: now(), files: new Map(files.map((f) => [f.path, f])) });
      for (const [k, v] of lists) if (now() - v.at >= ttlMs) lists.delete(k);
    },
    /** The listed file at `path`; null when it isn't listed; undefined when there's no fresh list. */
    get(root: string, scope: ChangeScope, path: string): ChangedFile | null | undefined {
      const list = lists.get(key(root, scope));
      if (!list || now() - list.at >= ttlMs) return undefined;
      return list.files.get(path) ?? null;
    },
  };
}

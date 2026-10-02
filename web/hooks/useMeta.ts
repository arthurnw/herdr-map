import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  applyGroupPatch,
  applyWorkspacePatch,
  type GroupPatch,
  type MetaState,
  type WorkspacePatch,
} from "../../shared/organize.ts";
import { errorMessage } from "../../shared/errors.ts";

const EMPTY: MetaState = { workspaces: {}, groups: {} };

async function post(path: string, body: WorkspacePatch | GroupPatch) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
}

/**
 * Saved workspace and repo box metadata (collapsed, tags, colors), loaded once. Changes
 * show at once and are sent to the server; a failed save reloads what the server has.
 * Undefined until loaded.
 */
export function useMeta() {
  const [meta, setMeta] = useState<MetaState>();

  const load = useCallback(() => {
    fetch("/api/meta")
      .then((res) => (res.ok ? res.json() : EMPTY))
      .then((m: MetaState) => setMeta(m))
      .catch(() => setMeta((prev) => prev ?? EMPTY));
  }, []);

  useEffect(load, [load]);

  const send = useCallback(
    async (path: string, body: WorkspacePatch | GroupPatch, apply: (m: MetaState) => void) => {
      setMeta((prev) => {
        const next = { workspaces: { ...prev?.workspaces }, groups: { ...prev?.groups } };
        apply(next);
        return next;
      });
      try {
        await post(path, body);
      } catch (err) {
        toast.error("Couldn't save the change", { description: errorMessage(err) });
        load();
      }
    },
    [load],
  );

  const patchWorkspaces = useCallback(
    (patch: WorkspacePatch) => send("/api/meta/workspaces", patch, (m) => applyWorkspacePatch(m.workspaces, patch)),
    [send],
  );

  const patchGroup = useCallback(
    (patch: GroupPatch) => send("/api/meta/groups", patch, (m) => applyGroupPatch(m.groups, patch)),
    [send],
  );

  return { meta, patchWorkspaces, patchGroup };
}

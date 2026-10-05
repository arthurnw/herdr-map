// The preview's Changes tab: a workspace's changed files and one file's diff, read by the changes
// probe from the repo root the git probe found for the workspace. A diff is only read for a file
// the latest summary of that root and scope listed, so no other path reaches git.
import { CHANGE_SCOPES, type ChangeScope } from "../../shared/changes.ts";
import { assertChangePath, createChangesCache, readChanges, readDiff, findWorkspace } from "../changes.ts";
import type { Context } from "../context.ts";
import type { ProbeOptions } from "../probe.ts";
import { BadRequest, check, sendJson } from "../http.ts";
import type { Route } from "../router.ts";

function parseScope(value: string | null): ChangeScope {
  const scope = CHANGE_SCOPES.find((s) => s === value);
  if (!scope) throw new BadRequest(`scope must be one of ${CHANGE_SCOPES.join(", ")}`);
  return scope;
}

function parseWorkspace(value: string | null): string {
  if (!value || value.length > 200) throw new BadRequest("ws must name a workspace");
  return value;
}

export function changesRoutes(ctx: Context): Route[] {
  const cache = createChangesCache();

  /** The workspace's repo root, or a reply saying why there's none. */
  function rootFor(url: URL): { probe: ProbeOptions; req: { root: string; scope: ChangeScope } } | { status: number; error: string } {
    const ws = parseWorkspace(url.searchParams.get("ws"));
    const scope = parseScope(url.searchParams.get("scope"));
    const { probe } = ctx;
    if (!probe) return { status: 503, error: "the probe is off (--no-probe)" };
    const found = findWorkspace(ctx.poller.state().fleet, ws);
    if (!found) return { status: 404, error: "no such workspace" };
    // The repo root the git probe found for the workspace, which its git badge shows.
    if (!found.git) return { status: 404, error: "not a git repository" };
    return { probe, req: { root: found.git.root, scope } };
  }

  return [
    {
      method: "GET",
      path: "/api/changes",
      handle: async (_req, res, url) => {
        const target = rootFor(url);
        if ("error" in target) return sendJson(res, target.status, { error: target.error });
        const { probe, req } = target;
        const out = await readChanges(probe, req);
        if (out.error || !out.summary) return sendJson(res, 422, { error: out.error ?? "no summary" });
        cache.set(req.root, req.scope, out.summary.files);
        return sendJson(res, 200, out.summary);
      },
    },
    {
      method: "GET",
      path: "/api/changes/diff",
      handle: async (_req, res, url) => {
        const path = check(() => assertChangePath(url.searchParams.get("path") ?? ""));
        const target = rootFor(url);
        if ("error" in target) return sendJson(res, target.status, { error: target.error });
        const { probe, req } = target;
        let file = cache.get(req.root, req.scope, path);
        if (file === undefined) {
          const out = await readChanges(probe, req);
          if (out.error || !out.summary) return sendJson(res, 422, { error: out.error ?? "no summary" });
          cache.set(req.root, req.scope, out.summary.files);
          file = cache.get(req.root, req.scope, path);
        }
        if (!file) throw new BadRequest("that file isn't in the changes");
        const diff = await readDiff(probe, { ...req, file });
        return sendJson(res, diff.error ? 422 : 200, diff);
      },
    },
  ];
}

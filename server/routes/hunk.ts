// Acting on hunk reviews: jump to a note, reply to one, and run the hunk herdr plugin's actions.
// Every request names a session, note, or agent the hunk probe reported, so nothing else reaches
// hunk or herdr, and commands run without a shell.
import type { ServerResponse } from "node:http";
import { HUNK_ACTIONS, HUNK_PLUGIN, REPLY_AUTHOR, type HunkAction, type HunkReview } from "../../shared/hunk.ts";
import { errorMessage } from "../../shared/errors.ts";
import { fleetPanes } from "../../shared/model.ts";
import { isObject, type JsonObject } from "../../shared/parse.ts";
import type { Context } from "../context.ts";
import { activateApp, assertId, runCli } from "../herdr.ts";
import { assertNoteId, assertReply, assertSessionId, fleetReviews, navigateArgs, replyArgs } from "../hunk.ts";
import { readBody, sendJson } from "../http.ts";
import type { Route } from "../router.ts";

export type HunkRunner = (tool: "herdr" | "hunk", args: string[]) => Promise<string>;

// The plugin acts after `plugin action invoke` returns, so its changes are read again after this.
export const AFTER_ACTION_MS = 1500;
const NAVIGATING: HunkAction[] = ["next-comment", "prev-comment"];

class BadRequest extends Error {}

function check<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new BadRequest(errorMessage(err));
  }
}

export function hunkRoutes(ctx: Context, run?: HunkRunner): Route[] {
  const exec: HunkRunner =
    run ?? ((tool, args) => runCli(tool === "herdr" ? ctx.herdr : { ssh: ctx.herdr.ssh, bin: ctx.hunk }, args, 15_000));

  function review(session: unknown): HunkReview {
    const id = check(() => assertSessionId(session));
    const found = fleetReviews(ctx.poller.state().fleet).find((r) => r.session === id);
    if (!found) throw new BadRequest("no live hunk review with that session");
    return found;
  }

  function note(r: HunkReview, id: unknown) {
    const noteId = check(() => assertNoteId(id));
    const found = r.notes.find((n) => n.id === noteId);
    if (!found) throw new BadRequest("that note isn't in the review");
    return found;
  }

  async function focusReview(r: HunkReview) {
    if (r.pane) await exec("herdr", ["plugin", "pane", "focus", assertId(r.pane)]);
    else if (r.agent) {
      await exec("herdr", ["agent", "focus", assertId(r.agent)]);
      ctx.poller.markSeen(r.agent);
    }
  }

  const handle =
    (fn: (body: JsonObject, res: ServerResponse) => Promise<void>) =>
    async (req: Parameters<Route["handle"]>[0], res: ServerResponse) => {
      try {
        const body = await readBody(req);
        return await fn(isObject(body) ? body : {}, res);
      } catch (err) {
        if (err instanceof BadRequest) return sendJson(res, 400, { error: err.message });
        throw err;
      }
    };

  return [
    {
      method: "GET",
      path: "/api/hunk",
      handle: async (_req, res) => {
        const out = await exec("herdr", ["plugin", "list", "--json", "--plugin", HUNK_PLUGIN]).catch(() => "{}");
        let available = false;
        try {
          const plugins: { plugin_id?: string; enabled?: boolean }[] = JSON.parse(out).result?.plugins ?? [];
          available = plugins.some((p) => p.plugin_id === HUNK_PLUGIN && p.enabled);
        } catch {}
        return sendJson(res, 200, { available });
      },
    },
    {
      method: "POST",
      path: "/api/hunk/navigate",
      handle: handle(async (body, res) => {
        const r = review(body.session);
        const n = note(r, body.note);
        await exec("hunk", navigateArgs(r.session, n));
        await focusReview(r);
        if (ctx.activate) await activateApp(ctx.activate);
        void ctx.poller.poll();
        return sendJson(res, 200, { ok: true });
      }),
    },
    {
      method: "POST",
      path: "/api/hunk/reply",
      handle: handle(async (body, res) => {
        const r = review(body.session);
        const n = note(r, body.note);
        const text = check(() => assertReply(body.text));
        const out = await exec("hunk", replyArgs(r.session, n.id, text, REPLY_AUTHOR));
        let id: string | undefined;
        try {
          id = JSON.parse(out).result?.commentId;
        } catch {}
        await ctx.poller.refreshHunk();
        return sendJson(res, 200, { ok: true, ...(id && { id }) });
      }),
    },
    {
      method: "POST",
      path: "/api/hunk/action",
      handle: handle(async (body, res) => {
        const action = HUNK_ACTIONS.find((a) => a === body.action);
        if (!action) throw new BadRequest(`action must be one of ${HUNK_ACTIONS.join(", ")}`);
        const pane = check(() => assertId(typeof body.pane === "string" ? body.pane : ""));
        const fleet = ctx.poller.state().fleet;
        if (!fleetPanes(fleet).some((p) => p.id === pane && p.agent)) throw new BadRequest("no agent in that pane");
        // The plugin reads the worktree from the pane herdr has focused, and sends a review to it
        // when it's an agent.
        await exec("herdr", ["agent", "focus", pane]);
        ctx.poller.markSeen(pane);
        await exec("herdr", ["plugin", "action", "invoke", action, "--plugin", HUNK_PLUGIN]);
        const owned = fleetReviews(fleet).find((r) => r.agent === pane && r.pane);
        if (NAVIGATING.includes(action) && owned) await focusReview(owned);
        if (ctx.activate) await activateApp(ctx.activate);
        void ctx.poller.poll();
        setTimeout(() => void ctx.poller.refreshHunk(), AFTER_ACTION_MS).unref();
        return sendJson(res, 200, { ok: true });
      }),
    },
  ];
}

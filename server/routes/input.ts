import type { IncomingMessage } from "node:http";
import { parseDialogOptions } from "../../shared/dialog.ts";
import type { Context } from "../context.ts";
import { activateApp, focus, promptAgent, readPane, sendKeys, sendText, type FocusTarget } from "../herdr.ts";
import { readBody, sendJson } from "../http.ts";
import type { Route } from "../router.ts";

interface InputBody {
  pane?: string;
  text?: unknown;
  keys?: unknown;
  expect?: { key?: unknown; label?: unknown };
}

function readInput(req: IncomingMessage): Promise<InputBody> {
  return readBody(req) as Promise<InputBody>;
}

export function inputRoutes(ctx: Context): Route[] {
  const { herdr, poller } = ctx;
  return [
    {
      method: "POST",
      path: "/api/focus",
      handle: async (req, res) => {
        const target = (await readBody(req)) as FocusTarget;
        await focus(herdr, target);
        if (target.kind === "agent") poller.markSeen(target.id);
        if (ctx.activate) await activateApp(ctx.activate);
        void poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/prompt",
      handle: async (req, res) => {
        const body = await readInput(req);
        await promptAgent(herdr, body.pane ?? "", body.text);
        void poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/keys",
      handle: async (req, res) => {
        const body = await readInput(req);
        const pane = body.pane ?? "";
        // A dialog answer names the option it means. Re-read the screen first so a button
        // drawn from an older screen can't answer a different prompt.
        if (body.expect) {
          const options = parseDialogOptions(await readPane(herdr, pane, "visible", 60));
          const match = options.find((o) => o.key === body.expect!.key);
          if (!match || match.label !== body.expect.label) {
            return sendJson(res, 409, { error: "The dialog changed since it was shown. Check the new prompt and try again." });
          }
        }
        await sendKeys(herdr, pane, body.keys);
        void poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/text",
      handle: async (req, res) => {
        const body = await readInput(req);
        await sendText(herdr, body.pane ?? "", body.text);
        void poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
  ];
}

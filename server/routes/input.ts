import type { IncomingMessage } from "node:http";
import { parseDialogOptions } from "../../shared/dialog.ts";
import { isObject, isNonEmptyString, type JsonObject } from "../../shared/parse.ts";
import type { Context } from "../context.ts";
import {
  activateApp,
  assertId,
  assertKeys,
  assertText,
  focus,
  promptAgent,
  readPane,
  sendKeys,
  sendText,
  type FocusTarget,
} from "../herdr.ts";
import { BadRequest, check, readBody, sendJson } from "../http.ts";
import type { Route } from "../router.ts";

const FOCUS_KINDS: FocusTarget["kind"][] = ["agent", "tab", "workspace"];

async function readObject(req: IncomingMessage): Promise<JsonObject> {
  const body = await readBody(req);
  if (!isObject(body)) throw new BadRequest("expected a JSON object");
  return body;
}

function paneOf(body: JsonObject): string {
  const { pane } = body;
  if (!isNonEmptyString(pane)) throw new BadRequest("pane must be a herdr pane id");
  return check(() => assertId(pane));
}

function focusTarget(body: JsonObject): FocusTarget {
  const kind = FOCUS_KINDS.find((k) => k === body.kind);
  if (!kind) throw new BadRequest(`kind must be one of ${FOCUS_KINDS.join(", ")}`);
  const { id } = body;
  if (!isNonEmptyString(id)) throw new BadRequest("id must be a herdr id");
  return { kind, id: check(() => assertId(id)) };
}

/** The dialog option a key press answers: re-checked against the screen before sending. */
function expectedOption(body: JsonObject): { key: string; label: string } | undefined {
  const { expect } = body;
  if (expect === undefined) return undefined;
  if (!isObject(expect) || typeof expect.key !== "string" || typeof expect.label !== "string") {
    throw new BadRequest("expect must have a key and a label");
  }
  return { key: expect.key, label: expect.label };
}

export function inputRoutes(ctx: Context): Route[] {
  const { herdr, poller } = ctx;
  return [
    {
      method: "POST",
      path: "/api/focus",
      handle: async (req, res) => {
        const target = focusTarget(await readObject(req));
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
        const body = await readObject(req);
        const pane = paneOf(body);
        const text = check(() => assertText(body.text));
        await promptAgent(herdr, pane, text);
        void poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/keys",
      handle: async (req, res) => {
        const body = await readObject(req);
        const pane = paneOf(body);
        const keys = check(() => assertKeys(body.keys));
        const expect = expectedOption(body);
        // A dialog answer names the option it means. Re-read the screen first so a button
        // drawn from an older screen can't answer a different prompt.
        if (expect) {
          const options = parseDialogOptions(await readPane(herdr, pane, "visible", 60));
          const match = options.find((o) => o.key === expect.key);
          if (!match || match.label !== expect.label) {
            return sendJson(res, 409, { error: "The dialog changed since it was shown. Check the new prompt and try again." });
          }
        }
        await sendKeys(herdr, pane, keys);
        void poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/text",
      handle: async (req, res) => {
        const body = await readObject(req);
        const pane = paneOf(body);
        const text = check(() => assertText(body.text));
        await sendText(herdr, pane, text);
        void poller.poll();
        return sendJson(res, 200, { ok: true });
      },
    },
  ];
}

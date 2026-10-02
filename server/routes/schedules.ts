import { isTiming } from "../../shared/automation.ts";
import { paneLabel } from "../agents.ts";
import type { Context } from "../context.ts";
import { readBody, sendJson } from "../http.ts";
import { isPromptText } from "../queue.ts";
import type { Route } from "../router.ts";
import { addSchedule, editSchedule, removeSchedule, setArmed, type ScheduleInput } from "../schedules.ts";
import { isObject } from "../../shared/parse.ts";
import { agentPane } from "./queue.ts";

/** Checks a schedule body; every field is required when creating. Returns the fields or an error message. */
function parseInput(ctx: Context, body: unknown, creating: boolean): Partial<ScheduleInput> | string {
  if (!isObject(body)) return "expected an object";
  const out: Partial<ScheduleInput> = {};
  if (body.target !== undefined || creating) {
    const target = agentPane(ctx, body.target);
    if (!target) return "target must be an agent pane";
    out.target = target.paneId;
    out.targetLabel = paneLabel(target, target.paneId);
  }
  if (body.text !== undefined || creating) {
    if (!isPromptText(body.text)) return "text must not be empty";
    out.text = body.text;
  }
  if (body.timing !== undefined || creating) {
    if (!isTiming(body.timing)) return "timing must be every 1 minute to 7 days, or daily at HH:MM";
    out.timing = body.timing;
  }
  return out;
}

export function schedulesRoutes(ctx: Context): Route[] {
  const { queue } = ctx.automation;
  return [
    {
      method: "POST",
      path: "/api/schedules",
      handle: async (req, res) => {
        const input = parseInput(ctx, await readBody(req), true);
        if (typeof input === "string") return sendJson(res, 400, { error: input });
        // SAFETY: parseInput sets every field when creating.
        const schedule = addSchedule(queue, input as ScheduleInput);
        if (typeof schedule === "string") return sendJson(res, 409, { error: schedule });
        return sendJson(res, 201, schedule);
      },
    },
    {
      path: "/api/schedules/",
      prefix: true,
      handle: async (req, res, url) => {
        const [id, action] = url.pathname.slice("/api/schedules/".length).split("/").map(decodeURIComponent);
        let result;
        if (req.method === "PATCH" && !action) {
          const input = parseInput(ctx, await readBody(req), false);
          if (typeof input === "string") return sendJson(res, 400, { error: input });
          result = editSchedule(queue, id, input);
        } else if (req.method === "POST" && (action === "arm" || action === "disarm")) {
          result = setArmed(queue, id, action === "arm");
        } else if (req.method === "DELETE" && !action) {
          return removeSchedule(queue, id) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "no such schedule" });
        } else {
          return sendJson(res, 405, { error: "method not allowed" });
        }
        return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: "no such schedule" });
      },
    },
  ];
}

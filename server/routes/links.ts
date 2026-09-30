import { randomUUID } from "node:crypto";
import { MAX_LINKS, textHash } from "../../shared/automation.ts";
import type { Endpoint, LayoutStore, Link } from "../../shared/layout-types.ts";
import { indexPanes, paneLabel } from "../agents.ts";
import type { Context } from "../context.ts";
import { readBody, sendJson } from "../http.ts";
import { loadStore, updateStore } from "../layout-store.ts";
import { contextPrompt, notePrompt } from "../prompts.ts";
import type { Route } from "../router.ts";
import { agentPane, isObject } from "./queue.ts";

function parseEndpoint(v: unknown): Endpoint | undefined {
  if (!isObject(v) || (v.kind !== "pane" && v.kind !== "note") || typeof v.id !== "string" || !v.id) return undefined;
  return { kind: v.kind, id: v.id };
}

const sameEnd = (a: Endpoint, b: Endpoint) => a.kind === b.kind && a.id === b.id;

/** Whether handoffs already lead from pane `from` to pane `to`, so a handoff back would loop forever. */
function handoffReaches(links: Link[], from: string, to: string): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const pane = queue.shift()!;
    if (pane === to) return true;
    for (const l of links) {
      if (l.kind === "handoff" && l.from.kind === "pane" && l.from.id === pane && !seen.has(l.to.id)) {
        seen.add(l.to.id);
        queue.push(l.to.id);
      }
    }
  }
  return false;
}

/**
 * Queues the one-time message of a context or note link and records when it was sent.
 * Returns an error message when there's nothing to send.
 */
function sendLinkMessage(ctx: Context, store: LayoutStore, link: Link): string | undefined {
  const panes = indexPanes(ctx.poller.state().fleet);
  const target = { target: link.to.id, targetLabel: paneLabel(panes.get(link.to.id), link.to.id) };
  const now = Date.now();
  let result;
  if (link.from.kind === "note") {
    const note = store.notes.find((n) => n.id === link.from.id);
    if (!note?.text.trim()) return "the note is empty";
    const firstLine = note.text.trim().split("\n")[0].slice(0, 40);
    result = ctx.automation.queue.enqueue(
      { ...target, text: notePrompt(note.text), source: { kind: "note", linkId: link.id, label: `Note: ${firstLine}` } },
      now,
    );
    if (typeof result !== "string") link.sent = { at: now, hash: textHash(note.text) };
  } else {
    const from = panes.get(link.from.id);
    result = ctx.automation.queue.enqueue(
      {
        ...target,
        text: contextPrompt(from, link.from.id),
        source: { kind: "context", linkId: link.id, label: `Context link from ${paneLabel(from, link.from.id)}` },
      },
      now,
    );
    if (typeof result !== "string") link.sent = { at: now };
  }
  return typeof result === "string" ? result : undefined;
}

export function linksRoutes(ctx: Context): Route[] {
  const { layoutPath } = ctx;
  return [
    {
      path: "/api/links",
      handle: async (req, res) => {
        if (req.method === "GET") return sendJson(res, 200, (await loadStore(layoutPath)).links);
        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        const body = await readBody(req);
        if (!isObject(body)) return sendJson(res, 400, { error: "expected an object" });
        const from = parseEndpoint(body.from);
        const to = parseEndpoint(body.to);
        const kind = body.kind;
        if (kind !== "handoff" && kind !== "context") return sendJson(res, 400, { error: "kind must be handoff or context" });
        if (!from || !to || to.kind !== "pane" || !agentPane(ctx, to.id)) {
          return sendJson(res, 400, { error: "a link goes from an agent or a note to an agent" });
        }
        if (from.kind === "pane" && !agentPane(ctx, from.id)) return sendJson(res, 400, { error: "the link must start at an agent" });
        if (from.kind === "note" && kind !== "context") return sendJson(res, 400, { error: "a note can only send its text" });
        if (sameEnd(from, to)) return sendJson(res, 400, { error: "an agent can't link to itself" });
        const result = await updateStore(layoutPath, (store): Link | string => {
          if (store.links.length >= MAX_LINKS) return `at most ${MAX_LINKS} links`;
          if (store.links.some((l) => l.kind === kind && sameEnd(l.from, from) && sameEnd(l.to, to))) return "that link already exists";
          if (from.kind === "note" && !store.notes.some((n) => n.id === from.id)) return "no such note";
          if (kind === "handoff" && handoffReaches(store.links, to.id, from.id)) {
            return "handoffs already lead back from that agent, so this one would loop";
          }
          const link: Link = { id: randomUUID(), from, to, kind, createdAt: Date.now() };
          if (kind === "context") {
            const error = sendLinkMessage(ctx, store, link);
            if (error) return error;
          }
          store.links.push(link);
          return link;
        });
        if (typeof result === "string") return sendJson(res, 409, { error: result });
        void ctx.automation.tick();
        return sendJson(res, 201, result);
      },
    },
    {
      path: "/api/links/",
      prefix: true,
      handle: async (req, res, url) => {
        const [id, action] = url.pathname.slice("/api/links/".length).split("/").map(decodeURIComponent);
        if (req.method === "DELETE" && !action) {
          const removed = await updateStore(layoutPath, (store) => {
            const before = store.links.length;
            store.links = store.links.filter((l) => l.id !== id);
            return store.links.length < before;
          });
          if (!removed) return sendJson(res, 404, { error: "no such link" });
          // A deleted link sends nothing more, including what it had queued.
          ctx.automation.queue.cancelWhere((i) => i.source.linkId === id && i.state !== "gone");
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === "POST" && action === "send") {
          const result = await updateStore(layoutPath, (store): Link | string => {
            const link = store.links.find((l) => l.id === id);
            if (!link) return "no such link";
            if (link.kind !== "context") return "only context and note links send a message";
            if (!agentPane(ctx, link.to.id)) return "the agent isn't there";
            return sendLinkMessage(ctx, store, link) ?? link;
          });
          if (typeof result === "string") return sendJson(res, 409, { error: result });
          void ctx.automation.tick();
          return sendJson(res, 200, result);
        }
        return sendJson(res, 405, { error: "method not allowed" });
      },
    },
  ];
}

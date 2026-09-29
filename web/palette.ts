// Command palette query matching and shortcut labels, kept free of React and DOM types
// so they run under node:test.
import type { FleetPane, FleetWorkspace } from "../shared/model.ts";
import type { Shortcut } from "./shortcuts.ts";

/**
 * A parsed palette query. `s:blocked`, `a:codex`, `w:auth`, and `t:infra` narrow by status,
 * agent kind, workspace, and workspace tag; the remaining words must all appear somewhere in the item.
 * Repeating a prefix matches any of its values, and different prefixes must all match.
 */
export interface PaletteQuery {
  statuses: string[];
  kinds: string[];
  workspaces: string[];
  tags: string[];
  text: string[];
}

const PREFIXES = { s: "statuses", a: "kinds", w: "workspaces", t: "tags" } as const;

export function parseQuery(input: string): PaletteQuery {
  const q: PaletteQuery = { statuses: [], kinds: [], workspaces: [], tags: [], text: [] };
  for (const word of input.toLowerCase().split(/\s+/).filter(Boolean)) {
    const m = /^([sawt]):(.*)$/.exec(word);
    if (!m) q.text.push(word);
    // A bare prefix, typed on the way to a value, doesn't filter yet.
    else if (m[2]) q[PREFIXES[m[1] as keyof typeof PREFIXES]].push(m[2]);
  }
  return q;
}

const includesAll = (haystack: (string | undefined)[], words: string[]) => {
  const text = haystack.filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => text.includes(w));
};

/** A `t:` value matches a tag that starts with it. */
const workspaceOk = (ws: FleetWorkspace, q: PaletteQuery, tags: string[]) =>
  (q.workspaces.length === 0 || q.workspaces.some((w) => ws.label.toLowerCase().includes(w))) &&
  (q.tags.length === 0 || q.tags.some((t) => tags.some((tag) => tag.startsWith(t))));

/** `tags` are the agent's workspace tags. */
export function agentMatches(l: { pane: FleetPane; workspace: FleetWorkspace }, q: PaletteQuery, tags: string[] = []): boolean {
  const agent = l.pane.agent;
  if (!agent) return false;
  if (q.statuses.length && !q.statuses.some((s) => agent.status.startsWith(s))) return false;
  if (q.kinds.length && !q.kinds.some((k) => agent.kind.toLowerCase().startsWith(k))) return false;
  if (!workspaceOk(l.workspace, q, tags)) return false;
  return includesAll([agent.name, agent.kind, agent.summary, l.workspace.label, l.pane.title, ...tags], q.text);
}

/** Workspaces have no status or kind, so those prefixes leave them out. */
export function workspaceItemMatches(ws: FleetWorkspace, groupLabel: string, q: PaletteQuery, tags: string[] = []): boolean {
  if (q.statuses.length || q.kinds.length) return false;
  return workspaceOk(ws, q, tags) && includesAll([ws.label, groupLabel, ...tags], q.text);
}

/** Commands match on their description and only when no prefix is in use. */
export function commandMatches(description: string, q: PaletteQuery): boolean {
  if (q.statuses.length || q.kinds.length || q.workspaces.length || q.tags.length) return false;
  return includesAll([description], q.text);
}

const KEY_NAMES: Record<string, string> = {
  Enter: "↵",
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  " ": "Space",
};

/** A short label for a binding, such as `⌘K`, `⇧N`, or `↵`. */
export function shortcutLabel(binding: Pick<Shortcut, "key" | "meta" | "ctrl" | "alt" | "shift">): string {
  const { key } = binding;
  const shiftedLetter = key.length === 1 && key !== key.toLowerCase();
  const mods = [binding.ctrl && "⌃", binding.alt && "⌥", (binding.shift || shiftedLetter) && "⇧", binding.meta && "⌘"];
  const name = KEY_NAMES[key] ?? (key.length === 1 ? (shiftedLetter || mods.some(Boolean) ? key.toUpperCase() : key) : key);
  return mods.filter(Boolean).join("") + name;
}

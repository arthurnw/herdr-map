// Command palette query matching and shortcut labels, kept free of React and DOM types
// so they run under node:test.
import { prChecks, prStatus } from "../shared/git.ts";
import { STATUSES, type FleetAgent, type FleetPane, type FleetWorkspace } from "../shared/model.ts";
import type { Shortcut } from "./shortcuts.ts";

/**
 * A query prefix such as `s:`. Agent prefixes test the agent and leave workspaces out; workspace
 * prefixes test a workspace, and an agent through its workspace.
 */
interface Prefix<T = string> {
  /** What the prefix narrows by, and example values, for the palette's hints. */
  hint: string;
  values?: string;
  /** Turns a value into what the predicate takes; undefined leaves it out, as an unfinished value. */
  parse?(value: string): T | undefined;
  /** Repeated values must all match, rather than any of them. */
  every?: boolean;
  agent?(agent: FleetAgent, value: T): boolean;
  /** `tags` are the workspace's tags. */
  workspace?(ws: FleetWorkspace, tags: string[], value: T): boolean;
}

export type MemoryOp = ">" | ">=" | "<" | "<=";
export interface MemoryThreshold {
  op: MemoryOp;
  bytes: number;
}

const UNIT = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as const;

/** `>1g`, `<500m`, `>=1.5gb`, or `800` (MB, at least). Units are binary, as the memory figures are. */
export function parseMemoryThreshold(value: string): MemoryThreshold | undefined {
  const m = /^(>=?|<=?)?(\d+(?:\.\d+)?|\.\d+)(?:([kmg])b?)?$/.exec(value.toLowerCase());
  if (!m) return undefined;
  // SAFETY: the pattern captures only these operators and units.
  return { op: (m[1] ?? ">=") as MemoryOp, bytes: Number(m[2]) * UNIT[(m[3] ?? "m") as keyof typeof UNIT] };
}

const meetsThreshold = (bytes: number, { op, bytes: limit }: MemoryThreshold) =>
  op === ">" ? bytes > limit : op === ">=" ? bytes >= limit : op === "<" ? bytes < limit : bytes <= limit;

const PREFIXES = {
  s: { hint: "status", values: "blocked, done, working, idle", agent: (a, v) => a.status.startsWith(v) },
  a: { hint: "agent kind", values: "claude, codex, pi", agent: (a, v) => a.kind.toLowerCase().startsWith(v) },
  w: { hint: "workspace", workspace: (ws, _tags, v) => ws.label.toLowerCase().includes(v) },
  /** A `t:` value matches a tag that starts with it. */
  t: { hint: "tag", workspace: (_ws, tags, v) => tags.some((tag) => tag.startsWith(v)) },
  pr: {
    hint: "PR",
    values: "open, draft, merged, closed, none, any",
    workspace: (ws, _tags, v) => {
      const pr = ws.git?.pr;
      return "any".startsWith(v) ? !!pr : (pr ? prStatus(pr) : "none").startsWith(v);
    },
  },
  ci: {
    hint: "checks",
    values: "pass, fail, pending",
    workspace: (ws, _tags, v) => {
      const pr = ws.git?.pr;
      return (pr ? prChecks(pr) : "none").startsWith(v);
    },
  },
  dirty: {
    hint: "changes",
    values: "yes, no",
    workspace: ({ git }, _tags, v) => !!git && (git.dirty > 0 ? "yes" : "no").startsWith(v),
  },
  mem: {
    hint: "memory",
    values: ">1g, <500m",
    parse: parseMemoryThreshold,
    every: true,
    agent: (a, t) => !!a.memory && meetsThreshold(a.memory.bytes, t),
  } satisfies Prefix<MemoryThreshold>,
} satisfies Record<string, Prefix<any>>;

export type PrefixName = keyof typeof PREFIXES;

const isPrefixName = (name: string): name is PrefixName => Object.hasOwn(PREFIXES, name);

/** The prefixes and what they narrow by, in the order the palette lists them. */
export const PREFIX_HINTS: { prefix: string; hint: string; values?: string }[] = [
  ...Object.entries(PREFIXES).map(([name, p]: [string, Prefix<any>]) => ({ prefix: `${name}:`, hint: p.hint, values: p.values })),
  { prefix: "sort:mem", hint: "by memory" },
];

/**
 * A parsed palette query. Prefixes such as `s:blocked` or `pr:open` narrow the list (see PREFIXES);
 * the remaining words must all appear somewhere in the item. Repeating a prefix matches any of its
 * values, except `mem:`, whose thresholds all apply; different prefixes must all match.
 * `sort:mem` orders agents by memory without narrowing anything.
 */
export interface PaletteQuery {
  filters: { [K in PrefixName]?: unknown[] };
  text: string[];
  sort?: "mem";
}

export function parseQuery(input: string): PaletteQuery {
  const q: PaletteQuery = { filters: {}, text: [] };
  for (const word of input.toLowerCase().split(/\s+/).filter(Boolean)) {
    const m = /^([a-z]+):(.*)$/.exec(word);
    if (m?.[1] === "sort") {
      if (m[2] && "memory".startsWith(m[2])) q.sort = "mem";
      continue;
    }
    if (!m || !isPrefixName(m[1])) {
      q.text.push(word);
      continue;
    }
    const name = m[1];
    const p: Prefix<unknown> = PREFIXES[name];
    // A bare prefix, or a value still being typed, doesn't filter yet.
    const value = m[2] && (p.parse ? p.parse(m[2]) : m[2]);
    if (value) (q.filters[name] ??= []).push(value);
  }
  return q;
}

// SAFETY: parseQuery adds filters only under PREFIXES names.
const filterEntries = (q: PaletteQuery) => Object.entries(q.filters) as [PrefixName, unknown[]][];
const hasFilters = (q: PaletteQuery) => filterEntries(q).length > 0;

const matchValues = <T,>(p: Prefix<T>, values: T[], test: (v: T) => boolean) =>
  p.every ? values.every(test) : values.some(test);

const includesAll = (haystack: (string | undefined)[], words: string[]) => {
  const text = haystack.filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => text.includes(w));
};

/** `tags` are the agent's workspace tags. */
export function agentMatches(l: { pane: FleetPane; workspace: FleetWorkspace }, q: PaletteQuery, tags: string[] = []): boolean {
  const agent = l.pane.agent;
  if (!agent) return false;
  for (const [name, values] of filterEntries(q)) {
    const p: Prefix<unknown> = PREFIXES[name];
    const ok = matchValues(p, values, (v) => (p.agent ? p.agent(agent, v) : p.workspace!(l.workspace, tags, v)));
    if (!ok) return false;
  }
  return includesAll([agent.name, agent.kind, agent.summary, l.workspace.label, l.pane.title, ...tags], q.text);
}

/** Agent prefixes, such as status or memory, leave workspaces out. */
export function workspaceItemMatches(ws: FleetWorkspace, groupLabel: string, q: PaletteQuery, tags: string[] = []): boolean {
  for (const [name, values] of filterEntries(q)) {
    const p: Prefix<unknown> = PREFIXES[name];
    if (!p.workspace || !matchValues(p, values, (v) => p.workspace!(ws, tags, v))) return false;
  }
  return includesAll([ws.label, groupLabel, ...tags], q.text);
}

/** Commands match on their description and only when no prefix narrows the list. */
export function commandMatches(description: string, q: PaletteQuery): boolean {
  if (hasFilters(q)) return false;
  return includesAll([description], q.text);
}

/** Whether agent rows show their memory figure. */
export const showsMemory = (q: PaletteQuery) => q.sort === "mem" || !!q.filters.mem;

/**
 * Blocked agents first, then finished ones, then the rest; the longest-waiting first within each.
 * `sort:mem` puts the heaviest first instead, and agents without a figure last in that order.
 */
export function sortAgents<T extends { pane: FleetPane }>(list: T[], q: PaletteQuery): T[] {
  const byStatus = (a: FleetAgent, b: FleetAgent) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.since - b.since;
  const byMemory = (a: FleetAgent, b: FleetAgent) => (b.memory?.bytes ?? -1) - (a.memory?.bytes ?? -1);
  return [...list].sort((x, y) => {
    const a = x.pane.agent!;
    const b = y.pane.agent!;
    return (q.sort === "mem" && byMemory(a, b)) || byStatus(a, b);
  });
}

/**
 * Adds `sort:mem` to the search, or takes any `sort:` word out. Free text goes too, since it's
 * what found the command.
 */
export function toggleMemorySort(search: string): string {
  const words = search.split(/\s+/).filter(Boolean);
  const sorted = words.some((w) => /^sort:/i.test(w));
  const kept = words.filter((w) => Object.hasOwn(PREFIXES, /^([a-z]+):/i.exec(w)?.[1].toLowerCase() ?? ""));
  return sorted ? kept.join(" ") : [...kept, "sort:mem"].join(" ") + " ";
}

const KEY_NAMES = new Map([
  ["Enter", "↵"],
  ["Escape", "Esc"],
  ["ArrowLeft", "←"],
  ["ArrowRight", "→"],
  ["ArrowUp", "↑"],
  ["ArrowDown", "↓"],
  [" ", "Space"],
]);

/** A short label for a binding, such as `⌘K`, `⇧N`, or `↵`. */
export function shortcutLabel(binding: Pick<Shortcut, "key" | "meta" | "ctrl" | "alt" | "shift">): string {
  const { key } = binding;
  const shiftedLetter = key.length === 1 && key !== key.toLowerCase();
  const mods = [binding.ctrl && "⌃", binding.alt && "⌥", (binding.shift || shiftedLetter) && "⇧", binding.meta && "⌘"];
  const name = KEY_NAMES.get(key) ?? (key.length === 1 ? (shiftedLetter || mods.some(Boolean) ? key.toUpperCase() : key) : key);
  return mods.filter(Boolean).join("") + name;
}

// hunk review sessions and their inline notes, as the hunk probe reports them, matched to workspaces.

/** The herdr plugin that opens hunk reviews and sends your comments to the agent that owns them. */
export const HUNK_PLUGIN = "jhochenbaum.hunkdiff";

/**
 * hunk records every note added through its CLI as an agent note, so replies from herdr-map's
 * reply box carry this author and aren't counted as the agent's.
 */
export const REPLY_AUTHOR = "herdr-map";

/** The plugin's actions herdr-map can run. */
export const HUNK_ACTIONS = ["send-review", "review", "next-comment", "prev-comment"] as const;
export type HunkAction = (typeof HUNK_ACTIONS)[number];

export interface HunkNote {
  /** hunk's note ID: `user:…` for notes from its viewer, `mcp:…` for notes added through its CLI. */
  id: string;
  /** The note this one replies to. */
  parent?: string;
  source: "user" | "agent";
  author?: string;
  /** Path as the diff shows it. */
  file: string;
  side: "new" | "old";
  line?: number;
  /** The first line of the note. */
  summary: string;
  /** The rest, when there's more. */
  detail?: string;
  /** Epoch ms. */
  createdAt?: number;
  /** A comment of yours the plugin already sent to the agent. */
  sent?: boolean;
}

export interface HunkReview {
  session: string;
  /** Repo root hunk reviews. */
  repo: string;
  title?: string;
  /** hunk's pane in herdr, when the plugin opened it. */
  pane?: string;
  /** The agent pane the plugin sends this review to. */
  agent?: string;
  notes: HunkNote[];
}

/** Counts for an agent card: your comments not sent yet, and notes agents left. */
export interface AgentHunk {
  unsent: number;
  notes: number;
}

export const isUnsent = (n: HunkNote) => n.source === "user" && !n.sent;
export const isAgentNote = (n: HunkNote) => n.source === "agent" && n.author !== REPLY_AUTHOR;

export function hunkCounts(reviews: HunkReview[]): AgentHunk {
  const notes = reviews.flatMap((r) => r.notes);
  return { unsent: notes.filter(isUnsent).length, notes: notes.filter(isAgentNote).length };
}

/** "3 comments from you not sent yet, 1 note from an agent". */
export function hunkCountText(c: AgentHunk): string {
  const parts: string[] = [];
  if (c.unsent) parts.push(`${c.unsent} comment${c.unsent === 1 ? "" : "s"} from you not sent yet`);
  if (c.notes) parts.push(`${c.notes} note${c.notes === 1 ? "" : "s"} from ${c.notes === 1 ? "an agent" : "agents"}`);
  return parts.join(", ");
}

/** Agent notes in `reviews` whose IDs aren't in `seen`. */
export function unreadNotes(reviews: HunkReview[], seen: ReadonlySet<string>): HunkNote[] {
  return reviews.flatMap((r) => r.notes.filter((n) => isAgentNote(n) && !seen.has(n.id)));
}

export interface HunkThread {
  note: HunkNote;
  depth: number;
}

/**
 * Notes in reading order: each top-level note by file and line, then its replies oldest first,
 * nested under the note they answer. A reply whose parent is gone shows at the top level.
 */
export function threadNotes(notes: HunkNote[]): HunkThread[] {
  const ids = new Set(notes.map((n) => n.id));
  const children = new Map<string, HunkNote[]>();
  const roots: HunkNote[] = [];
  for (const n of notes) {
    if (n.parent && ids.has(n.parent)) children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
    else roots.push(n);
  }
  const byTime = (a: HunkNote, b: HunkNote) => (a.createdAt ?? 0) - (b.createdAt ?? 0);
  roots.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || byTime(a, b));
  const out: HunkThread[] = [];
  const walk = (n: HunkNote, depth: number) => {
    out.push({ note: n, depth });
    for (const c of (children.get(n.id) ?? []).sort(byTime)) walk(c, depth + 1);
  };
  roots.forEach((n) => walk(n, 0));
  return out;
}

/** `greet.ts:12`, or `greet.ts:12 (old)` for a line on the removed side. */
export function noteLocation(n: HunkNote): string {
  if (n.line === undefined) return n.file;
  return `${n.file}:${n.line}${n.side === "old" ? " (old)" : ""}`;
}

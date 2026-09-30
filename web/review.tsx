// hunk review notes: counts on workspace headers and agent cards, which agent notes you've read,
// and the Review section of an agent's preview.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronUp, CornerDownRight, FileDiff, MessageSquare, Reply, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  hunkCounts,
  hunkCountText,
  noteLocation,
  REPLY_AUTHOR,
  threadNotes,
  unreadNotes,
  type HunkAction,
  type HunkNote,
  type HunkReview,
} from "../shared/hunk.ts";
import type { Fleet, FleetAgent, FleetWorkspace } from "../shared/model.ts";
import { formatAge } from "./format.ts";
import { NowContext } from "./nodes.tsx";
import { safeStorage, type Located } from "./state.ts";
import "./review.css";

const SEEN_KEY = "herdr-map.hunk-seen";
// Note IDs are unique per note, so old ones only take space.
const MAX_SEEN = 1000;
const MAX_REPLY = 2000;

interface HunkView {
  /** Reviews whose notes go to this agent. */
  reviewsFor(pane: string): HunkReview[];
  /** IDs of notes agents left in this agent's reviews that you haven't looked at. */
  unread(pane: string): string[];
  markSeen(ids: string[]): void;
  /** Whether the hunk herdr plugin is installed, for its buttons. */
  plugin: boolean;
}

export const HunkContext = createContext<HunkView>({ reviewsFor: () => [], unread: () => [], markSeen: () => {}, plugin: false });

function loadSeen(): string[] {
  try {
    const saved = JSON.parse(safeStorage.getItem(SEEN_KEY) ?? "[]");
    if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === "string");
  } catch {}
  return [];
}

// Checked once per page load, as the zoetrope button does.
let pluginCheck: Promise<boolean> | undefined;
const pluginInstalled = () =>
  (pluginCheck ??= fetch("/api/hunk")
    .then((res) => res.json())
    .then((body) => body.available === true)
    .catch(() => false));

/** Which agent notes you've read is remembered per browser. */
export function useHunkView(fleet: Fleet | undefined): HunkView {
  const [seenList, setSeenList] = useState(loadSeen);
  const [plugin, setPlugin] = useState(false);
  useEffect(() => {
    let live = true;
    void pluginInstalled().then((v) => live && setPlugin(v));
    return () => {
      live = false;
    };
  }, []);
  const byAgent = useMemo(() => {
    const out = new Map<string, HunkReview[]>();
    for (const g of fleet?.groups ?? [])
      for (const ws of g.workspaces) for (const r of ws.hunk ?? []) if (r.agent) out.set(r.agent, [...(out.get(r.agent) ?? []), r]);
    return out;
  }, [fleet]);
  const markSeen = useCallback((ids: string[]) => {
    setSeenList((prev) => {
      const fresh = ids.filter((id) => !prev.includes(id));
      if (fresh.length === 0) return prev;
      const next = [...prev, ...fresh].slice(-MAX_SEEN);
      safeStorage.setItem(SEEN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return useMemo(() => {
    const seen = new Set(seenList);
    const reviewsFor = (pane: string) => byAgent.get(pane) ?? [];
    return { reviewsFor, unread: (pane: string) => unreadNotes(reviewsFor(pane), seen).map((n) => n.id), markSeen, plugin };
  }, [byAgent, seenList, markSeen, plugin]);
}

async function post(path: string, body: object): Promise<unknown> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error ?? res.statusText);
  return out;
}

function Counts({ unsent, notes, unread = 0 }: { unsent: number; notes: number; unread?: number }) {
  return (
    <>
      {unsent > 0 && (
        <span className="hunk-count hunk-unsent">
          <MessageSquare aria-hidden />
          {unsent}
        </span>
      )}
      {notes > 0 && (
        <span className={cn("hunk-count hunk-agent", unread > 0 && "hunk-unread")}>
          <Bot aria-hidden />
          {notes}
        </span>
      )}
    </>
  );
}

/** Your unsent comments and agents' notes across a workspace's live hunk reviews. */
export function WorkspaceReviewChip({ workspace }: { workspace: FleetWorkspace }) {
  if (!workspace.hunk?.length) return null;
  const c = hunkCounts(workspace.hunk);
  if (!c.unsent && !c.notes) return null;
  return (
    <span className="hunk-chip ws-hunk" title={`hunk review: ${hunkCountText(c)}`}>
      <Counts {...c} />
    </span>
  );
}

/** The same counts on the card of the agent that owns the review; agent notes you haven't read stand out. */
export function AgentReviewChip({ pane, agent }: { pane: string; agent: FleetAgent }) {
  const unread = useContext(HunkContext).unread(pane).length;
  const c = agent.hunk;
  if (!c || (!c.unsent && !c.notes)) return null;
  const title = `hunk review: ${hunkCountText(c)}${unread ? ` (${unread} unread)` : ""}`;
  return (
    <span className="hunk-chip" title={title}>
      <Counts {...c} unread={unread} />
    </span>
  );
}

function authorLabel(n: HunkNote): string {
  if (n.source === "user") return "you";
  if (n.author === REPLY_AUTHOR) return "you, from herdr-map";
  return n.author ?? "agent";
}

function NoteRow({
  review,
  note,
  depth,
  unread,
  now,
}: {
  review: HunkReview;
  note: HunkNote;
  depth: number;
  unread: boolean;
  now: number;
}) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const open = () =>
    void post("/api/hunk/navigate", { session: review.session, note: note.id }).catch((err) =>
      toast.error("Couldn't show the note in hunk", { description: (err as Error).message }),
    );

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await post("/api/hunk/reply", { session: review.session, note: note.id, text: t });
      setText("");
      setReplying(false);
    } catch (err) {
      toast.error("Couldn't post the reply", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="hunk-note" style={{ "--depth": depth } as React.CSSProperties} data-note={note.id}>
      <div className="hunk-note-row">
        <button
          type="button"
          className="hunk-note-main"
          title={`Show in hunk and focus its pane${note.detail ? `\n\n${note.detail}` : ""}`}
          onClick={open}
        >
          <span className="hunk-note-head">
            {depth > 0 && <CornerDownRight className="hunk-note-reply-icon" aria-hidden />}
            {unread && <span className="hunk-note-dot" aria-label="Unread" />}
            <span className="hunk-note-author">{authorLabel(note)}</span>
            {depth === 0 && <span className="hunk-note-loc">{noteLocation(note)}</span>}
            {note.source === "user" && <span className="hunk-note-tag">{note.sent ? "sent" : "not sent"}</span>}
            {note.createdAt && <span className="hunk-note-age">{formatAge(now - note.createdAt)}</span>}
          </span>
          <span className="hunk-note-summary">{note.summary}</span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label="Reply"
          title="Reply in hunk"
          aria-pressed={replying}
          onClick={() => setReplying((r) => !r)}
        >
          <Reply className="size-3.5" />
        </Button>
      </div>
      {replying && (
        <div className="hunk-reply">
          <Textarea
            autoFocus
            rows={2}
            value={text}
            maxLength={MAX_REPLY}
            placeholder={`Reply to ${authorLabel(note)}…`}
            aria-label="Reply to this note"
            className="min-h-0 text-xs"
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setReplying(false);
              }
            }}
          />
          <Button size="sm" className="h-7 gap-1" disabled={busy || !text.trim()} onClick={() => void send()}>
            <Send className="size-3" />
            Reply
          </Button>
        </div>
      )}
    </li>
  );
}

async function runAction(pane: string, action: HunkAction, what: string) {
  try {
    await post("/api/hunk/action", { pane, action });
  } catch (err) {
    toast.error(`Couldn't ${what}`, { description: (err as Error).message });
  }
}

/**
 * The agent's live hunk reviews: notes by file and line with their replies, a reply box per
 * note, and the plugin's own actions. Notes show as read once this section has been on
 * screen in a pinned preview.
 */
export function ReviewSection({ located, pinned }: { located: Located; pinned: boolean }) {
  const view = useContext(HunkContext);
  const now = useContext(NowContext);
  const pane = located.pane.id;
  const reviews = view.reviewsFor(pane);
  // Unread dots stay while the preview is open, so you can see what was new.
  const [unreadAtOpen, setUnreadAtOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setUnreadAtOpen(new Set()), [pane]);
  useEffect(() => {
    if (!pinned) return;
    const ids = view.unread(pane);
    if (ids.length === 0) return;
    setUnreadAtOpen((prev) => new Set([...prev, ...ids]));
    view.markSeen(ids);
  }, [pinned, pane, view]);

  if (reviews.length === 0 && !view.plugin) return null;
  const counts = hunkCounts(reviews);
  const hasReview = reviews.length > 0;
  return (
    <section className="hunk-review" aria-label="Review">
      <div className="hunk-review-head">
        <FileDiff className="size-3.5 text-muted-foreground" aria-hidden />
        <h3 className="text-xs font-semibold">Review</h3>
        {hasReview && (
          <span className="hunk-chip">
            <Counts {...counts} />
          </span>
        )}
        {view.plugin && (
          <span className="ml-auto flex items-center gap-1">
            {hasReview && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label="Previous comment"
                  title="Previous comment in hunk"
                  onClick={() => void runAction(pane, "prev-comment", "move to the previous comment")}
                >
                  <ChevronUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label="Next comment"
                  title="Next comment in hunk"
                  onClick={() => void runAction(pane, "next-comment", "move to the next comment")}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              title="Open or refresh a hunk review of this agent's worktree, with the plugin's review action"
              onClick={() => void runAction(pane, "review", "open the review")}
            >
              Open review
            </Button>
            {hasReview && (
              <Button
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                disabled={counts.unsent === 0}
                title={
                  counts.unsent
                    ? `Send your ${counts.unsent} unsent comment${counts.unsent === 1 ? "" : "s"} to this agent, with the plugin's send-review action`
                    : "No comments from you to send"
                }
                onClick={() => void runAction(pane, "send-review", "send the review")}
              >
                <Send className="size-3" />
                Send review
              </Button>
            )}
          </span>
        )}
      </div>
      {!hasReview ? (
        <p className="text-xs text-muted-foreground">No live hunk review for this agent.</p>
      ) : (
        reviews.map((r) => (
          <ul key={r.session} className="hunk-notes" aria-label={r.title ?? "hunk review"}>
            {reviews.length > 1 && <li className="hunk-review-title">{r.title ?? r.repo}</li>}
            {r.notes.length === 0 && <li className="text-xs text-muted-foreground">No notes yet.</li>}
            {threadNotes(r.notes).map(({ note, depth }) => (
              <NoteRow
                key={note.id}
                review={r}
                note={note}
                depth={depth}
                unread={unreadAtOpen.has(note.id)}
                now={now}
              />
            ))}
          </ul>
        ))
      )}
    </section>
  );
}

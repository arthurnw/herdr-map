import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Copy, Pin, PinOff, RefreshCw, SquareTerminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { StuckBadge } from "./attention.tsx";
import { AgentName } from "./rename.tsx";
import { StarButton } from "./stars.tsx";
import { ZoetropeButton } from "./zoetrope.tsx";
import "./preview.css";
import { agentAge, formatAge } from "./format.ts";
import { ReplyBox } from "./ReplyBox.tsx";
import { AgentAutomation } from "./AgentAutomation.tsx";
import { hasDialogHint } from "../shared/dialog.ts";
import type { Located } from "./state.ts";
import { KindMark, StatusPill } from "./status.tsx";
import { UsageMeta } from "./usage.tsx";
import { MemoryMeta } from "./memory.tsx";
import { CurrentToolLine, TaskLine } from "./activity.tsx";
import { SubagentList } from "./subagents.tsx";
import { GitBadge } from "./git.tsx";
import { ReviewSection } from "./review.tsx";
import { historyParts } from "./history.ts";
import { copyText, TerminalScreen } from "./terminal.tsx";
import { ChangesPanel, PreviewTabs, usePreviewTab } from "./changes.tsx";
import { useShortcut } from "./hooks/useShortcut.ts";
import { parseAnsi, runsText } from "../shared/ansi.ts";

// Reading scrollback costs herdr about two seconds, so pinned previews refresh slowly.
const PINNED_LINES = 1000;
const PINNED_REFRESH_MS = 5000;
// The visible screen is cheap to read; a blocked agent's dialog is kept current with it.
const BLOCKED_REFRESH_MS = 2000;
// A transcript is re-read when the agent's status changes, and this often while it works.
const HISTORY_REFRESH_MS = 15_000;

interface Screen {
  /** The screen with its colors, as SGR escape sequences. */
  text: string;
  /** The pane keeps no scrollback, so its history comes from its transcript. */
  history: boolean;
}

async function readScreen(paneId: string, pinned: boolean): Promise<Screen> {
  const params = new URLSearchParams({ pane: paneId, format: "ansi" });
  if (pinned) {
    params.set("source", "recent");
    params.set("lines", String(PINNED_LINES));
  }
  const body = await (await fetch(`/api/read?${params}`)).json();
  return { text: body.text ?? body.error ?? "", history: !!body.history };
}

interface History {
  text: string;
  truncated: boolean;
}

async function readHistory(paneId: string): Promise<History | undefined> {
  const res = await fetch(`/api/history?${new URLSearchParams({ pane: paneId })}`);
  if (!res.ok) return undefined;
  const body = await res.json();
  return body.text ? { text: body.text, truncated: !!body.truncated } : undefined;
}

/** An agent's conversation from its transcript, above its live screen. */
function PreviewHistory({ history }: { history: History }) {
  const parts = useMemo(() => historyParts(history.text), [history.text]);
  return (
    <div className="preview-history" aria-label="Transcript history">
      {history.truncated && <p className="history-note">Earlier history isn't shown.</p>}
      {parts.map((p, i) => (
        <div key={i} className={`history-${p.kind}`}>
          {p.text}
        </div>
      ))}
      <div className="history-divider" role="separator">
        Live screen
      </div>
    </div>
  );
}

function isAtBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

interface Props {
  located: Located;
  /** Live agents' names by pane ID, for checking a new name. */
  agentNames: Map<string, string>;
  pinned: boolean;
  now: number;
  onOpen: () => void;
  onTogglePin: () => void;
}

export function PaneDetail({ located, agentNames, pinned, now, onOpen, onTogglePin }: Props) {
  const { pane, workspace, tabLabel } = located;
  const [screen, setScreen] = useState<string>();
  const [readAt, setReadAt] = useState<number>();
  const [following, setFollowing] = useState(true);
  const [wantsHistory, setWantsHistory] = useState(false);
  const [history, setHistory] = useState<History>();
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [tab, setTab] = usePreviewTab();
  const onScreen = tab === "screen";
  useShortcut({ key: "c", description: "Switch the preview between Screen and Changes" }, () => setTab(onScreen ? "changes" : "screen"));

  const load = useCallback(async () => {
    const read = await readScreen(pane.id, pinned);
    if (scroller.current) stickToBottom.current = isAtBottom(scroller.current);
    setScreen(read.text);
    setWantsHistory(read.history);
    setReadAt(Date.now());
  }, [pane.id, pinned]);

  const loadHistory = useCallback(async () => {
    const read = await readHistory(pane.id);
    if (scroller.current) stickToBottom.current = isAtBottom(scroller.current);
    setHistory(read);
  }, [pane.id]);

  // Hover previews read the visible screen once, after a short debounce so sweeping
  // the pointer across the map doesn't fire a read per pane.
  useEffect(() => {
    setScreen(undefined);
    setWantsHistory(false);
    setHistory(undefined);
    stickToBottom.current = true;
    setFollowing(true);
    if (pinned) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      readScreen(pane.id, false).then((read) => !cancelled && setScreen(read.text));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pane.id, pinned]);

  // Pinned previews load scrollback and refresh while you're following the bottom.
  // Scrolling up pauses refreshes, and so does the Changes tab unless the reply box needs a dialog's options.
  const readsScreen = onScreen || pane.agent?.status === "blocked";
  useEffect(() => {
    if (!pinned || !readsScreen) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      const scrolledUp = scroller.current ? !isAtBottom(scroller.current) : false;
      if (!document.hidden && !scrolledUp) await load().catch(() => undefined);
      if (!stopped) timer = setTimeout(tick, PINNED_REFRESH_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pinned, readsScreen, load]);

  // Transcripts change by whole turns, so history is read on its own slower schedule.
  const status = pane.agent?.status;
  const showHistory = pinned && wantsHistory;
  useEffect(() => {
    if (!showHistory || !onScreen) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      const scrolledUp = scroller.current ? !isAtBottom(scroller.current) : false;
      if (!document.hidden && !scrolledUp) await loadHistory().catch(() => undefined);
      if (!stopped && status === "working") timer = setTimeout(tick, HISTORY_REFRESH_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [showHistory, onScreen, status, loadHistory]);

  const runs = useMemo(() => (screen === undefined ? undefined : parseAnsi(screen)), [screen]);
  const screenText = useMemo(() => runs && runsText(runs), [runs]);

  // A dialog changes as it is answered, so the hover preview stays live while one is up.
  // Codex pickers leave herdr's status at idle, so key hints on screen count too.
  const blocked = pane.agent?.status === "blocked" || (!!screenText && hasDialogHint(screenText));
  useEffect(() => {
    if (pinned || !blocked) return;
    const id = setInterval(() => void load().catch(() => undefined), BLOCKED_REFRESH_MS);
    return () => clearInterval(id);
  }, [pinned, blocked, load]);

  // After input, re-read once the terminal has reacted, and again once the agent settles.
  const afterSend = useCallback(() => {
    stickToBottom.current = true;
    setTimeout(() => void load().catch(() => undefined), 700);
    setTimeout(() => void load().catch(() => undefined), 2500);
  }, [load]);

  useLayoutEffect(() => {
    if (scroller.current && stickToBottom.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [screen, history, onScreen]);

  // Scrolling back to the bottom, by hand or with Jump to bottom, resumes refreshes right away.
  const resume = useCallback(() => {
    stickToBottom.current = true;
    setFollowing(true);
    void load().catch(() => undefined);
    if (showHistory) void loadHistory().catch(() => undefined);
  }, [load, loadHistory, showHistory]);

  const agent = pane.agent;
  const withHistory = showHistory && !!history;
  const paused = pinned && !following;
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="space-y-1.5">
        <div className="space-y-1" aria-label="Preview header">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <KindMark kind={agent?.kind} title={pane.title} />
            {agent ? (
              <h2 className="flex min-w-0 flex-wrap items-center text-sm">
                <AgentName key={pane.id} located={located} names={agentNames} />
              </h2>
            ) : (
              <h2 className="min-w-0 truncate text-sm font-medium" title={pane.title}>
                {pane.title}
              </h2>
            )}
            {agent && <StatusPill status={agent.status} age={agentAge(agent, now)} />}
            {agent?.stuck && <StuckBadge stuck={agent.stuck} now={now} />}
            <div className="ml-auto flex shrink-0 items-center">
              {agent && <StarButton paneId={pane.id} />}
              <Button variant="ghost" size="icon" className="size-7" aria-label="Open in terminal" title="Open in terminal (o)" onClick={onOpen}>
                <SquareTerminal className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={pinned ? "Unpin" : "Pin"}
                title={pinned ? "Unpin this preview" : "Pin this preview (⌥ click a pane)"}
                aria-pressed={pinned}
                onClick={onTogglePin}
              >
                {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </Button>
              <ZoetropeButton located={located} />
              {pinned && (
                <Button variant="ghost" size="icon" className="size-7" aria-label="Refresh" title="Refresh" onClick={() => void load()}>
                  <RefreshCw className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
          <div className="preview-meta" aria-label="Pane details">
            <div className="preview-meta-items">
              <span className="meta-ws" title={[`${workspace.label} / ${tabLabel}`, pane.cwd].filter(Boolean).join("\n")}>
                <span className="truncate">{workspace.label}</span>
              </span>
              {workspace.git && (
                <span className="git-line">
                  <GitBadge git={workspace.git} worktree={workspace.linkedWorktree} />
                </span>
              )}
              <UsageMeta located={located} />
              <MemoryMeta agent={agent} />
            </div>
          </div>
        </div>
        <PreviewTabs tab={tab} onChange={setTab} />
        {onScreen && (
          <>
            <CurrentToolLine agent={agent} now={now} />
            <TaskLine agent={agent} />
            {agent && <SubagentList pane={pane.id} agent={agent} />}
            {agent?.summary && <p className="text-sm leading-snug">{agent.summary}</p>}
            {agent && <ReviewSection located={located} pinned={pinned} />}
          </>
        )}
      </div>

      {!onScreen && <ChangesPanel key={workspace.id} workspace={workspace} agentPane={agent ? pane.id : undefined} pinned={pinned} />}
      {/* The reply box keeps its place among the children on both tabs, so a draft survives switching. */}
      {agent && <ReplyBox located={located} screen={screenText} onSent={afterSend} />}
      {onScreen && agent && <AgentAutomation located={located} now={now} />}

      {onScreen && !pinned && (
        <p className="text-xs text-muted-foreground">
          <Kbd>⌥</Kbd> click a pane, or press Pin, to keep this preview and scroll its history.
        </p>
      )}

      {/* Hidden rather than unmounted on the Changes tab, so its screen and history stay loaded. */}
      <div className={cn("screen-block relative flex min-h-40 flex-col", pinned ? "flex-1" : "max-h-[55vh]", !onScreen && "hidden")}>
        <div className="screen-tools">
          {pinned && (
            <Badge variant="outline" className={cn("gap-1.5 bg-background/90 font-normal", following && "hover-only")}>
              <span className={cn("size-1.5 rounded-full", following ? "bg-status-done" : "bg-status-idle")} />
              {following ? "Live" : "Paused"}
              {readAt ? <span className="text-muted-foreground">· {formatAge(now - readAt)} ago</span> : null}
            </Badge>
          )}
          {paused && (
            <Button
              variant="secondary"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={() => {
                if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
                resume();
              }}
            >
              <ArrowDownToLine className="size-3" />
              Jump to bottom
            </Button>
          )}
          <Button
            variant="secondary"
            size="icon"
            className="hover-only size-6"
            aria-label="Copy screen"
            title="Copy screen as plain text"
            disabled={!screenText}
            onClick={() => screenText && void copyText(screenText, "screen")}
          >
            <Copy className="size-3" />
          </Button>
        </div>
        <div
          ref={scroller}
          className={cn(
            "min-h-0 flex-1 overflow-auto rounded-lg border font-mono text-[11px] leading-snug",
            withHistory ? "bg-muted/40 p-3" : "terminal-surface",
          )}
          aria-label="Screen preview"
          onScroll={(e) => {
            if (!pinned) return;
            const atBottom = isAtBottom(e.currentTarget);
            if (atBottom && !following) resume();
            else setFollowing(atBottom);
          }}
        >
          {withHistory && <PreviewHistory history={history} />}
          <TerminalScreen runs={runs} />
        </div>
      </div>
    </section>
  );
}

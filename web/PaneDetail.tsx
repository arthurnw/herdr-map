import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pin, PinOff, RefreshCw, SquareTerminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { StuckBadge } from "./attention.tsx";
import { AgentName } from "./rename.tsx";
import { StarButton } from "./stars.tsx";
import { ZoetropeButton } from "./zoetrope.tsx";
import { agentAge, formatAge } from "./format.ts";
import { ReplyBox } from "./ReplyBox.tsx";
import { AgentAutomation } from "./AgentAutomation.tsx";
import { hasDialogHint } from "../shared/dialog.ts";
import type { Located } from "./state.ts";
import { KIND_LABEL, StatusDot } from "./status.tsx";
import { UsageLine } from "./usage.tsx";
import { TaskLine } from "./activity.tsx";
import { SubagentList } from "./subagents.tsx";

// Reading scrollback costs herdr about two seconds, so pinned previews refresh slowly.
const PINNED_LINES = 1000;
const PINNED_REFRESH_MS = 5000;
// The visible screen is cheap to read; a blocked agent's dialog is kept current with it.
const BLOCKED_REFRESH_MS = 2000;

async function readScreen(paneId: string, pinned: boolean): Promise<string> {
  const params = new URLSearchParams({ pane: paneId });
  if (pinned) {
    params.set("source", "recent");
    params.set("lines", String(PINNED_LINES));
  }
  const body = await (await fetch(`/api/read?${params}`)).json();
  return body.text ?? body.error ?? "";
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
  const pre = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    const text = await readScreen(pane.id, pinned);
    if (pre.current) stickToBottom.current = isAtBottom(pre.current);
    setScreen(text);
    setReadAt(Date.now());
  }, [pane.id, pinned]);

  // Hover previews read the visible screen once, after a short debounce so sweeping
  // the pointer across the map doesn't fire a read per pane.
  useEffect(() => {
    setScreen(undefined);
    stickToBottom.current = true;
    setFollowing(true);
    if (pinned) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      readScreen(pane.id, false).then((text) => !cancelled && setScreen(text));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pane.id, pinned]);

  // Pinned previews load scrollback and refresh while you're following the bottom.
  // Scrolling up pauses refreshes so the text doesn't move while you read.
  useEffect(() => {
    if (!pinned) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      const scrolledUp = pre.current ? !isAtBottom(pre.current) : false;
      if (!document.hidden && !scrolledUp) await load().catch(() => undefined);
      if (!stopped) timer = setTimeout(tick, PINNED_REFRESH_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pinned, load]);

  // A dialog changes as it is answered, so the hover preview stays live while one is up.
  // Codex pickers leave herdr's status at idle, so key hints on screen count too.
  const blocked = pane.agent?.status === "blocked" || (!!screen && hasDialogHint(screen));
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
    if (pre.current && stickToBottom.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [screen]);

  const agent = pane.agent;
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          {pinned && <Pin className="size-3.5 shrink-0 text-muted-foreground" />}
          <h2 className="truncate text-sm font-semibold">
            {workspace.label}
            <span className="font-normal text-muted-foreground"> / {tabLabel}</span>
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {agent ? (
            <>
              <StarButton paneId={pane.id} />
              <StatusDot status={agent.status} />
              <AgentName key={pane.id} located={located} names={agentNames} />
              {agent.name && <Badge variant="secondary">{KIND_LABEL[agent.kind] ?? agent.kind}</Badge>}
              <span className="text-muted-foreground">
                {agent.status} for {agentAge(agent, now)}
              </span>
              {agent.stuck && <StuckBadge stuck={agent.stuck} now={now} />}
            </>
          ) : (
            <span className="text-muted-foreground">{pane.title}</span>
          )}
        </div>
        {pane.cwd && (
          <p className="truncate font-mono text-xs text-muted-foreground" title={pane.cwd}>
            {pane.cwd}
          </p>
        )}
        <UsageLine located={located} />
        <TaskLine agent={agent} />
        {agent && <SubagentList pane={pane.id} agent={agent} />}
        {agent?.summary && <p className="text-sm leading-snug">{agent.summary}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="gap-1.5" onClick={onOpen}>
          <SquareTerminal className="size-3.5" />
          Open in terminal
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onTogglePin} aria-pressed={pinned}>
          {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          {pinned ? "Unpin" : "Pin"}
        </Button>
        <ZoetropeButton located={located} />
        {pinned && (
          <>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Refresh" onClick={() => void load()}>
              <RefreshCw className="size-3.5" />
            </Button>
            <Badge variant="outline" className="gap-1.5 font-normal">
              <span className={cn("size-1.5 rounded-full", following ? "bg-status-done" : "bg-status-idle")} />
              {following ? "Live" : "Paused"}
              {readAt ? <span className="text-muted-foreground">· {formatAge(now - readAt)} ago</span> : null}
            </Badge>
          </>
        )}
      </div>

      {agent && <ReplyBox located={located} screen={screen} onSent={afterSend} />}
      {agent && <AgentAutomation located={located} now={now} />}

      {!pinned && (
        <p className="text-xs text-muted-foreground">
          <Kbd>⌥</Kbd> click a pane, or press Pin, to keep this preview and scroll its history.
        </p>
      )}

      <pre
        ref={pre}
        className={cn(
          "min-h-40 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-snug whitespace-pre",
          pinned ? "flex-1" : "max-h-[55vh]",
        )}
        onScroll={(e) => {
          if (!pinned) return;
          const atBottom = isAtBottom(e.currentTarget);
          // Returning to the bottom resumes live updates right away.
          if (atBottom && !following) void load();
          setFollowing(atBottom);
        }}
      >
        {screen ?? <span className="text-muted-foreground">Loading screen…</span>}
      </pre>
    </section>
  );
}

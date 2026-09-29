import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FleetPane, FleetWorkspace } from "../shared/model.ts";
import { agentAge, formatAge } from "./nodes.tsx";

export interface Located {
  pane: FleetPane;
  tabId: string;
  tabLabel: string;
  workspace: FleetWorkspace;
}

// Reading scrollback costs herdr about two seconds, so pinned previews refresh slowly.
const PINNED_LINES = 1000;
const PINNED_REFRESH_MS = 5000;

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
  pinned: boolean;
  now: number;
  onOpen: () => void;
  onTogglePin: () => void;
}

export function PaneDetail({ located, pinned, now, onOpen, onTogglePin }: Props) {
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

  useLayoutEffect(() => {
    if (pre.current && stickToBottom.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [screen]);

  return (
    <section className={`detail-panel${pinned ? " pinned" : ""}`}>
      <h2>
        {workspace.label} › {tabLabel}
      </h2>
      <p>
        {pane.agent ? (
          <>
            <span className={`dot status-${pane.agent.status}`} /> {pane.agent.name ?? pane.agent.kind} ·{" "}
            {pane.agent.status} for {agentAge(pane.agent, now)}
          </>
        ) : (
          pane.title
        )}
      </p>
      {pane.cwd && <p className="muted mono">{pane.cwd}</p>}
      {pane.agent?.summary && <p>{pane.agent.summary}</p>}
      <div className="detail-actions">
        <button className="primary" onClick={onOpen}>
          Open in terminal
        </button>
        <button className="plain" onClick={onTogglePin} aria-pressed={pinned}>
          {pinned ? "Unpin" : "Pin"}
        </button>
        {pinned && (
          <>
            <button className="plain" onClick={() => void load()}>
              Refresh
            </button>
            <span className="muted">
              {following ? "live" : "paused"}
              {readAt ? ` · ${formatAge(now - readAt)} ago` : ""}
            </span>
          </>
        )}
      </div>
      {!pinned && <p className="muted hint">Option-click a pane, or press Pin, to keep this preview and scroll its history.</p>}
      <pre
        ref={pre}
        className="screen"
        onScroll={(e) => {
          if (!pinned) return;
          const atBottom = isAtBottom(e.currentTarget);
          // Returning to the bottom resumes live updates right away.
          if (atBottom && !following) void load();
          setFollowing(atBottom);
        }}
      >
        {screen ?? "Loading screen…"}
      </pre>
    </section>
  );
}

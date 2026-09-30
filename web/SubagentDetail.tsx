import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Located } from "./state.ts";
import { subagentDuration, subagentLabel, subagentStats } from "./subagents.tsx";

// While a subagent runs, its transcript is re-read this often, like a pinned preview.
const REFRESH_MS = 4000;

function isAtBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

interface DetailProps {
  located: Located;
  id: string;
  now: number;
  onBack: () => void;
}

/** A subagent's transcript in the sidebar, newest at the bottom. */
export function SubagentDetail({ located, id, now, onBack }: DetailProps) {
  const agent = located.pane.agent;
  const live = agent?.subagents?.find((s) => s.id === id);
  // The subagent can drop off the list while its transcript is open; keep showing what it last said.
  const last = useRef(live);
  if (live) last.current = live;
  const sub = live ?? last.current;
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const running = live?.status === "running";

  const load = useCallback(async () => {
    const params = new URLSearchParams({ pane: located.pane.id, id });
    const res = await fetch(`/api/subagent?${params}`);
    const body = await res.json();
    if (pre.current) stick.current = isAtBottom(pre.current);
    if (!res.ok) {
      setError(body.error ?? res.statusText);
      return;
    }
    setError(undefined);
    setText(body.text);
    setTruncated(!!body.truncated);
  }, [located.pane.id, id]);

  useEffect(() => {
    setText(undefined);
    setError(undefined);
    stick.current = true;
    if (!sub?.transcript) return;
    void load().catch((e: Error) => setError(e.message));
    // Only this subagent changing restarts the view.
  }, [load]);

  useEffect(() => {
    if (!running || !sub?.transcript) return;
    const timer = setInterval(() => {
      if (!document.hidden && (!pre.current || isAtBottom(pre.current))) void load().catch(() => undefined);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, sub?.transcript, load]);

  useLayoutEffect(() => {
    if (pre.current && stick.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text]);

  const duration = sub && subagentDuration(sub, now);
  const stats = sub && subagentStats(sub);
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4" aria-label="Subagent">
      <div className="space-y-1.5">
        <Button variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          Back to {agent?.name ?? located.workspace.label}
        </Button>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={cn("sub-dot-inline", sub && `sub-${sub.status}`)} aria-hidden />
          <h2 className="font-semibold">{sub ? subagentLabel(sub) : "Subagent"}</h2>
          {sub?.name && sub.type && <Badge variant="secondary">{sub.name}</Badge>}
          {sub && (
            <span className="text-muted-foreground">
              {live ? sub.status : "cleared"}
              {duration && ` · ${duration}`}
            </span>
          )}
          {sub?.transcript && (
            <Button variant="ghost" size="icon" className="ml-auto size-8" aria-label="Refresh" onClick={() => void load()}>
              <RefreshCw className="size-3.5" />
            </Button>
          )}
        </div>
        {sub?.description && <p className="text-sm leading-snug">{sub.description}</p>}
        {stats && <p className="text-xs text-muted-foreground tabular-nums">{stats}</p>}
      </div>
      {sub && !sub.transcript ? (
        <p className="text-sm text-muted-foreground">This subagent keeps no transcript herdr-map can read.</p>
      ) : (
        <>
          {truncated && <p className="text-xs text-muted-foreground">Showing the end of a long transcript.</p>}
          <pre
            ref={pre}
            className="min-h-40 flex-1 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-snug whitespace-pre-wrap"
            aria-label="Subagent transcript"
          >
            {error ? (
              <span className="text-muted-foreground">{error}</span>
            ) : (
              (text || <span className="text-muted-foreground">{text === undefined ? "Loading transcript…" : "No messages yet."}</span>)
            )}
          </pre>
        </>
      )}
    </section>
  );
}

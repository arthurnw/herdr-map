// An agent's subagents: the list its card's chip opens, the list in its sidebar preview, and which
// subagent's transcript the sidebar shows (SubagentDetail.tsx).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Workflow } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { FleetAgent, SubagentInfo } from "../shared/model.ts";
import { formatAge } from "./format.ts";
import { NowContext } from "./nodes.tsx";
import { stop } from "./organize.tsx";
import { subagentTree, visibleSubagents } from "./subagent-cards.ts";
import { formatCost, formatTokens } from "./usage.tsx";

const INDENT_PX = 12;

export function subagentDuration(s: SubagentInfo, now: number): string | undefined {
  if (s.startedAt === undefined) return undefined;
  return formatAge((s.status === "running" ? now : (s.endedAt ?? now)) - s.startedAt);
}

/** "12k tokens · 7 tools · $0.40", leaving out what isn't recorded. */
export function subagentStats(s: SubagentInfo): string {
  const parts: string[] = [];
  if (s.tokens) parts.push(`${formatTokens(s.tokens)} tokens`);
  if (s.toolCalls !== undefined) parts.push(`${s.toolCalls} tool${s.toolCalls === 1 ? "" : "s"}`);
  if (s.costUsd !== undefined) parts.push(formatCost(s.costUsd));
  return parts.join(" · ");
}

export function subagentLabel(s: SubagentInfo): string {
  return s.type ?? s.name ?? "subagent";
}

interface Selected {
  pane: string;
  id: string;
}

interface SubagentView {
  selected?: Selected;
  open(pane: string, id: string): void;
  /** Selects the agent, then opens the subagent's transcript. */
  show(pane: string, id: string): void;
  close(): void;
}

export const SubagentViewContext = createContext<SubagentView | undefined>(undefined);

/** Which subagent's transcript the sidebar shows. It closes when the pinned pane changes. */
export function useSubagentView(pinned: string | undefined, select: (pane: string) => void): SubagentView {
  const [selected, setSelected] = useState<Selected>();
  useEffect(() => {
    if (selected && selected.pane !== pinned) setSelected(undefined);
  }, [pinned, selected]);
  const open = useCallback((pane: string, id: string) => setSelected({ pane, id }), []);
  const show = useCallback(
    (pane: string, id: string) => {
      select(pane);
      open(pane, id);
    },
    [select, open],
  );
  const close = useCallback(() => setSelected(undefined), []);
  return useMemo(() => ({ selected, open, show, close }), [selected, open, show, close]);
}

/** The count on an agent card (`1/2`: one of two running); it opens the list of subagents. */
export function SubagentChip({ pane, agent }: { pane: string; agent: FleetAgent }) {
  const now = useContext(NowContext);
  const view = useContext(SubagentViewContext);
  const [open, setOpen] = useState(false);
  const subs = visibleSubagents(agent, now);
  if (subs.length === 0) return null;
  const running = subs.filter((s) => s.status === "running").length;
  const label = `${subs.length} subagent${subs.length === 1 ? "" : "s"}` + (running ? `, ${running} running` : "");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("subagent-chip nodrag nopan", running === 0 && "idle")}
          aria-label={label}
          title={`${label}. Click to list them.`}
          onClick={stop}
          onPointerDown={stop}
        >
          <Workflow aria-hidden />
          {running > 0 ? `${running}/${subs.length}` : subs.length}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[60vh] w-80 overflow-y-auto p-1"
        aria-label="Subagents"
        onClick={stop}
        onPointerDown={stop}
        onDoubleClick={stop}
        onKeyDown={stop}
      >
        <ul>
          {subagentTree(subs).map(({ sub, depth }) => {
            const selected = view?.selected?.pane === pane && view.selected.id === sub.id;
            const duration = subagentDuration(sub, now);
            const stats = subagentStats(sub);
            return (
              <li key={sub.id} style={{ paddingLeft: depth * INDENT_PX }} data-depth={depth}>
                <button
                  type="button"
                  className={cn("subagent-row", `sub-${sub.status}`, selected && "selected")}
                  title="Read its transcript"
                  onClick={() => {
                    setOpen(false);
                    view?.show(pane, sub.id);
                  }}
                >
                  <span className="sub-line">
                    <span className="sub-dot" aria-hidden />
                    <span className="sub-type">{subagentLabel(sub)}</span>
                    <span className="sub-status">
                      {sub.status}
                      {duration && ` · ${duration}`}
                    </span>
                  </span>
                  {(sub.description ?? sub.name) && <span className="sub-desc">{sub.description ?? sub.name}</span>}
                  {stats && <span className="sub-stats">{stats}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The agent's subagents as a short list in the sidebar preview; a row opens its transcript. */
export function SubagentList({ pane, agent }: { pane: string; agent: FleetAgent }) {
  const now = useContext(NowContext);
  const view = useContext(SubagentViewContext);
  const subs = visibleSubagents(agent, now);
  if (subs.length === 0 || !view) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">Subagents</p>
      <ul className="subagent-list">
        {subagentTree(subs).map(({ sub, depth }) => (
          <li key={sub.id} style={{ paddingLeft: depth * INDENT_PX }} data-depth={depth}>
            <button className={cn(`sub-${sub.status}`)} onClick={() => view.open(pane, sub.id)} title="Read its transcript">
              <span className="sub-dot" aria-hidden />
              <span className="font-medium">{subagentLabel(sub)}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{sub.description}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {[sub.status, subagentDuration(sub, now)].filter(Boolean).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Temporary cards for an agent's subagents, placed right of its card. They aren't saved in the
// layout. They sit under other agents' cards until their agent is selected, so they never hide
// another agent. Clicking one shows its transcript in the sidebar (SubagentDetail.tsx).
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { FleetAgent, SubagentInfo } from "../shared/model.ts";
import { formatAge } from "./format.ts";
import { NowContext } from "./nodes.tsx";
import { visibleSubagents, type SubagentData } from "./subagent-cards.ts";
import { formatCost, formatTokens } from "./usage.tsx";

export { subagentNodes, type SubagentData } from "./subagent-cards.ts";

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
  close(): void;
}

export const SubagentViewContext = createContext<SubagentView | undefined>(undefined);

/** Which subagent's transcript the sidebar shows. It closes when the pinned pane changes. */
export function useSubagentView(pinned: string | undefined): SubagentView {
  const [selected, setSelected] = useState<Selected>();
  useEffect(() => {
    if (selected && selected.pane !== pinned) setSelected(undefined);
  }, [pinned, selected]);
  const open = useCallback((pane: string, id: string) => setSelected({ pane, id }), []);
  const close = useCallback(() => setSelected(undefined), []);
  return useMemo(() => ({ selected, open, close }), [selected, open, close]);
}

export const SubagentNode = memo(({ data }: NodeProps) => {
  const { pane, sub, more } = data as SubagentData;
  const now = useContext(NowContext);
  const view = useContext(SubagentViewContext);
  if (!sub) return <div className="subagent-more">+{more} more</div>;
  const selected = view?.selected?.pane === pane && view.selected.id === sub.id;
  const duration = subagentDuration(sub, now);
  const stats = subagentStats(sub);
  return (
    <div
      className={cn("subagent", `sub-${sub.status}`, selected && "selected")}
      title={[subagentLabel(sub), sub.description, "Click to read its transcript"].filter(Boolean).join("\n")}
    >
      <div className="sub-line">
        <span className="sub-dot" aria-hidden />
        <span className="sub-type">{subagentLabel(sub)}</span>
        <span className="sub-status">
          {sub.status}
          {duration && ` · ${duration}`}
        </span>
      </div>
      <div className="sub-desc">{sub.description ?? sub.name ?? ""}</div>
      {stats && <div className="sub-stats">{stats}</div>}
    </div>
  );
});

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
        {subs.map((s) => (
          <li key={s.id}>
            <button className={cn(`sub-${s.status}`)} onClick={() => view.open(pane, s.id)} title="Read its transcript">
              <span className="sub-dot" aria-hidden />
              <span className="font-medium">{subagentLabel(s)}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.description}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {[s.status, subagentDuration(s, now)].filter(Boolean).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

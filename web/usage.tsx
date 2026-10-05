// Context and cost from the usage probe: a meter on agent cards and a line in the preview.
import type { AgentUsage, FleetWorkspace } from "../shared/model.ts";
import type { Located } from "./state.ts";

/** 950 → "950", 43_210 → "43k", 1_000_000 → "1M", 1_250_000 → "1.3M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function contextPercent(u: AgentUsage): number | undefined {
  if (!u.contextTokens || !u.contextWindow) return undefined;
  return Math.min(100, Math.round((u.contextTokens / u.contextWindow) * 100));
}

// Above this share of the window, the meter turns to the warning color.
const HIGH_PERCENT = 80;

function contextTitle(u: AgentUsage): string {
  const used = `${formatTokens(u.contextTokens!)} tokens of context`;
  return u.contextWindow ? `${used} of ${formatTokens(u.contextWindow)} (${contextPercent(u)}%)` : used;
}

/** Text for the card's status line, plus a thin bar along the card's bottom edge when the window is known. */
export function UsageMeter({ usage }: { usage: AgentUsage }) {
  if (!usage.contextTokens) return null;
  const pct = contextPercent(usage);
  const high = pct !== undefined && pct >= HIGH_PERCENT;
  return (
    <>
      <span className={`usage-ctx${high ? " high" : ""}`} title={contextTitle(usage)}>
        · {pct !== undefined ? `${pct}%` : formatTokens(usage.contextTokens)} ctx
      </span>
      {pct !== undefined && (
        <span className={`usage-bar${high ? " high" : ""}`} aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
    </>
  );
}

/** Recorded cost summed over a workspace's agents, or undefined when none record cost. */
export function workspaceCost(ws: FleetWorkspace): { usd: number; agents: number } | undefined {
  let usd = 0;
  let agents = 0;
  for (const t of ws.tabs)
    for (const p of t.panes) {
      const c = p.agent?.usage?.costUsd;
      if (c !== undefined) {
        usd += c;
        agents++;
      }
    }
  return agents ? { usd, agents } : undefined;
}

/** The preview's context and cost, compact. Tokens, window, and model are in the context figure's title. */
export function UsageMeta({ located }: { located: Located }) {
  const u = located.pane.agent?.usage;
  if (!u || (!u.contextTokens && u.costUsd === undefined)) return null;
  const pct = contextPercent(u);
  const total = workspaceCost(located.workspace);
  const costTitle = [
    u.costUsd !== undefined && `${formatCost(u.costUsd)} spent in this session`,
    total && total.agents > 1 && `${formatCost(total.usd)} across ${total.agents} agents in ${located.workspace.label}`,
  ].filter(Boolean);
  return (
    <span className="meta-group tabular-nums" aria-label="Usage">
      {!!u.contextTokens && (
        <span className={pct !== undefined && pct >= HIGH_PERCENT ? "font-semibold text-(--stuck)" : undefined} title={[contextTitle(u), u.model].filter(Boolean).join("\n")}>
          {pct !== undefined ? `${pct}%` : formatTokens(u.contextTokens)} ctx
        </span>
      )}
      {u.costUsd !== undefined && <span title={costTitle.join("\n")}>{formatCost(u.costUsd)}</span>}
    </span>
  );
}

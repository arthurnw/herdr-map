// Task progress, running subagents, Codex reviews, and hunk review notes on agent cards, and the
// current task and tool call in the preview.
import { ShieldCheck, Wrench } from "lucide-react";
import type { CurrentTool, FleetAgent, TaskProgress } from "../shared/model.ts";
import { formatAge } from "./format.ts";
import { MemoryChip } from "./memory.tsx";
import { AgentReviewChip } from "./review.tsx";
import { SubagentChip } from "./subagents.tsx";

/** A finished list stays on the card while the turn that finished it is still on screen. */
export function showTasks(agent: FleetAgent): boolean {
  const t = agent.tasks;
  if (!t || t.total === 0) return false;
  return t.done < t.total || agent.status === "working" || agent.status === "blocked" || agent.status === "done";
}

function taskTitle(t: TaskProgress): string {
  return `${t.done} of ${t.total} tasks done${t.current ? `. Now: ${t.current}` : ""}`;
}

const RING_R = 6;
const RING_C = 2 * Math.PI * RING_R;

export function TaskChip({ tasks }: { tasks: TaskProgress }) {
  const share = tasks.total ? tasks.done / tasks.total : 0;
  return (
    <span className="task-chip" title={taskTitle(tasks)}>
      <svg className="task-ring" viewBox="0 0 16 16" aria-hidden>
        <circle className="task-ring-track" cx="8" cy="8" r={RING_R} />
        <circle
          className="task-ring-fill"
          cx="8"
          cy="8"
          r={RING_R}
          strokeDasharray={`${share * RING_C} ${RING_C}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      {tasks.done}/{tasks.total}
    </span>
  );
}

/** Extras for an agent card's status line: memory, task progress, running subagents, running Codex reviews, and hunk review notes. */
export function AgentActivity({ pane, agent }: { pane: string; agent: FleetAgent }) {
  const reviewing = agent.reviews?.running ?? 0;
  return (
    <>
      {agent.memory && <MemoryChip memory={agent.memory} />}
      {showTasks(agent) && <TaskChip tasks={agent.tasks!} />}
      <SubagentChip pane={pane} agent={agent} />
      {reviewing > 0 && (
        <span className="review-chip" title={`Codex is reviewing ${reviewing === 1 ? "an approval" : `${reviewing} approvals`}`}>
          <ShieldCheck aria-hidden />
          {reviewing > 1 ? reviewing : ""}
        </span>
      )}
      <AgentReviewChip pane={pane} agent={agent} />
    </>
  );
}

/** The preview's task line: progress and the task in progress. */
export function TaskLine({ agent }: { agent?: FleetAgent }) {
  const t = agent?.tasks;
  if (!t || t.total === 0) return null;
  return (
    <p className="text-xs text-muted-foreground" aria-label="Tasks">
      <span className="tabular-nums">
        {t.done} of {t.total} tasks done
      </span>
      {t.current && (
        <>
          {" · "}
          <span className="text-foreground">{t.current}</span>
        </>
      )}
    </p>
  );
}

/** The tool call a working agent is running. A call left open by an agent that stopped doesn't count. */
export function runningTool(agent?: FleetAgent): CurrentTool | undefined {
  return agent?.status === "working" ? agent.current : undefined;
}

/** "Bash npm test" */
export function toolText(c: CurrentTool): string {
  return c.summary ? `${c.tool} ${c.summary}` : c.tool;
}

/** A card's tooltip while its agent runs a tool. */
export function runningTitle(agent: FleetAgent): string | undefined {
  const c = runningTool(agent);
  return c && `Running ${toolText(c)}`;
}

/** The preview's line for the tool call a working agent is running, and for how long. */
export function CurrentToolLine({ agent, now }: { agent?: FleetAgent; now: number }) {
  const c = runningTool(agent);
  if (!c) return null;
  const text = toolText(c);
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" aria-label="Current tool">
      <Wrench className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0">Running</span>
      <code className="min-w-0 truncate rounded bg-muted px-1 py-px font-mono text-[11px] text-foreground" title={text}>
        {text}
      </code>
      {c.startedAt !== undefined && <span className="shrink-0 tabular-nums">· {formatAge(now - c.startedAt)}</span>}
    </p>
  );
}

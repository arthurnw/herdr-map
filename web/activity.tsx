// Task progress, running subagents, and Codex reviews on agent cards, and the current task in the preview.
import { ShieldCheck } from "lucide-react";
import type { FleetAgent, TaskProgress } from "../shared/model.ts";
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

/** Extras for an agent card's status line: task progress, running subagents, and running Codex reviews. */
export function AgentActivity({ pane, agent }: { pane: string; agent: FleetAgent }) {
  const reviewing = agent.reviews?.running ?? 0;
  return (
    <>
      {showTasks(agent) && <TaskChip tasks={agent.tasks!} />}
      <SubagentChip pane={pane} agent={agent} />
      {reviewing > 0 && (
        <span className="review-chip" title={`Codex is reviewing ${reviewing === 1 ? "an approval" : `${reviewing} approvals`}`}>
          <ShieldCheck aria-hidden />
          {reviewing > 1 ? reviewing : ""}
        </span>
      )}
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

// Running subagents and Codex reviews on agent cards.
import { ShieldCheck, Workflow } from "lucide-react";
import type { FleetAgent } from "../shared/model.ts";

/** Extras for an agent card's status line: running subagents and running Codex reviews. */
export function AgentActivity({ agent }: { agent: FleetAgent }) {
  const reviewing = agent.reviews?.running ?? 0;
  const running = agent.subagents?.filter((s) => s.status === "running").length ?? 0;
  return (
    <>
      {running > 0 && (
        <span className="subagent-chip" title={`${running} subagent${running === 1 ? "" : "s"} running. Select the agent to bring their cards forward.`}>
          <Workflow aria-hidden />
          {running}
        </span>
      )}
      {reviewing > 0 && (
        <span className="review-chip" title={`Codex is reviewing ${reviewing === 1 ? "an approval" : `${reviewing} approvals`}`}>
          <ShieldCheck aria-hidden />
          {reviewing > 1 ? reviewing : ""}
        </span>
      )}
    </>
  );
}

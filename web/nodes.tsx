import { createContext, memo, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FleetAgent } from "../shared/model.ts";
import type { GroupData, PaneData, TabData, WorkspaceData } from "./layout.ts";

export const NowContext = createContext(Date.now());

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d`;
}

export function agentAge(agent: FleetAgent, now: number): string {
  return `${formatAge(now - agent.since)}${agent.sinceApprox ? "+" : ""}`;
}

const KIND_LABEL: Record<string, string> = { claude: "claude", pi: "π pi", codex: "codex" };

export const GroupNode = memo(({ data }: NodeProps) => {
  const { group } = data as GroupData;
  return (
    <div className="group-box">
      <div className="group-header">{group.label}</div>
    </div>
  );
});

export const WorkspaceNode = memo(({ data }: NodeProps) => {
  const { workspace: ws } = data as WorkspaceData;
  return (
    <div className={`workspace${ws.focused ? " focused" : ""}`}>
      <div className="ws-header" data-focus="workspace" title="Focus workspace">
        <span className="ws-number">{ws.number}</span>
        <span className="ws-label">{ws.label}</span>
        {ws.linkedWorktree && <span className="ws-tag">worktree</span>}
        <span className="ws-count">{ws.agentCount ? `${ws.agentCount} agent${ws.agentCount > 1 ? "s" : ""}` : ""}</span>
      </div>
      <div className="ws-bigname">{ws.label}</div>
    </div>
  );
});

export const TabNode = memo(({ data }: NodeProps) => {
  const { tab } = data as TabData;
  return (
    <div className={`tab${tab.focused ? " focused" : ""}`}>
      <div className="tab-header" data-focus="tab" title="Focus tab">
        {tab.label}
      </div>
    </div>
  );
});

export const PaneNode = memo(({ data }: NodeProps) => {
  const { pane } = data as PaneData;
  const now = useContext(NowContext);
  const handles = (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
  if (!pane.agent) {
    return (
      <div className={`pane tool${pane.focused ? " focused" : ""}`} title={pane.title}>
        {handles}
        <span className="detail tool-title">{pane.title}</span>
      </div>
    );
  }
  const { agent } = pane;
  return (
    <div className={`pane agent status-${agent.status}${pane.focused ? " focused" : ""}`}>
      {handles}
      <div className="agent-line">
        <span className="agent-kind">{KIND_LABEL[agent.kind] ?? agent.kind}</span>
        {agent.name && <span className="agent-name detail">{agent.name}</span>}
      </div>
      <div className="agent-status detail">
        {agent.status} · {agentAge(agent, now)}
      </div>
      {agent.summary && <div className="agent-summary detail">{agent.summary}</div>}
    </div>
  );
});

export const nodeTypes = {
  "group-box": GroupNode,
  workspace: WorkspaceNode,
  tab: TabNode,
  pane: PaneNode,
};

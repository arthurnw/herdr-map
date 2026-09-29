import { createContext, memo, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { DoneMarker, StuckMarker } from "./attention.tsx";
import { agentAge } from "./format.ts";
import type { GroupData, PaneData, TabData, WorkspaceData } from "./layout.ts";
import { KIND_LABEL } from "./status.tsx";

export const NowContext = createContext(Date.now());

export { agentAge, formatAge } from "./format.ts";

export const GroupNode = memo(({ data }: NodeProps) => {
  const { group } = data as GroupData;
  return (
    <div className="group-box" title="Drag to move this repo's workspaces">
      <div className="group-header">{group.label}</div>
    </div>
  );
});

export const WorkspaceNode = memo(({ data }: NodeProps) => {
  const { workspace: ws, groupLabel, detached } = data as WorkspaceData;
  return (
    <div className={`workspace${ws.focused ? " focused" : ""}`}>
      <div className="ws-header" title="Click to focus, drag to move">
        <span className="ws-number">{ws.number}</span>
        <span className="ws-label">{ws.label}</span>
        {detached && <span className="ws-tag">{groupLabel}</span>}
        {ws.linkedWorktree && <span className="ws-tag">worktree</span>}
        <DoneMarker workspace={ws} />
        <span className="ws-count">{ws.agentCount ? `${ws.agentCount} agent${ws.agentCount > 1 ? "s" : ""}` : ""}</span>
      </div>
    </div>
  );
});

export const WorkspaceLabelNode = memo(({ data }: NodeProps) => {
  const { workspace: ws } = data as WorkspaceData;
  return (
    <div className="ws-label-float">
      <span className="ws-number">{ws.number}</span> {ws.label}
      <DoneMarker workspace={ws} />
    </div>
  );
});

export const TabNode = memo(({ data }: NodeProps) => {
  const { tab } = data as TabData;
  return (
    <div className={`tab${tab.focused ? " focused" : ""}`}>
      <div className="tab-header" title="Focus tab">
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
  const kind = KIND_LABEL[agent.kind] ?? agent.kind;
  return (
    <div className={`pane agent status-${agent.status}${pane.focused ? " focused" : ""}${agent.stuck ? " stuck" : ""}`}>
      {handles}
      <div className="agent-line">
        <span className="agent-name">{agent.name ?? kind}</span>
        {agent.name && <span className="agent-kind">{kind}</span>}
      </div>
      <div className="agent-status">
        <span className="agent-dot" />
        {agent.status} · {agentAge(agent, now)}
      </div>
      {agent.stuck && <StuckMarker stuck={agent.stuck} now={now} />}
      {agent.summary && <div className="agent-summary">{agent.summary}</div>}
    </div>
  );
});

export const nodeTypes = {
  "group-box": GroupNode,
  workspace: WorkspaceNode,
  "ws-label": WorkspaceLabelNode,
  tab: TabNode,
  pane: PaneNode,
};

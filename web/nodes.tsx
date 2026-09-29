import { createContext, memo, useContext, useRef, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ChevronsDownUp, ChevronsUpDown, Ellipsis, FolderGit2, Group, Palette, Star, Ungroup } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceActions } from "./workspace-actions.ts";
import { DoneMarker, StuckMarker } from "./attention.tsx";
import { agentAge } from "./format.ts";
import { useStarsContext } from "./stars.tsx";
import type { GroupData, PaneData, TabData, WorkspaceData } from "./layout.ts";
import { KIND_LABEL } from "./status.tsx";
import { UsageMeter } from "./usage.tsx";
import { ColorItems, GroupColorMenu, StatusCounts, TagChips, TagInput, TagMenuItems, tintClass } from "./organize.tsx";

export const NowContext = createContext(Date.now());

export { agentAge, formatAge } from "./format.ts";

export const GroupNode = memo(({ data }: NodeProps) => {
  const { group, color } = data as GroupData;
  return (
    <div className={`group-box ${tintClass(color)}`} title="Drag to move this repo's workspaces">
      <div className="group-header">
        <span className="group-label">{group.label}</span>
        <GroupColorMenu groupKey={group.key} groupLabel={group.label} color={color} />
      </div>
    </div>
  );
});

export const WorkspaceNode = memo(({ data }: NodeProps) => {
  const { workspace: ws, groupLabel, detached, dropHint, collapsed, color, tags } = data as WorkspaceData;
  const [addingTag, setAddingTag] = useState(false);
  const actions = useContext(WorkspaceActions);
  const classes = ["workspace", ws.focused && "focused", dropHint && `drop-${dropHint}`, collapsed && "collapsed", tintClass(color)]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      {dropHint && (
        <div className="ws-drop-hint">
          {dropHint === "detach" ? `Drop to take out of the ${groupLabel} box` : `Drop to put back in the ${groupLabel} box`}
        </div>
      )}
      <div className="ws-header" title="Click to focus, drag to move">
        <span className="ws-number">{ws.number}</span>
        <span className="ws-label">{ws.label}</span>
        {detached && (
          <span className="ws-tag ws-repo-tag" title={`In ${groupLabel}, outside its box`}>
            <FolderGit2 aria-hidden />
            {groupLabel}
          </span>
        )}
        {ws.linkedWorktree && <span className="ws-tag">worktree</span>}
        <TagChips tags={tags} />
        {addingTag && <TagInput onAdd={(t) => actions?.addTag([ws.id], t)} onClose={() => setAddingTag(false)} />}
        <DoneMarker workspace={ws} />
        {collapsed && <StatusCounts workspace={ws} />}
        <span className="ws-count">{ws.agentCount ? `${ws.agentCount} agent${ws.agentCount > 1 ? "s" : ""}` : ""}</span>
        <WorkspaceMenu data={data as WorkspaceData} onAddTag={() => setAddingTag(true)} />
      </div>
    </div>
  );
});

// Stops clicks from reaching React Flow, which would focus the workspace in herdr; menu
// content renders in a portal, but React still bubbles its events through the node.
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

function WorkspaceMenu({ data, onAddTag }: { data: WorkspaceData; onAddTag: () => void }) {
  const actions = useContext(WorkspaceActions);
  // Set by Add tag. The tag input opens once the menu has closed, so the menu can't take focus back.
  const addTag = useRef(false);
  const { workspace: ws, groupLabel, detached, groupMates, collapsed } = data;
  if (!actions) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="ws-menu nodrag nopan" aria-label={`Actions for ${ws.label}`} onClick={stop} onPointerDown={stop}>
          <Ellipsis aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={stop}
        onPointerDown={stop}
        onCloseAutoFocus={(e) => {
          if (!addTag.current) return;
          addTag.current = false;
          e.preventDefault();
          onAddTag();
        }}
      >
        <DropdownMenuItem onSelect={() => actions.setCollapsed([ws.id], !collapsed)}>
          {collapsed ? <ChevronsUpDown aria-hidden /> : <ChevronsDownUp aria-hidden />}
          {collapsed ? "Expand" : "Collapse to header"}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette aria-hidden />
            Color
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent onClick={stop} onPointerDown={stop}>
            <ColorItems value={data.color} onPick={(c) => actions.setWorkspaceColor([ws.id], c)} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <TagMenuItems
          tags={data.tags}
          onAdd={() => (addTag.current = true)}
          onRemove={(t) => actions.removeTag([ws.id], t)}
        />
        <DropdownMenuSeparator />
        {detached ? (
          <DropdownMenuItem onSelect={() => actions.setDetached(ws.id, false)}>
            <Group aria-hidden />
            Put back in the {groupLabel} box
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={groupMates === 0} onSelect={() => actions.setDetached(ws.id, true)}>
            <Ungroup aria-hidden />
            {groupMates === 0 ? `Only workspace in the ${groupLabel} box` : `Take out of the ${groupLabel} box`}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const WorkspaceLabelNode = memo(({ data }: NodeProps) => {
  const { workspace: ws, detached, groupLabel, collapsed } = data as WorkspaceData;
  return (
    <div className="ws-label-float">
      <span className="ws-number">{ws.number}</span> {detached && <span className="ws-label-repo">{groupLabel} / </span>}
      {ws.label}
      <DoneMarker workspace={ws} />
      {collapsed && <StatusCounts workspace={ws} />}
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
  const starred = useStarsContext().isStarred(pane.id);
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
        {starred && <Star className="agent-star" aria-label="Starred" />}
        <span className="agent-name">{agent.name ?? kind}</span>
        {agent.name && <span className="agent-kind">{kind}</span>}
      </div>
      <div className="agent-status">
        <span className="agent-dot" />
        {agent.status} · {agentAge(agent, now)}
        {agent.usage && <UsageMeter usage={agent.usage} />}
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Viewport,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { useDefaultLayout } from "react-resizable-panels";
import { Maximize, Minus, Plus, StickyNote, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { layoutFleet, type PaneData, type TabData, type WorkspaceData } from "./layout.ts";
import { NowContext, nodeTypes } from "./nodes.tsx";
import { Sidebar } from "./Sidebar.tsx";
import {
  indexPanes,
  paneTarget,
  requestFocus,
  safeStorage,
  useHiddenStatuses,
  useNow,
  usePersistedFlag,
  useServerState,
  workspaceMatches,
  type FocusTarget,
  type Located,
} from "./state.ts";
import { Toolbar } from "./Toolbar.tsx";
import { useAgentAlerts, useAlertSettings } from "./alerts.ts";
import { needsYou } from "./attention.tsx";
import { agentNames } from "./rename.tsx";
import { StarsProvider, starredAgents, useStarsContext, useStarShortcuts } from "./stars.tsx";
import { FOCUS_REPLY_EVENT } from "./ReplyBox.tsx";
import { useBoxSelect } from "./hooks/useBoxSelect.ts";
import { useLayoutDrag, useSavedLayout } from "./hooks/useLayoutDrag.ts";
import { useMeta } from "./hooks/useMeta.ts";
import { useLayoutUndo } from "./hooks/useUndo.ts";
import type { TintColor } from "../shared/organize.ts";
import { WorkspaceActions } from "./workspace-actions.ts";
import { useSelection } from "./hooks/useSelection.ts";
import { useShortcut } from "./hooks/useShortcut.ts";
import { useSpatialNav } from "./hooks/useSpatialNav.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { NoteActionsProvider, NoteNode, useNotes } from "./notes.tsx";
import { BulkBar } from "./BulkBar.tsx";
import { AutomationProvider, NEW_SCHEDULE_EVENT, OPEN_QUEUE_EVENT, useAutomationState } from "./automation.tsx";
import { linkEdges, linkEdgeTypes, useLinking } from "./links.tsx";
import { SubagentViewContext, useSubagentView } from "./subagents.tsx";

const canvasNodeTypes = { ...nodeTypes, note: NoteNode };

function zoomClass(zoom: number) {
  if (zoom < 0.35) return "zoom-far";
  if (zoom < 0.7) return "zoom-mid";
  return "zoom-near";
}

function minimapClass(node: Node): string {
  if (node.type === "ws-label") return "mm-hidden";
  if (node.type !== "pane") return "mm-container";
  const status = (node.data as PaneData).pane.agent?.status;
  return status ? `mm-pane status-${status}` : "mm-pane tool";
}

function FleetMap() {
  const [{ fleet, error }, connected] = useServerState();
  const now = useNow(5000);
  const { resolvedTheme } = useTheme();
  const [agentsOnly, setAgentsOnly] = usePersistedFlag("herdr-map.agents-only", true);
  const [agentPanesOnly, setAgentPanesOnly] = usePersistedFlag("herdr-map.agent-panes-only", true);
  const [hiddenStatuses, toggleStatus] = useHiddenStatuses();
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [saved, setSaved] = useSavedLayout();
  const { meta, patchWorkspaces, patchGroup } = useMeta();
  const tagsOf = useCallback((wsId: string) => meta?.workspaces[wsId]?.tags ?? [], [meta]);
  const [dragging, setDragging] = useState<ReadonlySet<string>>();
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [alerts, setAlerts] = useAlertSettings();
  const fitted = useRef(false);
  const panels = useDefaultLayout({ id: "herdr-map.panels", storage: safeStorage });

  const panes = useMemo(() => indexPanes(fleet), [fleet]);
  const layout = useMemo(
    () =>
      fleet && saved && meta
        ? layoutFleet(
            fleet,
            { agentsOnly, agentPanesOnly, hiddenStatuses, dragging, workspaceMeta: meta.workspaces, groupMeta: meta.groups },
            saved,
          )
        : { nodes: [], edges: [] },
    [fleet, agentsOnly, agentPanesOnly, hiddenStatuses, dragging, saved, meta],
  );

  const nodes = useMemo(() => {
    const q = query.trim();
    if (!q || !fleet) return layout.nodes;
    const matching = new Set(
      fleet.groups.flatMap((g) => g.workspaces.filter((ws) => workspaceMatches(ws, q, tagsOf(ws.id))).map((ws) => ws.id)),
    );
    return layout.nodes.map((n): Node => {
      const wsId =
        n.type === "workspace" || n.type === "ws-label"
          ? (n.data as WorkspaceData).workspace.id
          : n.type === "tab"
            ? (n.data as TabData).workspaceId
            : n.type === "pane"
              ? panes.get(n.id)?.workspace.id
              : undefined;
      return wsId && !matching.has(wsId) ? { ...n, className: [n.className, "dim"].filter(Boolean).join(" ") } : n;
    });
  }, [layout, query, fleet, panes, tagsOf]);

  const { hovered, setHovered, pinned, setPinned, select, clear, pinnedPane, detailPane, shownNodes } = useSelection(
    panes,
    nodes,
  );
  const boxSelect = useBoxSelect(shownNodes);
  const { onNodeDragStart, onNodesChange, onNodeDragStop, currentPositions, applyLayout, setDetached } = useLayoutDrag(
    layout.nodes,
    saved,
    setSaved,
    boxSelect.selected,
    setDragging,
  );
  const workspaceActions = useMemo(
    () => ({
      setDetached,
      setCollapsed: (ids: string[], collapsed: boolean) => void patchWorkspaces({ ids, collapsed }),
      setWorkspaceColor: (ids: string[], color: TintColor | null) => void patchWorkspaces({ ids, color }),
      setGroupColor: (groupKey: string, color: TintColor | null) => void patchGroup({ key: groupKey, color }),
      addTag: (ids: string[], tag: string) => void patchWorkspaces({ ids, addTags: [tag] }),
      removeTag: (ids: string[], tag: string) => void patchWorkspaces({ ids, removeTags: [tag] }),
    }),
    [setDetached, patchWorkspaces, patchGroup],
  );

  // Applies to the workspaces on the map, so hidden ones keep their own state.
  const collapseAll = useCallback(
    (collapsed: boolean) => {
      const ids = layout.nodes.filter((n) => n.type === "workspace").map((n) => (n.data as WorkspaceData).workspace.id);
      if (ids.length) void patchWorkspaces({ ids, collapsed });
    },
    [layout.nodes, patchWorkspaces],
  );

  const notes = useNotes();
  const { lastDeletedAt, undoDelete } = notes;
  useLayoutUndo(setSaved, useMemo(() => ({ lastDeletedAt, undoDelete }), [lastDeletedAt, undoDelete]));
  const flowHandlers = notes.withNotes({ onNodesChange, onNodeDragStart, onNodeDragStop });
  const subagentView = useSubagentView(pinned, select);
  const flowNodes = useMemo(() => [...boxSelect.nodes, ...notes.nodes], [boxSelect.nodes, notes.nodes]);

  const automation = useAutomationState();
  const automationValue = useMemo(
    () => ({ state: automation.state, actions: automation.actions, panes }),
    [automation.state, automation.actions, panes],
  );
  const linking = useLinking(panes, automation.actions);
  const flowEdges = useMemo(
    () => [...layout.edges, ...linkEdges(automation.state?.links, new Set(flowNodes.map((n) => n.id)))],
    [layout.edges, automation.state?.links, flowNodes],
  );

  const layoutMenu = { currentPositions, isCustom: !!saved && Object.keys(saved).length > 0, onApply: applyLayout };

  useEffect(() => {
    if (!fitted.current && layout.nodes.length > 0) {
      fitted.current = true;
      requestAnimationFrame(() => fitView({ padding: 0.05 }));
    }
  }, [layout, fitView]);

  const focus = useCallback(async (target: FocusTarget) => {
    try {
      await requestFocus(target);
    } catch (err) {
      toast.error("Couldn't focus in herdr", { description: (err as Error).message });
    }
  }, []);

  const focusPane = useCallback((l: Located) => void focus(paneTarget(l.pane, l.tabId)), [focus]);

  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      // Option-click pins a pane's preview without leaving the map.
      if (node.type === "pane" && event.altKey) {
        setPinned((p) => (p === node.id ? undefined : node.id));
        return;
      }
      if (node.type === "pane") {
        const loc = panes.get(node.id);
        if (loc) focusPane(loc);
      } else if (node.type === "tab") void focus({ kind: "tab", id: (node.data as TabData).tab.id });
      else if (node.type === "workspace") void focus({ kind: "workspace", id: (node.data as WorkspaceData).workspace.id });
    },
    [panes, focus, focusPane],
  );

  const attention = useMemo(() => needsYou(panes), [panes]);
  const stars = useStarsContext();
  const starred = useMemo(() => starredAgents(panes, stars.ids), [panes, stars.ids]);
  const names = useMemo(() => agentNames(panes), [panes]);

  const onSearchEnter = () => {
    const q = query.trim();
    if (!q) return;
    const hit = [...panes.values()].find((l) => l.pane.agent && workspaceMatches(l.workspace, q, tagsOf(l.workspace.id)));
    if (hit) focusPane(hit);
  };

  useAgentAlerts(panes, alerts, select);

  useEffect(() => {
    document.title = attention.length ? `(${attention.length}) herdr-map` : "herdr-map";
  }, [attention.length]);

  // n / shift+n cycle through Needs you, o or Enter opens the selection in the terminal,
  // r moves to the reply box, and Esc clears the selection.
  const cycle = (step: 1 | -1) => {
    const i = attention.findIndex((l) => l.pane.id === pinned);
    const next = step < 0 ? (i <= 0 ? attention.length - 1 : i - 1) : (i + 1) % attention.length;
    select(attention[next].pane.id);
  };
  const hasAttention = attention.length > 0;
  useShortcut({ key: "n", description: "Next in Needs you", enabled: hasAttention }, () => cycle(1));
  useShortcut({ key: "N", description: "Previous in Needs you", enabled: hasAttention }, () => cycle(-1));
  const open = () => {
    if (pinnedPane) focusPane(pinnedPane);
  };
  useShortcut({ key: "o", description: "Open selection in terminal", enabled: !!pinnedPane }, open);
  useShortcut({ key: "Enter", description: "Open selection in terminal", enabled: !!pinnedPane }, open);
  useShortcut({ key: "r", description: "Reply to selected agent", enabled: !!pinnedPane?.pane.agent }, () =>
    window.dispatchEvent(new Event(FOCUS_REPLY_EVENT)),
  );
  useShortcut({ key: "Escape", description: "Clear selection", enabled: !!(pinned || hovered) }, clear);
  useSpatialNav(shownNodes, pinned, select);
  useStarShortcuts(stars, starred, pinnedPane, select);

  return (
    <NowContext.Provider value={now}>
      <WorkspaceActions.Provider value={workspaceActions}>
      <NoteActionsProvider value={notes.actions}>
      <AutomationProvider value={automationValue}>
      <SubagentViewContext.Provider value={subagentView}>
      <div className="flex h-full flex-col">
        <Toolbar
          fleet={fleet}
          connected={connected}
          error={error}
          hiddenStatuses={hiddenStatuses}
          onToggleStatus={toggleStatus}
          query={query}
          onQuery={setQuery}
          onSearchEnter={onSearchEnter}
          agentsOnly={agentsOnly}
          onAgentsOnly={setAgentsOnly}
          agentPanesOnly={agentPanesOnly}
          onAgentPanesOnly={setAgentPanesOnly}
          onCollapseAll={collapseAll}
          layoutMenu={layoutMenu}
          alerts={alerts}
          onAlerts={setAlerts}
          now={now}
        />
        <CommandPalette
          fleet={fleet}
          tagsOf={tagsOf}
          onSelect={select}
          onOpen={focusPane}
          onFocus={(target) => void focus(target)}
          agentsOnly={agentsOnly}
          onAgentsOnly={setAgentsOnly}
          agentPanesOnly={agentPanesOnly}
          onAgentPanesOnly={setAgentPanesOnly}
          layoutMenu={layoutMenu}
          extraCommands={[
            { value: "note:new", label: "New note", run: notes.createInView },
            { value: "workspaces:collapse-all", label: "Collapse all workspaces", run: () => collapseAll(true) },
            { value: "workspaces:expand-all", label: "Expand all workspaces", run: () => collapseAll(false) },
            automation.state?.paused
              ? { value: "automation:resume", label: "Resume automation", run: () => void automation.actions.setPaused(false) }
              : { value: "automation:pause", label: "Pause automation", run: () => void automation.actions.setPaused(true) },
            { value: "automation:queue", label: "Show the queue", run: () => window.dispatchEvent(new Event(OPEN_QUEUE_EVENT)) },
            {
              value: "automation:schedule",
              label: "Schedule a prompt for the selected agent",
              disabled: !pinnedPane?.pane.agent,
              run: () => window.dispatchEvent(new Event(NEW_SCHEDULE_EVENT)),
            },
          ]}
        />
        {error && (
          <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
            <TriangleAlert />
            <AlertTitle>Can't read herdr</AlertTitle>
            <AlertDescription className="font-mono text-xs">{error}</AlertDescription>
          </Alert>
        )}
        <ResizablePanelGroup className="min-h-0 flex-1" {...panels}>
          <ResizablePanel id="canvas" minSize="30">
            <main
              className={`canvas h-full ${zoomClass(zoom)}${linking.linking ? " linking" : ""}`}
              style={{ "--z": zoom } as React.CSSProperties}
              onMouseDownCapture={boxSelect.onMouseDownCapture}
              onDoubleClick={notes.onCanvasDoubleClick}
            >
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={canvasNodeTypes}
                edgeTypes={linkEdgeTypes}
                {...linking.connectProps}
                elementsSelectable={false}
                onNodesChange={flowHandlers.onNodesChange}
                onNodeDragStart={flowHandlers.onNodeDragStart}
                onNodeDragStop={flowHandlers.onNodeDragStop}
                zoomOnDoubleClick={false}
                onNodeClick={onNodeClick}
                onPaneClick={boxSelect.onPaneClick}
                onNodeMouseEnter={(_, n) => n.type === "pane" && setHovered(n.id)}
                onMove={(_, viewport: Viewport) => setZoom(viewport.zoom)}
                minZoom={0.05}
                maxZoom={2.5}
                colorMode={resolvedTheme === "dark" ? "dark" : "light"}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
                <Panel position="top-center">
                  <BulkBar nodes={layout.nodes} selected={boxSelect.selected} onClear={boxSelect.clear} />
                </Panel>
                <Panel position="bottom-left" className="flex flex-col gap-1">
                  <CanvasButton label="Zoom in" onClick={() => zoomIn()}>
                    <Plus />
                  </CanvasButton>
                  <CanvasButton label="Zoom out" onClick={() => zoomOut()}>
                    <Minus />
                  </CanvasButton>
                  <CanvasButton label="Fit everything" onClick={() => fitView({ padding: 0.05, duration: 300 })}>
                    <Maximize />
                  </CanvasButton>
                  <CanvasButton label="New note" onClick={notes.createInView}>
                    <StickyNote />
                  </CanvasButton>
                </Panel>
                <MiniMap pannable zoomable nodeClassName={minimapClass} className="overflow-hidden rounded-lg border shadow-sm" />
              </ReactFlow>
              {linking.chooser}
              {boxSelect.box && (
                <div
                  className="select-box"
                  style={{ left: boxSelect.box.x, top: boxSelect.box.y, width: boxSelect.box.w, height: boxSelect.box.h }}
                />
              )}
            </main>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="sidebar" defaultSize="26" minSize="18" maxSize="60">
            <Sidebar
              attention={attention}
              starred={starred}
              agentNames={names}
              detail={detailPane}
              pinned={!!pinnedPane && detailPane === pinnedPane}
              selectedId={pinned}
              now={now}
              onFocus={focusPane}
              onHover={setHovered}
              onSelect={select}
              onPin={setPinned}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      </SubagentViewContext.Provider>
      </AutomationProvider>
      </NoteActionsProvider>
      </WorkspaceActions.Provider>
    </NowContext.Provider>
  );
}

function CanvasButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" className="size-8 bg-card shadow-sm" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <StarsProvider>
        <FleetMap />
      </StarsProvider>
    </ReactFlowProvider>
  );
}

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
import { Maximize, Minus, Plus, TriangleAlert } from "lucide-react";
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
import { useSelection } from "./hooks/useSelection.ts";
import { useShortcut } from "./hooks/useShortcut.ts";
import { useSpatialNav } from "./hooks/useSpatialNav.ts";
import { CommandPalette } from "./CommandPalette.tsx";

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
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [alerts, setAlerts] = useAlertSettings();
  const fitted = useRef(false);
  const panels = useDefaultLayout({ id: "herdr-map.panels", storage: safeStorage });

  const panes = useMemo(() => indexPanes(fleet), [fleet]);
  const layout = useMemo(
    () =>
      fleet && saved ? layoutFleet(fleet, { agentsOnly, agentPanesOnly, hiddenStatuses }, saved) : { nodes: [], edges: [] },
    [fleet, agentsOnly, agentPanesOnly, hiddenStatuses, saved],
  );

  const nodes = useMemo(() => {
    const q = query.trim();
    if (!q || !fleet) return layout.nodes;
    const matching = new Set(
      fleet.groups.flatMap((g) => g.workspaces.filter((ws) => workspaceMatches(ws, q)).map((ws) => ws.id)),
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
  }, [layout, query, fleet, panes]);

  const { hovered, setHovered, pinned, setPinned, select, clear, pinnedPane, detailPane, shownNodes } = useSelection(
    panes,
    nodes,
  );
  const boxSelect = useBoxSelect(shownNodes);
  const { onNodeDragStart, onNodesChange, onNodeDragStop, currentPositions, applyLayout } = useLayoutDrag(
    layout.nodes,
    saved,
    setSaved,
    boxSelect.selected,
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
    const hit = [...panes.values()].find((l) => l.pane.agent && workspaceMatches(l.workspace, q));
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
          layoutMenu={layoutMenu}
          alerts={alerts}
          onAlerts={setAlerts}
        />
        <CommandPalette
          fleet={fleet}
          onSelect={select}
          onOpen={focusPane}
          onFocus={(target) => void focus(target)}
          agentsOnly={agentsOnly}
          onAgentsOnly={setAgentsOnly}
          agentPanesOnly={agentPanesOnly}
          onAgentPanesOnly={setAgentPanesOnly}
          layoutMenu={layoutMenu}
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
              className={`canvas h-full ${zoomClass(zoom)}`}
              style={{ "--z": zoom } as React.CSSProperties}
              onMouseDownCapture={boxSelect.onMouseDownCapture}
            >
              <ReactFlow
                nodes={boxSelect.nodes}
                edges={layout.edges}
                nodeTypes={nodeTypes}
                nodesConnectable={false}
                elementsSelectable={false}
                onNodesChange={onNodesChange}
                onNodeDragStart={onNodeDragStart}
                onNodeDragStop={onNodeDragStop}
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
                </Panel>
                <MiniMap pannable zoomable nodeClassName={minimapClass} className="overflow-hidden rounded-lg border shadow-sm" />
              </ReactFlow>
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

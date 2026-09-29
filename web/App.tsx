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
  type NodeChange,
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
import {
  isDetachedDrop,
  layoutFleet,
  type GroupData,
  type PaneData,
  type Rect,
  type SavedLayout,
  type TabData,
  type WorkspaceData,
} from "./layout.ts";
import { NowContext, nodeTypes } from "./nodes.tsx";
import { Sidebar } from "./Sidebar.tsx";
import {
  indexPanes,
  paneTarget,
  putLayout,
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
import { FOCUS_REPLY_EVENT } from "./ReplyBox.tsx";

function zoomClass(zoom: number) {
  if (zoom < 0.35) return "zoom-far";
  if (zoom < 0.7) return "zoom-mid";
  return "zoom-near";
}

function nodeRect(n: Node): Rect {
  return { x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 };
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
  const [hovered, setHovered] = useState<string>();
  const [pinned, setPinned] = useState<string>();
  const [saved, setSaved] = useState<SavedLayout>();
  // Bumped after a drag or reset; the effect below writes the settled layout.
  const [saveTick, setSaveTick] = useState(0);
  const { fitView, zoomIn, zoomOut, getInternalNode, getZoom, setCenter } = useReactFlow();
  const [alerts, setAlerts] = useAlertSettings();
  const fitted = useRef(false);
  const panels = useDefaultLayout({ id: "herdr-map.panels", storage: safeStorage });

  useEffect(() => {
    fetch("/api/layout")
      .then((res) => res.json())
      .then((layout: SavedLayout) => setSaved(layout))
      .catch(() => setSaved({}));
  }, []);

  useEffect(() => {
    if (saveTick > 0 && saved) void putLayout(saved);
    // Only a new tick should trigger a write, not every drag frame.
  }, [saveTick]);

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

  // Dragging a workspace moves it; dragging a group box moves its attached workspaces.
  // The first drag freezes the automatic layout by saving every current position.
  // Group drags apply offsets from the drag start, so repeated change events can't compound.
  const groupDrag = useRef<{ id: string; origin: { x: number; y: number }; members: SavedLayout }>(undefined);

  const onNodeDragStart = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== "group-box") return;
      const members: SavedLayout = {};
      for (const n of layout.nodes) {
        if (n.type !== "workspace") continue;
        const id = (n.data as WorkspaceData).workspace.id;
        if ((node.data as GroupData).memberIds.includes(id)) members[id] = { ...n.position, detached: false };
      }
      groupDrag.current = { id: node.id, origin: { ...node.position }, members };
    },
    [layout.nodes],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const moves = changes.filter((c) => c.type === "position" && c.position);
      if (moves.length === 0) return;
      setSaved((prev) => {
        const next: SavedLayout = { ...prev };
        const byId = new Map(layout.nodes.map((n) => [n.id, n]));
        if (Object.keys(next).length === 0) {
          for (const n of layout.nodes) {
            if (n.type === "workspace") next[(n.data as WorkspaceData).workspace.id] = { ...n.position };
          }
        }
        for (const change of moves) {
          if (change.type !== "position" || !change.position) continue;
          const node = byId.get(change.id);
          if (!node) continue;
          if (node.type === "workspace") {
            const id = (node.data as WorkspaceData).workspace.id;
            next[id] = { ...change.position, detached: next[id]?.detached };
          } else if (node.type === "group-box" && groupDrag.current?.id === node.id) {
            const { origin, members } = groupDrag.current;
            const dx = change.position.x - origin.x;
            const dy = change.position.y - origin.y;
            for (const [id, p] of Object.entries(members)) next[id] = { x: p.x + dx, y: p.y + dy };
          }
        }
        return next;
      });
    },
    [layout.nodes],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      setSaved((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        if (node.type === "workspace") {
          const data = node.data as WorkspaceData;
          const others = layout.nodes.filter(
            (n) =>
              n.type === "workspace" &&
              n.id !== node.id &&
              (n.data as WorkspaceData).groupKey === data.groupKey &&
              !(n.data as WorkspaceData).detached,
          );
          const detached = isDetachedDrop(nodeRect(node), others.map(nodeRect));
          next[data.workspace.id] = { ...node.position, detached };
        }
        return next;
      });
      groupDrag.current = undefined;
      setSaveTick((t) => t + 1);
    },
    [layout.nodes],
  );

  // Saved positions for hidden workspaces are kept alongside the ones on screen.
  const currentPositions = useCallback((): SavedLayout => {
    const out: SavedLayout = { ...saved };
    for (const n of layout.nodes) {
      if (n.type !== "workspace") continue;
      const data = n.data as WorkspaceData;
      out[data.workspace.id] = { ...n.position, detached: data.detached || undefined };
    }
    return out;
  }, [saved, layout.nodes]);

  const applyLayout = useCallback(
    (next: SavedLayout) => {
      setSaved(next);
      setSaveTick((t) => t + 1);
      requestAnimationFrame(() => fitView({ padding: 0.05 }));
    },
    [fitView],
  );

  const attention = useMemo(
    () =>
      [...panes.values()]
        .filter((l) => l.pane.agent && (l.pane.agent.status === "blocked" || l.pane.agent.status === "done"))
        .sort((a, b) => {
          // Blocked agents first, then the longest-waiting.
          const rank = (l: Located) => (l.pane.agent!.status === "blocked" ? 0 : 1);
          return rank(a) - rank(b) || a.pane.agent!.since - b.pane.agent!.since;
        }),
    [panes],
  );

  const onSearchEnter = () => {
    const q = query.trim();
    if (!q) return;
    const hit = [...panes.values()].find((l) => l.pane.agent && workspaceMatches(l.workspace, q));
    if (hit) focusPane(hit);
  };

  // A pinned pane holds the preview until unpinned or closed; otherwise it follows the pointer.
  const pinnedPane = pinned ? panes.get(pinned) : undefined;
  const detailPane = pinnedPane ?? (hovered ? panes.get(hovered) : undefined);

  // Selecting an agent pins its preview and pans the map to it, zooming in only when
  // it would be too small to read.
  const select = useCallback(
    (paneId: string) => {
      setPinned(paneId);
      const node = getInternalNode(paneId);
      if (!node) return;
      const { x, y } = node.internals.positionAbsolute;
      setCenter(x + (node.width ?? 0) / 2, y + (node.height ?? 0) / 2, {
        zoom: Math.max(getZoom(), 0.9),
        duration: 350,
      });
    },
    [getInternalNode, getZoom, setCenter],
  );

  useAgentAlerts(panes, alerts, select);

  // Outline the selected agent so it's easy to find after the map pans to it.
  const shownNodes = useMemo(
    () =>
      pinned
        ? nodes.map((n) => (n.id === pinned ? { ...n, className: [n.className, "selected-pane"].filter(Boolean).join(" ") } : n))
        : nodes,
    [nodes, pinned],
  );

  useEffect(() => {
    document.title = attention.length ? `(${attention.length}) herdr-map` : "herdr-map";
  }, [attention.length]);

  // n / shift+n cycle through Needs you, o or Enter opens the selection in the terminal,
  // r moves to the reply box, and Esc clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (target.closest("input, textarea, select, [contenteditable], [role=menu]")) return;
      const k = e.key;
      if (k === "n" || k === "N") {
        if (attention.length === 0) return;
        const i = attention.findIndex((l) => l.pane.id === pinned);
        const next = k === "N" ? (i <= 0 ? attention.length - 1 : i - 1) : (i + 1) % attention.length;
        select(attention[next].pane.id);
      } else if ((k === "o" || k === "Enter") && pinnedPane) {
        focusPane(pinnedPane);
      } else if (k === "r" && pinnedPane?.pane.agent) {
        window.dispatchEvent(new Event(FOCUS_REPLY_EVENT));
      } else if (k === "Escape" && (pinned || hovered)) {
        setPinned(undefined);
        setHovered(undefined);
      } else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [attention, pinned, hovered, pinnedPane, select, focusPane]);

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
          layoutMenu={{ currentPositions, isCustom: !!saved && Object.keys(saved).length > 0, onApply: applyLayout }}
          alerts={alerts}
          onAlerts={setAlerts}
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
            <main className={`canvas h-full ${zoomClass(zoom)}`} style={{ "--z": zoom } as React.CSSProperties}>
              <ReactFlow
                nodes={shownNodes}
                edges={layout.edges}
                nodeTypes={nodeTypes}
                nodesConnectable={false}
                elementsSelectable={false}
                onNodesChange={onNodesChange}
                onNodeDragStart={onNodeDragStart}
                onNodeDragStop={onNodeDragStop}
                onNodeClick={onNodeClick}
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
            </main>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="sidebar" defaultSize="26" minSize="18" maxSize="60">
            <Sidebar
              attention={attention}
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
      <FleetMap />
    </ReactFlowProvider>
  );
}

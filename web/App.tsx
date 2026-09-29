import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import { STATUSES, type Fleet, type FleetPane, type FleetWorkspace } from "../shared/model.ts";
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
import { LayoutMenu } from "./LayoutMenu.tsx";
import { PaneDetail, type Located } from "./PaneDetail.tsx";
import { NowContext, agentAge, nodeTypes } from "./nodes.tsx";

interface ServerState {
  fleet?: Fleet;
  error?: string;
}

type FocusTarget = { kind: "agent" | "tab" | "workspace"; id: string };

async function requestFocus(target: FocusTarget) {
  const res = await fetch("/api/focus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
}

function paneTarget(pane: FleetPane, tabId: string): FocusTarget {
  // herdr can focus an agent by pane ID; other panes are reached through their tab.
  return pane.agent ? { kind: "agent", id: pane.id } : { kind: "tab", id: tabId };
}

function useServerState(): [ServerState, boolean] {
  const [state, setState] = useState<ServerState>({});
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => setState(JSON.parse(event.data));
    return () => source.close();
  }, []);
  return [state, connected];
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function workspaceMatches(ws: FleetWorkspace, query: string): boolean {
  const q = query.toLowerCase();
  if (ws.label.toLowerCase().includes(q)) return true;
  return ws.tabs.some(
    (t) =>
      t.label.toLowerCase().includes(q) ||
      t.panes.some(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.agent?.name?.toLowerCase().includes(q) ||
          p.agent?.summary?.toLowerCase().includes(q),
      ),
  );
}


function indexPanes(fleet: Fleet | undefined): Map<string, Located> {
  const out = new Map<string, Located>();
  for (const g of fleet?.groups ?? [])
    for (const ws of g.workspaces)
      for (const tab of ws.tabs)
        for (const pane of tab.panes) out.set(pane.id, { pane, tabId: tab.id, tabLabel: tab.label, workspace: ws });
  return out;
}

function zoomClass(zoom: number) {
  if (zoom < 0.35) return "zoom-far";
  if (zoom < 0.7) return "zoom-mid";
  return "zoom-near";
}

/** A boolean view setting remembered per browser. */
function usePersistedFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === "true" || saved === "false") return saved === "true";
    } catch {}
    return initial;
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      try {
        localStorage.setItem(key, String(v));
      } catch {}
    },
    [key],
  );
  return [value, set];
}

const SIDEBAR_MIN = 260;
const SIDEBAR_KEY = "herdr-map.sidebar-width";

/** Sidebar width, adjustable by dragging its left edge and remembered per browser. */
function useSidebarWidth(): [number, (e: React.PointerEvent) => void] {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(SIDEBAR_KEY));
      if (saved >= SIDEBAR_MIN) return saved;
    } catch {}
    return 380;
  });
  const start = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    let last = 0;
    const move = (ev: PointerEvent) => {
      last = Math.round(Math.min(window.innerWidth * 0.8, Math.max(SIDEBAR_MIN, window.innerWidth - ev.clientX)));
      setWidth(last);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      try {
        if (last) localStorage.setItem(SIDEBAR_KEY, String(last));
      } catch {}
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }, []);
  return [width, start];
}

type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem("herdr-map.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "system";
}

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("herdr-map.theme", theme);
    } catch {}
  }, [theme]);
  return [theme, setTheme];
}

async function putLayout(layout: SavedLayout) {
  await fetch("/api/layout", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(layout),
  });
}

function nodeRect(n: Node): Rect {
  return { x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 };
}

function FleetMap() {
  const [{ fleet, error }, connected] = useServerState();
  const now = useNow(5000);
  const [agentsOnly, setAgentsOnly] = usePersistedFlag("herdr-map.agents-only", true);
  const [agentPanesOnly, setAgentPanesOnly] = usePersistedFlag("herdr-map.agent-panes-only", true);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<string>();
  const [pinned, setPinned] = useState<string>();
  const [sidebarW, startResize] = useSidebarWidth();
  const [focusError, setFocusError] = useState<string>();
  const [theme, setTheme] = useTheme();
  const [saved, setSaved] = useState<SavedLayout>();
  // Bumped after a drag or reset; the effect below writes the settled layout.
  const [saveTick, setSaveTick] = useState(0);
  const { fitView } = useReactFlow();
  const fitted = useRef(false);

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
    () => (fleet && saved ? layoutFleet(fleet, { agentsOnly, agentPanesOnly }, saved) : { nodes: [], edges: [] }),
    [fleet, agentsOnly, agentPanesOnly, saved],
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
      return wsId && !matching.has(wsId) ? { ...n, className: "dim" } : n;
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
      setFocusError(undefined);
      await requestFocus(target);
    } catch (err) {
      setFocusError((err as Error).message);
    }
  }, []);

  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      // Option-click pins a pane's preview without leaving the map.
      if (node.type === "pane" && event.altKey) {
        setPinned((p) => (p === node.id ? undefined : node.id));
        return;
      }
      if (node.type === "pane") {
        const loc = panes.get(node.id);
        if (loc) void focus(paneTarget(loc.pane, loc.tabId));
      } else if (node.type === "tab") void focus({ kind: "tab", id: (node.data as TabData).tab.id });
      else if (node.type === "workspace") void focus({ kind: "workspace", id: (node.data as WorkspaceData).workspace.id });
    },
    [panes, focus],
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

  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || !query.trim()) return;
    const hit = [...panes.values()].find((l) => l.pane.agent && workspaceMatches(l.workspace, query.trim()));
    if (hit) void focus(paneTarget(hit.pane, hit.tabId));
  };

  // A pinned pane holds the preview until unpinned or closed; otherwise it follows the pointer.
  const pinnedPane = pinned ? panes.get(pinned) : undefined;
  const detailPane = pinnedPane ?? (hovered ? panes.get(hovered) : undefined);

  return (
    <NowContext.Provider value={now}>
      <div className="app" style={{ "--sidebar-w": `${sidebarW}px` } as React.CSSProperties}>
        <header className="toolbar">
          <strong>herdr-map</strong>
          <div className="counts">
            {STATUSES.filter((s) => fleet?.counts[s]).map((s) => (
              <span key={s} className={`chip status-${s}`}>
                {fleet!.counts[s]} {s}
              </span>
            ))}
          </div>
          <input
            className="search"
            placeholder="Filter workspaces, agents, summaries (Enter focuses first match)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <label className="toggle">
            <input type="checkbox" checked={agentsOnly} onChange={(e) => setAgentsOnly(e.target.checked)} />
            Workspaces with agents only
          </label>
          <label className="toggle">
            <input type="checkbox" checked={agentPanesOnly} onChange={(e) => setAgentPanesOnly(e.target.checked)} />
            Agent panes only
          </label>
          <LayoutMenu
            currentPositions={currentPositions}
            isCustom={!!saved && Object.keys(saved).length > 0}
            onApply={applyLayout}
            onError={setFocusError}
          />
          <select className="theme" value={theme} onChange={(e) => setTheme(e.target.value as Theme)} aria-label="Theme">
            <option value="system">System theme</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <span className={`conn ${connected && !error ? "ok" : "bad"}`}>
            {!connected ? "disconnected" : error ? "herdr error" : `herdr ${fleet?.version ?? ""}`}
          </span>
        </header>
        {(error || focusError) && <div className="banner">{focusError ?? error}</div>}
        <main className={`canvas ${zoomClass(zoom)}`} style={{ "--z": zoom } as React.CSSProperties}>
          <ReactFlow
            nodes={nodes}
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
            colorMode={theme}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={40} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeClassName={minimapClass} />
          </ReactFlow>
        </main>
        <div className="sidebar-resizer" onPointerDown={startResize} title="Drag to resize the sidebar" />
        <aside className="inspector">
          <section>
            <h2>Needs you ({attention.length})</h2>
            {attention.length === 0 && <p className="muted">No blocked or finished agents.</p>}
            <ul className="attention">
              {attention.map((l) => (
                <li key={l.pane.id} onMouseEnter={() => setHovered(l.pane.id)}>
                  <button
                    onClick={(e) =>
                      e.altKey ? setPinned(l.pane.id) : void focus(paneTarget(l.pane, l.tabId))
                    }
                  >
                    <span className={`dot status-${l.pane.agent!.status}`} />
                    <span className="attention-name">
                      {l.pane.agent!.name ?? l.workspace.label} <span className="muted">{l.pane.agent!.kind}</span>
                    </span>
                    <span className="muted">{agentAge(l.pane.agent!, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {detailPane && (
            <PaneDetail
              located={detailPane}
              pinned={detailPane === pinnedPane}
              now={now}
              onOpen={() => void focus(paneTarget(detailPane.pane, detailPane.tabId))}
              onTogglePin={() => setPinned((p) => (p === detailPane.pane.id ? undefined : detailPane.pane.id))}
            />
          )}
        </aside>
      </div>
    </NowContext.Provider>
  );
}

function minimapClass(node: Node): string {
  if (node.type === "ws-label") return "mm-hidden";
  if (node.type !== "pane") return "mm-container";
  const status = (node.data as PaneData).pane.agent?.status;
  return status ? `mm-pane status-${status}` : "mm-pane tool";
}

export function App() {
  return (
    <ReactFlowProvider>
      <FleetMap />
    </ReactFlowProvider>
  );
}

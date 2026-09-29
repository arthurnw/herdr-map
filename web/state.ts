// Server state, focus requests, and per-browser view settings shared by the UI.
import { useCallback, useEffect, useState } from "react";
import { STATUSES, type AgentStatus, type Fleet, type FleetPane, type FleetWorkspace } from "../shared/model.ts";
import type { SavedLayout } from "./layout.ts";

export interface Located {
  pane: FleetPane;
  tabId: string;
  tabLabel: string;
  workspace: FleetWorkspace;
}

export interface ServerState {
  fleet?: Fleet;
  error?: string;
}

export type FocusTarget = { kind: "agent" | "tab" | "workspace"; id: string };

export async function requestFocus(target: FocusTarget) {
  const res = await fetch("/api/focus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
}

export function paneTarget(pane: FleetPane, tabId: string): FocusTarget {
  // herdr can focus an agent by pane ID; other panes are reached through their tab.
  return pane.agent ? { kind: "agent", id: pane.id } : { kind: "tab", id: tabId };
}

export async function putLayout(layout: SavedLayout) {
  await fetch("/api/layout", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(layout),
  });
}

export function useServerState(): [ServerState, boolean] {
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

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function workspaceMatches(ws: FleetWorkspace, query: string, tags: string[] = []): boolean {
  const q = query.toLowerCase();
  if (ws.label.toLowerCase().includes(q) || tags.some((t) => t.includes(q))) return true;
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

export function indexPanes(fleet: Fleet | undefined): Map<string, Located> {
  const out = new Map<string, Located>();
  for (const g of fleet?.groups ?? [])
    for (const ws of g.workspaces)
      for (const tab of ws.tabs)
        for (const pane of tab.panes) out.set(pane.id, { pane, tabId: tab.id, tabLabel: tab.label, workspace: ws });
  return out;
}

/** localStorage that tolerates private windows and blocked storage. */
export const safeStorage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

/** A boolean view setting remembered per browser. */
export function usePersistedFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const saved = safeStorage.getItem(key);
    return saved === "true" || saved === "false" ? saved === "true" : initial;
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      safeStorage.setItem(key, String(v));
    },
    [key],
  );
  return [value, set];
}

/**
 * Agent statuses hidden from the map, remembered per browser. Clicking a status toggles it;
 * Option-clicking shows only that status, or everything again if it was already alone.
 */
export function useHiddenStatuses(): [AgentStatus[], (s: AgentStatus, solo: boolean) => void] {
  const key = "herdr-map.hidden-statuses";
  const [hidden, setHidden] = useState<AgentStatus[]>(() => {
    try {
      const saved = JSON.parse(safeStorage.getItem(key) ?? "[]");
      if (Array.isArray(saved)) return saved.filter((s): s is AgentStatus => STATUSES.includes(s));
    } catch {}
    return [];
  });
  const toggle = useCallback((status: AgentStatus, solo: boolean) => {
    setHidden((prev) => {
      const others = STATUSES.filter((s) => s !== status);
      const isAlone = !prev.includes(status) && others.every((s) => prev.includes(s));
      const next = solo
        ? isAlone
          ? []
          : others
        : prev.includes(status)
          ? prev.filter((s) => s !== status)
          : [...prev, status];
      safeStorage.setItem(key, JSON.stringify(next));
      return next;
    });
  }, []);
  return [hidden, toggle];
}

// Desktop notifications and sounds when an agent starts needing attention.
import { useCallback, useEffect, useRef, useState } from "react";
import { safeStorage, type Located } from "./state.ts";
import { KIND_LABEL } from "./status.tsx";

export interface AlertSettings {
  desktop: boolean;
  sound: boolean;
  onBlocked: boolean;
  onDone: boolean;
  onStuck: boolean;
}

/** What an alert is about. */
export type AlertKind = "blocked" | "done" | "stuck";

const KEY = "herdr-map.alerts";
const DEFAULTS: AlertSettings = { desktop: false, sound: false, onBlocked: true, onDone: true, onStuck: true };

export function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function useAlertSettings(): [AlertSettings, (patch: Partial<AlertSettings>) => void] {
  const [settings, setSettings] = useState<AlertSettings>(() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(safeStorage.getItem(KEY) ?? "{}") };
    } catch {
      return DEFAULTS;
    }
  });
  const update = useCallback((patch: Partial<AlertSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      safeStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [settings, update];
}

let audio: AudioContext | undefined;

/** Two short rising tones for blocked, one tone for done, two falling tones for stuck. */
export function playChime(kind: AlertKind) {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const tones = kind === "blocked" ? [660, 880] : kind === "stuck" ? [880, 587] : [740];
    tones.forEach((freq, i) => {
      const start = audio!.currentTime + i * 0.16;
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      osc.connect(gain).connect(audio!.destination);
      osc.start(start);
      osc.stop(start + 0.15);
    });
  } catch {}
}

const TITLE: Record<AlertKind, (who: string, l: Located) => string> = {
  blocked: (who) => `${who} needs you`,
  done: (who) => `${who} finished`,
  stuck: (who, l) => (l.pane.agent?.stuck?.reason === "rate-limit" ? `${who} is rate limited` : `${who} looks stuck`),
};

export function showNotification(l: Located, kind: AlertKind, onClick: () => void) {
  if (notificationPermission() !== "granted") return;
  const agent = l.pane.agent!;
  const who = agent.name ?? `${KIND_LABEL[agent.kind] ?? agent.kind} in ${l.workspace.label}`;
  const n = new Notification(TITLE[kind](who, l), {
    body: [l.workspace.label, agent.summary].filter(Boolean).join(" · "),
    tag: l.pane.id,
  });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

/** The alert an agent's state calls for, if any. A stuck agent is still `working`. */
function alertKind(l: Located): AlertKind | undefined {
  const agent = l.pane.agent;
  if (agent?.status === "blocked" || agent?.status === "done") return agent.status;
  if (agent?.stuck) return "stuck";
  return undefined;
}

/**
 * Alerts when an agent becomes blocked, finishes, or starts to look stuck. Agents already
 * in those states when the page loads don't alert, and nothing fires while this page has focus.
 */
export function useAgentAlerts(panes: Map<string, Located>, settings: AlertSettings, onActivate: (paneId: string) => void) {
  const previous = useRef<Map<string, AlertKind | undefined>>(undefined);
  useEffect(() => {
    const current = new Map<string, AlertKind | undefined>();
    for (const [id, l] of panes) if (l.pane.agent) current.set(id, alertKind(l));
    const prev = previous.current;
    previous.current = current;
    if (!prev || document.hasFocus()) return;
    for (const [id, kind] of current) {
      if (!prev.has(id) || !kind || prev.get(id) === kind) continue;
      const wanted = { blocked: settings.onBlocked, done: settings.onDone, stuck: settings.onStuck }[kind];
      if (!wanted) continue;
      if (settings.sound) playChime(kind);
      if (settings.desktop) showNotification(panes.get(id)!, kind, () => onActivate(id));
    }
  }, [panes, settings, onActivate]);
}

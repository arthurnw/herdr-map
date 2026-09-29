// Desktop notifications and sounds when an agent starts needing attention.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStatus } from "../shared/model.ts";
import { safeStorage, type Located } from "./state.ts";
import { KIND_LABEL } from "./status.tsx";

export interface AlertSettings {
  desktop: boolean;
  sound: boolean;
  onBlocked: boolean;
  onDone: boolean;
}

const KEY = "herdr-map.alerts";
const DEFAULTS: AlertSettings = { desktop: false, sound: false, onBlocked: true, onDone: true };

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

/** Two short rising tones for blocked, one tone for done. */
export function playChime(status: AgentStatus) {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const tones = status === "blocked" ? [660, 880] : [740];
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

export function showNotification(l: Located, onClick: () => void) {
  if (notificationPermission() !== "granted") return;
  const agent = l.pane.agent!;
  const who = agent.name ?? `${KIND_LABEL[agent.kind] ?? agent.kind} in ${l.workspace.label}`;
  const n = new Notification(agent.status === "blocked" ? `${who} needs you` : `${who} finished`, {
    body: [l.workspace.label, agent.summary].filter(Boolean).join(" · "),
    tag: l.pane.id,
  });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

/**
 * Alerts when an agent moves into blocked or done. Agents already in those states when
 * the page loads don't alert, and nothing fires while this page has focus.
 */
export function useAgentAlerts(panes: Map<string, Located>, settings: AlertSettings, onActivate: (paneId: string) => void) {
  const previous = useRef<Map<string, AgentStatus>>(undefined);
  useEffect(() => {
    const current = new Map<string, AgentStatus>();
    for (const [id, l] of panes) if (l.pane.agent) current.set(id, l.pane.agent.status);
    const prev = previous.current;
    previous.current = current;
    if (!prev || document.hasFocus()) return;
    for (const [id, status] of current) {
      const before = prev.get(id);
      if (before === undefined || before === status) continue;
      const wanted = (status === "blocked" && settings.onBlocked) || (status === "done" && settings.onDone);
      if (!wanted) continue;
      if (settings.sound) playChime(status);
      if (settings.desktop) showNotification(panes.get(id)!, () => onActivate(id));
    }
  }, [panes, settings, onActivate]);
}

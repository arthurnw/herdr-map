// Client side of the prompt queue, links, and schedules: the state the server reports,
// polled while the page is open, and the actions that change it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AutomationState, Schedule, ScheduleTiming } from "../shared/automation.ts";
import type { Endpoint, LinkKind } from "../shared/layout-types.ts";
import type { Located } from "./state.ts";
import { errorMessage } from "../shared/errors.ts";

const POLL_MS = 2000;

type RequestBody =
  | { paused: boolean }
  | { target: string; text: string }
  | { from: Endpoint; to: Endpoint; kind: LinkKind }
  | Partial<ScheduleFields>;

async function call<T = unknown>(method: string, path: string, body?: RequestBody): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  // SAFETY: each caller names the type its route responds with.
  return json as T;
}

export interface ScheduleFields {
  target: string;
  text: string;
  timing: ScheduleTiming;
}

export function useAutomationState() {
  const [state, setState] = useState<AutomationState>();
  const stopped = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await call<AutomationState>("GET", "/api/automation");
      if (!stopped.current) setState(next);
    } catch {}
  }, []);

  useEffect(() => {
    stopped.current = false;
    void refresh();
    const id = setInterval(() => !document.hidden && void refresh(), POLL_MS);
    return () => {
      stopped.current = true;
      clearInterval(id);
    };
  }, [refresh]);

  /** Runs a request, shows its error as a toast, and refreshes. Resolves to the result, or undefined on failure. */
  const run = useCallback(
    async <T,>(failure: string, method: string, path: string, body?: RequestBody): Promise<T | undefined> => {
      try {
        return await call<T>(method, path, body);
      } catch (err) {
        toast.error(failure, { description: errorMessage(err) });
        return undefined;
      } finally {
        void refresh();
      }
    },
    [refresh],
  );

  const actions = useMemo(
    () => ({
      setPaused: (paused: boolean) => run("Couldn't change the pause", "POST", "/api/automation/pause", { paused }),
      cancel: (id: string) => run("Couldn't cancel", "POST", `/api/queue/${encodeURIComponent(id)}/cancel`),
      sendNow: (id: string) => run("Couldn't send", "POST", `/api/queue/${encodeURIComponent(id)}/send-now`),
      retry: (id: string) => run("Couldn't retry", "POST", `/api/queue/${encodeURIComponent(id)}/retry`),
      enqueue: (target: string, text: string) => run("Couldn't queue the prompt", "POST", "/api/queue", { target, text }),
      createLink: (from: Endpoint, to: Endpoint, kind: LinkKind) =>
        run("Couldn't link them", "POST", "/api/links", { from, to, kind }),
      deleteLink: (id: string) => run("Couldn't remove the link", "DELETE", `/api/links/${encodeURIComponent(id)}`),
      resendLink: (id: string) => run("Couldn't send it again", "POST", `/api/links/${encodeURIComponent(id)}/send`),
      createSchedule: (fields: ScheduleFields) => run<Schedule>("Couldn't save the schedule", "POST", "/api/schedules", fields),
      editSchedule: (id: string, fields: Partial<ScheduleFields>) =>
        run<Schedule>("Couldn't save the schedule", "PATCH", `/api/schedules/${encodeURIComponent(id)}`, fields),
      setArmed: (id: string, armed: boolean) =>
        run<Schedule>("Couldn't change the schedule", "POST", `/api/schedules/${encodeURIComponent(id)}/${armed ? "arm" : "disarm"}`),
      deleteSchedule: (id: string) => run("Couldn't delete the schedule", "DELETE", `/api/schedules/${encodeURIComponent(id)}`),
    }),
    [run],
  );

  return { state, actions };
}

export type AutomationActions = ReturnType<typeof useAutomationState>["actions"];

export interface AutomationValue {
  state?: AutomationState;
  actions: AutomationActions;
  panes: Map<string, Located>;
}

const AutomationContext = createContext<AutomationValue | undefined>(undefined);
export const AutomationProvider = AutomationContext.Provider;

export function useAutomation(): AutomationValue | undefined {
  return useContext(AutomationContext);
}

/** "lead (api)" for a pane on the map, or the fallback the server recorded. */
export function agentLabel(panes: Map<string, Located>, paneId: string, fallback?: string): string {
  const l = panes.get(paneId);
  if (!l?.pane.agent) return fallback ?? paneId;
  return `${l.pane.agent.name ?? l.pane.agent.kind} (${l.workspace.label})`;
}

/** Events other parts of the UI send to open automation views. */
export const OPEN_QUEUE_EVENT = "herdr-map:open-queue";
export const NEW_SCHEDULE_EVENT = "herdr-map:new-schedule";

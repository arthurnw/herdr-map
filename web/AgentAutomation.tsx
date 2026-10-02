// The automation block in an agent's preview: its links, its scheduled prompts, and a
// way to queue a prompt for when it's idle.
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronDown, ChevronRight, ListPlus, Pencil, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { describeTiming, PROMPT_TEXT_MAX, type Schedule, type ScheduleTiming } from "../shared/automation.ts";
import { agentLabel, NEW_SCHEDULE_EVENT, useAutomation, type AutomationValue } from "./automation.tsx";
import { describeLink } from "./links.tsx";
import { nextRunText } from "./queue.tsx";
import type { Located } from "./state.ts";

type Unit = "minutes" | "hours" | "daily";

interface Draft {
  text: string;
  unit: Unit;
  every: string;
  time: string;
}

function draftOf(s?: Schedule): Draft {
  if (!s) return { text: "", unit: "hours", every: "1", time: "09:00" };
  if (s.timing.kind === "daily") return { text: s.text, unit: "daily", every: "1", time: s.timing.time };
  const hours = s.timing.minutes % 60 === 0;
  return { text: s.text, unit: hours ? "hours" : "minutes", every: String(hours ? s.timing.minutes / 60 : s.timing.minutes), time: "09:00" };
}

function timingOf(d: Draft): ScheduleTiming | undefined {
  if (d.unit === "daily") return /^\d{2}:\d{2}$/.test(d.time) ? { kind: "daily", time: d.time } : undefined;
  const n = Number(d.every);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return { kind: "interval", minutes: d.unit === "hours" ? n * 60 : n };
}

export function AgentAutomation({ located, now }: { located: Located; now: number }) {
  const auto = useAutomation();
  const paneId = located.pane.id;
  const [open, setOpen] = useState(false);
  // undefined: no form; null: a new schedule; otherwise the schedule being edited.
  const [editing, setEditing] = useState<Schedule | null>();
  const [queueing, setQueueing] = useState(false);

  useEffect(() => {
    setEditing(undefined);
    setQueueing(false);
  }, [paneId]);

  useEffect(() => {
    const onNew = () => {
      setOpen(true);
      setEditing(null);
    };
    window.addEventListener(NEW_SCHEDULE_EVENT, onNew);
    return () => window.removeEventListener(NEW_SCHEDULE_EVENT, onNew);
  }, []);

  const links = useMemo(
    () => (auto?.state?.links ?? []).filter((l) => (l.from.kind === "pane" && l.from.id === paneId) || l.to.id === paneId),
    [auto?.state?.links, paneId],
  );
  const schedules = useMemo(() => (auto?.state?.schedules ?? []).filter((s) => s.target === paneId), [auto?.state?.schedules, paneId]);
  const waiting = (auto?.state?.items ?? []).filter((i) => i.target === paneId).length;
  if (!auto?.state) return null;

  const summary = [
    links.length && `${links.length} link${links.length > 1 ? "s" : ""}`,
    schedules.length && `${schedules.length} schedule${schedules.length > 1 ? "s" : ""}`,
    waiting && `${waiting} queued`,
  ].filter(Boolean);

  return (
    <div className="rounded-lg border text-sm" data-testid="agent-automation">
      <button className="flex w-full items-center gap-1.5 px-3 py-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="font-medium">Automation</span>
        <span className="truncate text-xs text-muted-foreground">{summary.length ? summary.join(" · ") : "Links, schedules, and queued prompts"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t px-3 py-2">
          {links.length > 0 && (
            <ul className="space-y-1" aria-label="Links">
              {links.map((l) => (
                <li key={l.id} className="flex items-start gap-2 text-xs">
                  <Badge variant="outline" className="font-normal">
                    {l.from.kind === "note" ? "note" : l.kind}
                  </Badge>
                  <span className="min-w-0 flex-1">{describeLink(l, auto.panes)}</span>
                  <Button variant="ghost" size="icon-xs" aria-label="Remove link" onClick={() => void auto.actions.deleteLink(l.id)}>
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {schedules.length > 0 && (
            <ul className="space-y-2" aria-label="Schedules">
              {schedules.map((s) => (
                <ScheduleRow key={s.id} schedule={s} auto={auto} now={now} onEdit={() => setEditing(s)} />
              ))}
            </ul>
          )}
          {editing !== undefined ? (
            <ScheduleForm
              key={editing?.id ?? "new"}
              schedule={editing ?? undefined}
              onCancel={() => setEditing(undefined)}
              onSave={async (text, timing) => {
                const saved = editing
                  ? await auto.actions.editSchedule(editing.id, { text, timing })
                  : await auto.actions.createSchedule({ target: paneId, text, timing });
                if (saved) setEditing(undefined);
              }}
            />
          ) : queueing ? (
            <QueueForm
              label={agentLabel(auto.panes, paneId)}
              onCancel={() => setQueueing(false)}
              onQueue={async (text) => {
                if (await auto.actions.enqueue(paneId, text)) setQueueing(false);
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <Button variant="outline" size="xs" onClick={() => setEditing(null)}>
                <CalendarClock />
                Schedule a prompt
              </Button>
              <Button variant="outline" size="xs" onClick={() => setQueueing(true)}>
                <ListPlus />
                Send when idle
              </Button>
            </div>
          )}
          {links.length === 0 && (
            <p className="text-xs text-muted-foreground">Drag from the dot on an agent's card, or a note's, to another agent to link them.</p>
          )}
        </div>
      )}
    </div>
  );
}

function ScheduleRow({ schedule: s, auto, now, onEdit }: { schedule: Schedule; auto: AutomationValue; now: number; onEdit: () => void }) {
  return (
    <li className="rounded-md bg-muted/40 p-2 text-xs" data-testid="schedule">
      <div className="flex items-center gap-2">
        <span className="font-medium">{describeTiming(s.timing)}</span>
        <Badge variant="outline" className={s.armed ? "border-status-done bg-status-done/15 font-normal" : "font-normal"}>
          {s.armed ? "Armed" : "Not armed"}
        </Badge>
        <span className="ml-auto flex gap-0.5">
          <Button variant="ghost" size="icon-xs" aria-label="Edit schedule" onClick={onEdit}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Delete schedule" onClick={() => void auto.actions.deleteSchedule(s.id)}>
            <Trash2 />
          </Button>
        </span>
      </div>
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap">{s.text}</p>
      <p className="mt-1 text-muted-foreground">
        {nextRunText(s, now, !!auto.state?.paused)}
        {s.lastRunAt && ` · last run ${new Date(s.lastRunAt).toLocaleString([], { hour: "2-digit", minute: "2-digit" })}: ${s.lastResult ?? ""}`}
      </p>
      <Button className="mt-1.5" variant={s.armed ? "ghost" : "default"} size="xs" onClick={() => void auto.actions.setArmed(s.id, !s.armed)}>
        {s.armed ? "Disarm" : "Arm"}
      </Button>
    </li>
  );
}

function ScheduleForm({
  schedule,
  onCancel,
  onSave,
}: {
  schedule?: Schedule;
  onCancel: () => void;
  onSave: (text: string, timing: ScheduleTiming) => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(schedule));
  const timing = timingOf(draft);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const valid = !!timing && draft.text.trim().length > 0;
  return (
    <form
      className="space-y-2"
      aria-label={schedule ? "Edit schedule" : "New schedule"}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(draft.text, timing);
      }}
    >
      <Textarea
        autoFocus
        value={draft.text}
        maxLength={PROMPT_TEXT_MAX}
        onChange={(e) => set({ text: e.target.value })}
        placeholder="Prompt to send"
        aria-label="Prompt to send"
        className="min-h-16 text-xs"
      />
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {draft.unit === "daily" ? (
          <>
            <span>Daily at</span>
            <Input type="time" className="h-7 w-28 text-xs" aria-label="Time" value={draft.time} onChange={(e) => set({ time: e.target.value })} />
          </>
        ) : (
          <>
            <span>Every</span>
            <Input
              type="number"
              min={1}
              className="h-7 w-16 text-xs"
              aria-label="Every"
              value={draft.every}
              onChange={(e) => set({ every: e.target.value })}
            />
          </>
        )}
        <select
          className="h-7 rounded-md border bg-background px-1.5 text-xs"
          aria-label="Repeat"
          value={draft.unit}
          // SAFETY: the options below are the only values the select can take.
          onChange={(e) => set({ unit: e.target.value as Unit })}
        >
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="daily">daily</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        {schedule?.armed ? "Saving a change disarms the schedule until you arm it again. " : "A new schedule does nothing until you arm it. "}
        Its prompt waits in the queue until the agent is idle, and runs missed while the service was off are not made up.
      </p>
      <div className="flex gap-1.5">
        <Button type="submit" size="xs" disabled={!valid}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function QueueForm({ label, onCancel, onQueue }: { label: string; onCancel: () => void; onQueue: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="space-y-2"
      aria-label="Send when idle"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onQueue(text);
      }}
    >
      <Textarea
        autoFocus
        value={text}
        maxLength={PROMPT_TEXT_MAX}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Prompt for ${label}`}
        aria-label="Prompt to queue"
        className="min-h-16 text-xs"
      />
      <p className="text-xs text-muted-foreground">Sent once the agent is idle or done.</p>
      <div className="flex gap-1.5">
        <Button type="submit" size="xs" disabled={!text.trim()}>
          Queue
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

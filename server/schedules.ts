// Scheduled prompts. A schedule only runs while armed, only queues its prompt (so it is
// delivered when the agent is idle), and never catches up on runs it missed.
import { randomUUID } from "node:crypto";
import {
  describeTiming,
  MAX_SCHEDULES,
  sameTiming,
  scheduleStep,
  nextRun,
  type Schedule,
  type ScheduleTiming,
} from "../shared/automation.ts";
import { paneLabel, type PaneInfo } from "./agents.ts";
import type { Queue } from "./queue.ts";

export interface ScheduleInput {
  target: string;
  targetLabel: string;
  text: string;
  timing: ScheduleTiming;
}

export function addSchedule(queue: Queue, input: ScheduleInput, now = Date.now()): Schedule | string {
  if (queue.data.schedules.length >= MAX_SCHEDULES) return `at most ${MAX_SCHEDULES} schedules`;
  const schedule: Schedule = { id: randomUUID(), ...input, armed: false, createdAt: now, updatedAt: now };
  queue.data.schedules.push(schedule);
  void queue.save();
  return schedule;
}

const find = (queue: Queue, id: string) => queue.data.schedules.find((s) => s.id === id);

function disarm(queue: Queue, s: Schedule) {
  s.armed = false;
  delete s.nextRunAt;
  // A run queued before the change would send what the user just changed.
  queue.cancelWhere((i) => i.source.scheduleId === s.id && i.state === "pending");
}

/** Applies an edit. Changing the target, text, or timing disarms the schedule until it is armed again. */
export function editSchedule(queue: Queue, id: string, patch: Partial<ScheduleInput>, now = Date.now()): Schedule | undefined {
  const s = find(queue, id);
  if (!s) return undefined;
  const changed =
    (patch.target !== undefined && patch.target !== s.target) ||
    (patch.text !== undefined && patch.text !== s.text) ||
    (patch.timing !== undefined && !sameTiming(patch.timing, s.timing));
  Object.assign(s, patch);
  if (changed) {
    disarm(queue, s);
    s.updatedAt = now;
  }
  void queue.save();
  return s;
}

/** Arms or disarms. Arming counts the first run from now. */
export function setArmed(queue: Queue, id: string, armed: boolean, now = Date.now()): Schedule | undefined {
  const s = find(queue, id);
  if (!s) return undefined;
  if (armed) {
    s.armed = true;
    s.nextRunAt = nextRun(s.timing, now);
  } else disarm(queue, s);
  void queue.save();
  return s;
}

export function removeSchedule(queue: Queue, id: string): boolean {
  const s = find(queue, id);
  if (!s) return false;
  disarm(queue, s);
  queue.data.schedules = queue.data.schedules.filter((x) => x !== s);
  void queue.save();
  return true;
}

/** Queues the prompt of every armed schedule that is due. Returns whether anything changed. */
export function runSchedules(queue: Queue, panes: Map<string, PaneInfo>, now = Date.now()): boolean {
  let changed = false;
  for (const s of queue.data.schedules) {
    if (!s.armed || s.nextRunAt === undefined) continue;
    const step = scheduleStep(s.timing, s.nextRunAt, now);
    if (!step.due) continue;
    changed = true;
    s.nextRunAt = step.nextRunAt;
    s.lastRunAt = now;
    if (queue.data.paused) {
      s.lastResult = "Skipped: automation paused";
    } else if (!panes.get(s.target)?.status) {
      s.lastResult = "Skipped: the agent isn't there";
    } else if (queue.data.items.some((i) => i.source.scheduleId === s.id && i.state === "pending")) {
      s.lastResult = "Skipped: the last run is still queued";
    } else {
      const item = queue.enqueue(
        {
          target: s.target,
          targetLabel: paneLabel(panes.get(s.target), s.target),
          text: s.text,
          source: { kind: "schedule", scheduleId: s.id, label: `Schedule: ${describeTiming(s.timing)}` },
        },
        now,
      );
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- enqueue returns the new item or why it refused
      s.lastResult = typeof item === "string" ? `Not queued: ${item}` : "Queued";
    }
  }
  if (changed) void queue.save();
  return changed;
}

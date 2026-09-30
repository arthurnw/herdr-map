// Runs the queue, handoff links, and schedules on one timer, reading the fleet the poller
// already has. Nothing here sends anything unless the user created a link, armed a
// schedule, or queued a prompt, and the global pause stops all of it.
import type { ReplyOutput } from "../probe/reply.ts";
import { FINISH_GRACE_MS, type AgentStatus } from "../shared/model.ts";
import { indexPanes, paneLabel, type PaneInfo } from "./agents.ts";
import { promptAgent, readPane, type HerdrOptions } from "./herdr.ts";
import { loadStore } from "./layout-store.ts";
import type { Poller } from "./poller.ts";
import { HANDOFF_LINES, handoffPrompt, type HandoffOutput } from "./prompts.ts";
import { openQueue, type Queue } from "./queue.ts";
import { runSchedules } from "./schedules.ts";

export const TICK_MS = 2_000;

interface Turn {
  /** Working or blocked since the last finish. */
  active: boolean;
  /** When an active agent was first seen idle. */
  idleSince?: number;
}

/**
 * Finds agents that just finished a turn: working or blocked, then `done`, or `idle` for
 * `FINISH_GRACE_MS` (a short idle between steps doesn't count). Each turn is reported once.
 * An agent already idle when first seen has no turn to finish.
 */
export class TurnWatcher {
  private turns = new Map<string, Turn>();

  observe(statuses: Map<string, AgentStatus>, now: number): string[] {
    const finished: string[] = [];
    const next = new Map<string, Turn>();
    for (const [pane, status] of statuses) {
      const turn: Turn = { ...(this.turns.get(pane) ?? { active: false }) };
      if (status === "working" || status === "blocked") {
        turn.active = true;
        delete turn.idleSince;
      } else if (turn.active && status === "done") {
        finished.push(pane);
        turn.active = false;
        delete turn.idleSince;
      } else if (turn.active && status === "idle") {
        turn.idleSince ??= now;
        if (now - turn.idleSince >= FINISH_GRACE_MS) {
          finished.push(pane);
          turn.active = false;
          delete turn.idleSince;
        }
      }
      next.set(pane, turn);
    }
    this.turns = next;
    return finished;
  }
}

/** An agent's final reply from its transcript, or its terminal's recent output when the transcript has none. */
export async function handoffOutput(
  pane: string,
  lastReply: (pane: string) => Promise<ReplyOutput>,
  readScreen: (pane: string) => Promise<string>,
): Promise<HandoffOutput> {
  const reply = await lastReply(pane).catch(() => undefined);
  if (reply?.text) return { reply: reply.text, ...(reply.trimmed && { trimmed: true }) };
  try {
    return { screen: await readScreen(pane) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export interface AutomationDeps {
  herdr: HerdrOptions;
  layoutPath: string;
  queuePath: string;
  poller: Poller;
}

export type Automation = Awaited<ReturnType<typeof createAutomation>>;

export async function createAutomation({ herdr, layoutPath, queuePath, poller }: AutomationDeps) {
  const queue: Queue = await openQueue({
    path: queuePath,
    view: () => poller.state(),
    send: (pane, text) => promptAgent(herdr, pane, text),
    onDelivered: () => void poller.poll(),
  });
  const turns = new TurnWatcher();
  let running = false;


  async function fireHandoffs(finished: string[], panes: Map<string, PaneInfo>, now: number) {
    const { links } = await loadStore(layoutPath);
    for (const link of links) {
      if (link.kind !== "handoff" || link.from.kind !== "pane" || link.to.kind !== "pane") continue;
      if (!finished.includes(link.from.id)) continue;
      const from = panes.get(link.from.id);
      const output = await handoffOutput(link.from.id, poller.lastReply, (pane) => readPane(herdr, pane, "recent", HANDOFF_LINES));
      queue.enqueue(
        {
          target: link.to.id,
          targetLabel: paneLabel(panes.get(link.to.id), link.to.id),
          text: handoffPrompt(from, link.from.id, output),
          source: { kind: "handoff", linkId: link.id, label: `Handoff from ${paneLabel(from, link.from.id)}` },
          coalesce: true,
        },
        now,
      );
    }
  }

  async function tick(now = Date.now()) {
    if (running) return;
    running = true;
    try {
      const { fleet, error } = poller.state();
      if (fleet && !error) {
        const panes = indexPanes(fleet);
        const statuses = new Map<string, AgentStatus>();
        for (const [id, p] of panes) if (p.status) statuses.set(id, p.status);
        const finished = turns.observe(statuses, now);
        if (finished.length > 0) await fireHandoffs(finished, panes, now);
        runSchedules(queue, panes, now);
      }
      await queue.tick(now);
    } catch (err) {
      console.error(`herdr-map: automation: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  return {
    queue,
    tick,
    start: () => setInterval(() => void tick(), TICK_MS),
  };
}

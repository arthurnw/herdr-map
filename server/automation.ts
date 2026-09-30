// Runs the queue on its own timer, reading the fleet the poller already has. Nothing
// here sends anything unless the user queued it, and the global pause stops delivery.
import { promptAgent, type HerdrOptions } from "./herdr.ts";
import type { Poller } from "./poller.ts";
import { openQueue, type Queue } from "./queue.ts";

export const TICK_MS = 2_000;

export interface AutomationDeps {
  herdr: HerdrOptions;
  queuePath: string;
  poller: Poller;
}

export type Automation = Awaited<ReturnType<typeof createAutomation>>;

export async function createAutomation({ herdr, queuePath, poller }: AutomationDeps) {
  const queue: Queue = await openQueue({
    path: queuePath,
    view: () => poller.state(),
    send: (pane, text) => promptAgent(herdr, pane, text),
    onDelivered: () => void poller.poll(),
  });
  let running = false;

  async function tick(now = Date.now()) {
    if (running) return;
    running = true;
    try {
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

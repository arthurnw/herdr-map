import type { Automation } from "./automation.ts";
import type { HerdrOptions } from "./herdr.ts";
import type { Poller } from "./poller.ts";

/** Server-wide settings and state shared by every route module. */
export interface Context {
  herdr: HerdrOptions;
  /** hunk executable where herdr runs. */
  hunk: string;
  layoutPath: string;
  /** Terminal app to bring to the front after a focus. Unset with --no-activate. */
  activate?: string;
  poller: Poller;
  /** The prompt queue, handoffs, and schedules. */
  automation: Automation;
}

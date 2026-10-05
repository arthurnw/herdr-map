import type { Automation } from "./automation.ts";
import type { HerdrOptions } from "./herdr.ts";
import type { Poller } from "./poller.ts";
import type { ProbeOptions } from "./probe.ts";

/** Server-wide settings and state shared by every route module. */
export interface Context {
  herdr: HerdrOptions;
  /** hunk executable where herdr runs. */
  hunk: string;
  layoutPath: string;
  /** Terminal app to bring to the front after a focus. Unset with --no-activate. */
  activate?: string;
  poller: Poller;
  /** Where the probe runs. Unset with --no-probe. */
  probe?: ProbeOptions;
  /** The prompt queue, handoffs, and schedules. */
  automation: Automation;
}

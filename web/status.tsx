import type { AgentStatus } from "../shared/model.ts";
import { cn } from "@/lib/utils";

// Spelled out so Tailwind's scanner sees each class.
export const STATUS_BG: Record<AgentStatus, string> = {
  working: "bg-status-working",
  blocked: "bg-status-blocked",
  done: "bg-status-done",
  idle: "bg-status-idle",
  unknown: "bg-status-unknown",
};

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        STATUS_BG[status],
        status === "blocked" && "animate-pulse",
        className,
      )}
    />
  );
}

const KIND_LABELS = new Map([
  ["claude", "Claude"],
  ["pi", "Pi"],
  ["codex", "Codex"],
]);

/** The display name of an agent kind; kinds without one show as reported. */
export const kindLabel = (kind: string) => KIND_LABELS.get(kind) ?? kind;

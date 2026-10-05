import { FileCode, GitCompareArrows, SquareTerminal } from "lucide-react";
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

// Two letters, so Claude and Codex don't share a mark.
const KIND_MARKS = new Map([
  ["claude", "CC"],
  ["codex", "CX"],
  ["pi", "PI"],
]);

/** What a non-agent pane runs, from its terminal title: an editor, a diff viewer, or a shell. */
function toolIcon(title: string): typeof SquareTerminal {
  const cmd = title.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (/^n?vim?$|^hx$|^helix$|^emacs$|^nano$|^micro$/.test(cmd)) return FileCode;
  if (/^(hunk|tuicr|lazygit|tig|delta|difft)$/.test(cmd)) return GitCompareArrows;
  return SquareTerminal;
}

/** A small neutral mark for an agent's kind, or for what a non-agent pane runs. */
export function KindMark({ kind, title }: { kind?: string; title?: string }) {
  const cls = "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border bg-muted px-1 font-mono text-[10px] leading-none font-semibold text-muted-foreground";
  if (kind) {
    const label = kindLabel(kind);
    return (
      <span className={cls} title={label} aria-label={label} role="img">
        {KIND_MARKS.get(kind) ?? kind.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  const Icon = toolIcon(title ?? "");
  return (
    <span className={cls} aria-hidden>
      <Icon className="size-3" />
    </span>
  );
}

// Spelled out so Tailwind's scanner sees each class.
const STATUS_PILL: Record<AgentStatus, string> = {
  working: "border-status-working/50 bg-status-working/15",
  blocked: "border-status-blocked/50 bg-status-blocked/15",
  done: "border-status-done/50 bg-status-done/15",
  idle: "border-status-idle/50 bg-status-idle/15",
  unknown: "border-status-unknown/50 bg-status-unknown/15",
};

/** The agent's status and how long it has had it, tinted with the status color. */
export function StatusPill({ status, age }: { status: AgentStatus; age: string }) {
  return (
    <span className={cn("status-pill inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap", STATUS_PILL[status])}>
      <StatusDot status={status} />
      {status}{" "}
      <span className="text-muted-foreground tabular-nums">{age}</span>
    </span>
  );
}

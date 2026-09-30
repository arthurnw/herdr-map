// Toolbar controls for automation: the global pause and the queue, with its recent
// deliveries, in a popover.
import { useEffect, useState } from "react";
import { CirclePause, ListOrdered, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AutomationState, QueueItem } from "../shared/automation.ts";
import { agentLabel, OPEN_QUEUE_EVENT, useAutomation, type AutomationValue } from "./automation.tsx";
import { formatAge } from "./format.ts";

export function AutomationControls({ now }: { now: number }) {
  const auto = useAutomation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_QUEUE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_QUEUE_EVENT, onOpen);
  }, []);
  if (!auto?.state) return null;
  const { state, actions } = auto;
  const { paused } = state;
  const waiting = state.items.length;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={paused}
            aria-label={paused ? "Resume automation" : "Pause automation"}
            onClick={() => void actions.setPaused(!paused)}
            className={cn(
              "h-8 gap-1.5",
              paused && "border-status-blocked bg-status-blocked/15 text-foreground hover:bg-status-blocked/25",
            )}
          >
            {paused ? <CirclePause className="size-3.5" /> : <Zap className="size-3.5" />}
            {paused ? "Automation paused" : "Automation on"}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {paused
            ? "Nothing is sent automatically. Click to resume queued prompts."
            : "Click to stop all automatic sends."}
        </TooltipContent>
      </Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 gap-1.5" aria-label={`Queue, ${waiting} waiting`}>
            <ListOrdered className="size-3.5" />
            Queue
            {waiting > 0 && (
              <Badge variant="secondary" className="px-1.5 tabular-nums" data-testid="queue-count">
                {waiting}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-h-[75vh] w-[28rem] overflow-y-auto p-0">
          <QueuePanel auto={auto} state={state} now={now} />
        </PopoverContent>
      </Popover>
    </>
  );
}

function itemStatus(item: QueueItem, state: AutomationState, now: number, auto: AutomationValue): string {
  if (item.state === "gone") return "Agent gone";
  if (item.state === "failed") return "Failed";
  if (item.notBefore && item.notBefore > now) return `Retrying in ${formatAge(item.notBefore - now)}`;
  if (state.paused && !item.sendNow) return "Paused";
  const status = auto.panes.get(item.target)?.pane.agent?.status;
  if (!status) return "Waiting for the agent";
  return status === "idle" || status === "done" ? "Sending" : `Waiting: ${status}`;
}

function QueuePanel({ auto, state, now }: { auto: AutomationValue; state: AutomationState; now: number }) {
  const { actions, panes } = auto;
  const history = [...state.history].reverse();
  return (
    <div className="divide-y text-sm">
      <section className="p-3" aria-label="Waiting prompts">
        <h3 className="font-semibold">Queue</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Prompts wait here until their agent is idle or done, then go out one at a time.
        </p>
        {state.items.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing waiting.</p>
        ) : (
          <ul className="space-y-2">
            {state.items.map((item) => (
              <li key={item.id} className="rounded-md border p-2" data-testid="queue-item">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{agentLabel(panes, item.target, item.targetLabel)}</span>
                  <Badge variant={item.state === "pending" ? "outline" : "destructive"} className="font-normal">
                    {itemStatus(item, state, now, auto)}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {item.source.label} · {formatAge(now - item.createdAt)} ago
                  {item.attempts > 0 && ` · ${item.attempts} attempt${item.attempts > 1 ? "s" : ""}`}
                </p>
                <p className="mt-1 line-clamp-2 text-xs whitespace-pre-wrap" title={item.text}>
                  {item.text}
                </p>
                {item.lastError && <p className="mt-1 text-xs text-destructive">{item.lastError}</p>}
                <div className="mt-1.5 flex gap-1">
                  {item.state === "pending" && (
                    <Button size="xs" variant="outline" onClick={() => void actions.sendNow(item.id)} title="Send as soon as the agent is idle, even while paused">
                      Send now
                    </Button>
                  )}
                  {item.state === "failed" && (
                    <Button size="xs" variant="outline" onClick={() => void actions.retry(item.id)}>
                      Retry
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" onClick={() => void actions.cancel(item.id)}>
                    {item.state === "gone" ? "Dismiss" : "Cancel"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="p-3" aria-label="Recently sent">
        <h3 className="mb-1 font-semibold">Recently sent</h3>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing sent from the queue yet.</p>
        ) : (
          <ul className="space-y-1">
            {history.map((d) => (
              <li key={d.id} className="text-xs" title={d.text}>
                <span className="text-muted-foreground tabular-nums">{new Date(d.deliveredAt).toLocaleTimeString()}</span>{" "}
                <span className="font-medium">{agentLabel(panes, d.target, d.targetLabel)}</span>
                <span className="text-muted-foreground"> · {d.source.label}</span>
                <span className="line-clamp-1 text-muted-foreground">{d.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}


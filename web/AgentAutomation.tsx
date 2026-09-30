// The automation block in an agent's preview: a way to queue a prompt for when it's idle.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PROMPT_TEXT_MAX } from "../shared/automation.ts";
import { agentLabel, useAutomation } from "./automation.tsx";
import type { Located } from "./state.ts";

export function AgentAutomation({ located }: { located: Located }) {
  const auto = useAutomation();
  const paneId = located.pane.id;
  const [open, setOpen] = useState(false);
  const [queueing, setQueueing] = useState(false);

  useEffect(() => setQueueing(false), [paneId]);

  const waiting = (auto?.state?.items ?? []).filter((i) => i.target === paneId).length;
  if (!auto?.state) return null;

  const summary = [waiting && `${waiting} queued`].filter(Boolean);

  return (
    <div className="rounded-lg border text-sm" data-testid="agent-automation">
      <button className="flex w-full items-center gap-1.5 px-3 py-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="font-medium">Automation</span>
        <span className="truncate text-xs text-muted-foreground">{summary.length ? summary.join(" · ") : "Queued prompts"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t px-3 py-2">
          {queueing ? (
            <QueueForm
              label={agentLabel(auto.panes, paneId)}
              onCancel={() => setQueueing(false)}
              onQueue={async (text) => {
                if (await auto.actions.enqueue(paneId, text)) setQueueing(false);
              }}
            />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <Button variant="outline" size="xs" onClick={() => setQueueing(true)}>
                <ListPlus />
                Send when idle
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
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

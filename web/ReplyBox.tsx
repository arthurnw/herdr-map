import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CornerDownLeft, SendHorizontal } from "lucide-react";
import { toast } from "sonner";
import { hasDialogHint, parseDialogOptions } from "../shared/dialog.ts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Located } from "./state.ts";

/** Fired by the `r` shortcut to move focus into the reply box. */
export const FOCUS_REPLY_EVENT = "herdr-map:focus-reply";

async function post(path: string, body: object) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
}

interface Props {
  located: Located;
  /** The pane's current screen text, used to find dialog options. */
  screen?: string;
  /** Called after input is sent so the preview can re-read the screen. */
  onSent: () => void;
}

export function ReplyBox({ located, screen, onSent }: Props) {
  const { pane } = located;
  const agent = pane.agent!;
  // herdr marks Claude and Pi dialogs as blocked, but Codex pickers stay idle, so a
  // picker's key hints on screen also count as a dialog.
  const blocked = agent.status === "blocked" || (!!screen && hasDialogHint(screen));
  const options = blocked && screen ? parseDialogOptions(screen) : [];
  const name = agent.name ?? located.workspace.label;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener(FOCUS_REPLY_EVENT, focus);
    return () => window.removeEventListener(FOCUS_REPLY_EVENT, focus);
  }, []);

  useEffect(() => setText(""), [pane.id]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(`Couldn't send ${what}`, { description: (err as Error).message });
    } finally {
      setBusy(false);
      // Re-read the screen either way, so a refused answer shows the dialog that replaced it.
      onSent();
    }
  };

  const keys = (k: string[]) => run("keys", () => post("/api/keys", { pane: pane.id, keys: k }));
  // The server re-reads the dialog and refuses the key if this option is no longer there.
  const choose = (o: { key: string; label: string }) =>
    run("your answer", () => post("/api/keys", { pane: pane.id, keys: [o.key], expect: { key: o.key, label: o.label } }));

  const send = () => {
    const value = text.trim();
    if (!value) return;
    void run(blocked ? "text" : "prompt", async () => {
      // A blocked agent is showing a dialog, which herdr won't send prompts into:
      // type the text and press Enter instead.
      if (blocked) {
        await post("/api/text", { pane: pane.id, text: value });
        await post("/api/keys", { pane: pane.id, keys: ["enter"] });
      } else {
        await post("/api/prompt", { pane: pane.id, text: value });
      }
      setText("");
      toast.success(`Sent to ${name}`);
    });
  };

  return (
    <div className="space-y-2">
      {options.length > 0 && (
        <div className="flex flex-col gap-1">
          {options.map((o) => (
            <Button
              key={o.key}
              variant={o.selected ? "secondary" : "outline"}
              size="sm"
              disabled={busy}
              className="h-auto justify-start gap-2 py-1.5 text-left whitespace-normal"
              onClick={() => void choose(o)}
            >
              <Kbd>{o.key}</Kbd>
              <span className="min-w-0">{o.label}</span>
            </Button>
          ))}
        </div>
      )}
      {blocked && (
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-muted-foreground">Keys</span>
          <KeyButton label="Up" disabled={busy} onClick={() => void keys(["up"])}>
            <ArrowUp />
          </KeyButton>
          <KeyButton label="Down" disabled={busy} onClick={() => void keys(["down"])}>
            <ArrowDown />
          </KeyButton>
          <KeyButton label="Enter" disabled={busy} onClick={() => void keys(["enter"])}>
            <CornerDownLeft />
          </KeyButton>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void keys(["esc"])}>
            Esc
          </Button>
        </div>
      )}
      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Textarea
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          rows={2}
          placeholder={blocked ? `Type an answer into ${name}'s dialog` : `Send a prompt to ${name}`}
          className="min-h-16 resize-none pr-11 text-sm"
        />
        <Button
          type="submit"
          size="icon"
          className="absolute right-2 bottom-2 size-7"
          disabled={busy || !text.trim()}
          aria-label="Send"
        >
          <SendHorizontal className="size-3.5" />
        </Button>
      </form>
      <p className={cn("text-xs text-muted-foreground")}>
        <Kbd>↵</Kbd> sends · <Kbd>⇧</Kbd>
        <Kbd>↵</Kbd> new line{blocked ? " · the text is typed into the dialog, then Enter is pressed" : ""}
      </p>
    </div>
  );
}

function KeyButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button variant="outline" size="icon" className="size-7" aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

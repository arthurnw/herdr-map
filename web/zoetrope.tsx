// A button that opens the agent's session graph in zoetrope, shown when its herdr plugin is installed.
import { useEffect, useState } from "react";
import { Workflow } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { hasZoetropeSession } from "../shared/zoetrope.ts";
import type { Located } from "./state.ts";
import { errorMessage } from "../shared/errors.ts";

// Checked once per page load; installing the plugin takes a reload to show the button.
let available: Promise<boolean> | undefined;

function zoetropeAvailable(): Promise<boolean> {
  available ??= fetch("/api/zoetrope")
    .then((res) => res.json())
    .then((body) => body.available === true)
    .catch(() => false);
  return available;
}

async function openGraph(pane: string) {
  const res = await fetch("/api/zoetrope", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
}

export function ZoetropeButton({ located }: { located: Located }) {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    let live = true;
    void zoetropeAvailable().then((v) => live && setInstalled(v));
    return () => {
      live = false;
    };
  }, []);
  if (!installed || !hasZoetropeSession(located.pane.agent)) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      title="Open this agent's session as a live flow graph in zoetrope, over its pane in herdr"
      onClick={() =>
        void openGraph(located.pane.id).catch((err) =>
          toast.error("Couldn't open the session graph", { description: errorMessage(err) }),
        )
      }
    >
      <Workflow className="size-3.5" />
      Session graph
    </Button>
  );
}

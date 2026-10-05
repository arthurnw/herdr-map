import { Fragment, useMemo } from "react";
import { toast } from "sonner";
import type { AnsiRun } from "../shared/ansi.ts";
import { linkRuns, type ScreenLink } from "../shared/linkify.ts";
import { errorMessage } from "../shared/errors.ts";
import "./terminal.css";

/** Copies text and says so in a toast. */
export async function copyText(text: string, what = text) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
  } catch (err) {
    toast.error("Couldn't copy", { description: errorMessage(err) });
  }
}

// A click that ends a text selection shouldn't open or copy anything.
const selecting = () => !(window.getSelection()?.isCollapsed ?? true);

function drawRuns(runs: AnsiRun[]) {
  return runs.map((run, i) => (run.style ? <span key={i} style={run.style}>{run.text}</span> : run.text));
}

function Link({ link, children }: { link: ScreenLink; children: React.ReactNode }) {
  if (link.kind === "url") {
    return (
      <a className="terminal-link" href={link.target} target="_blank" rel="noreferrer" draggable={false} onClick={(e) => selecting() && e.preventDefault()}>
        {children}
      </a>
    );
  }
  // Not focusable: Chrome doesn't start a text selection on a focusable element, and a drag
  // that starts on a reference should select text like the rest of the screen.
  return (
    <span className="terminal-link" data-copy={link.target} title={`Click to copy ${link.target}`} onClick={() => !selecting() && void copyText(link.target)}>
      {children}
    </span>
  );
}

/**
 * A pane's screen in the colors its program sent. The text stays selectable and findable; URLs
 * open in a new tab, and clicking a `path:line` reference copies it.
 */
export function TerminalScreen({ runs }: { runs?: AnsiRun[] }) {
  const pieces = useMemo(() => runs && linkRuns(runs), [runs]);
  return (
    <pre className="terminal-screen">
      {pieces ? (
        pieces.map((p, i) => (p.link ? <Link key={i} link={p.link}>{drawRuns(p.runs)}</Link> : <Fragment key={i}>{drawRuns(p.runs)}</Fragment>))
      ) : (
        <span className="terminal-placeholder">Loading screen…</span>
      )}
    </pre>
  );
}

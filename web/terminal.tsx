import type { AnsiRun } from "../shared/ansi.ts";
import "./terminal.css";

/** A pane's screen in the colors its program sent. The text stays selectable and findable. */
export function TerminalScreen({ runs }: { runs?: AnsiRun[] }) {
  return (
    <pre className="terminal-screen">
      {runs ? runs.map((run, i) => (run.style ? <span key={i} style={run.style}>{run.text}</span> : run.text)) : <span className="terminal-placeholder">Loading screen…</span>}
    </pre>
  );
}

export type HistoryPart = { kind: "prompt" | "tool" | "text"; text: string };

/**
 * Splits the server's history text into prompts, tool calls, and the agent's messages. Entries
 * are separated by blank lines; a prompt starts with `› ` and has no blank line inside it, and a
 * tool call is one line starting with `→ `. A Pi message holds its text and tool calls in one entry.
 */
export function historyParts(text: string): HistoryPart[] {
  const parts: HistoryPart[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    if (block.startsWith("› ")) {
      parts.push({ kind: "prompt", text: block.slice(2).replace(/\n {2}/g, "\n") });
      continue;
    }
    block.split("\n").forEach((line, i) => {
      const kind = line.startsWith("→ ") ? "tool" : "text";
      const last = parts.at(-1);
      // Consecutive tool calls form one part; each paragraph of a message is its own.
      if (last?.kind === kind && (kind === "tool" || i > 0)) last.text += `\n${line}`;
      else parts.push({ kind, text: line });
    });
  }
  return parts;
}

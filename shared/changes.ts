// A workspace's changed files and their diffs, as the changes probe reports them for the preview's
// Changes tab.

/** Uncommitted: the working tree and index against HEAD. Branch: the working tree against the merge-base with the default branch. */
export type ChangeScope = "uncommitted" | "branch";
export const CHANGE_SCOPES: readonly ChangeScope[] = ["uncommitted", "branch"];

/** Added, modified, deleted, renamed, untracked, or unmerged. */
export type FileStatus = "A" | "M" | "D" | "R" | "?" | "U";

export interface ChangedFile {
  /** Relative to the repo root. */
  path: string;
  /** The path before a rename. */
  from?: string;
  status: FileStatus;
  /** Unset for binary files and for untracked files too large to count. */
  adds?: number;
  dels?: number;
  binary?: boolean;
}

export interface ChangesSummary {
  root: string;
  scope: ChangeScope;
  /** Unset when HEAD is detached. */
  branch?: string;
  /** Short SHA of HEAD; unset before the first commit. */
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Branch scope: the default branch compared with, such as `origin/main`. */
  base?: string;
  /** Branch scope: commits on HEAD since the merge-base. */
  commits?: number;
  /** Sorted by path, up to the probe's limit. */
  files: ChangedFile[];
  /** Files left off the list past that limit. */
  more?: number;
  adds: number;
  dels: number;
}

export interface ChangesOutput {
  summary?: ChangesSummary;
  error?: string;
}

export interface FileDiff {
  path: string;
  binary?: boolean;
  /** Unified diff text from git, file headers included. */
  text: string;
  truncated?: boolean;
  /** Why there's no diff to show, such as a file too large to read. */
  note?: string;
  error?: string;
}

export type DiffLineKind = "hunk" | "add" | "del" | "ctx" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number on the old side, for context and removed lines. */
  old?: number;
  /** Line number on the new side, for context and added lines. */
  new?: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The hunks of a unified diff with line numbers. File headers (`diff --git`, `index`, `---`,
 * `+++`, mode and rename lines) are dropped; a hunk's body is however many lines its header counts.
 */
export function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("\\")) {
      out.push({ kind: "note", text: line.slice(1).trim() });
      continue;
    }
    if (oldLeft > 0 || newLeft > 0) {
      const mark = line[0];
      const body = line.slice(1);
      if (mark === "+") {
        out.push({ kind: "add", text: body, new: newNo++ });
        newLeft--;
        continue;
      }
      if (mark === "-") {
        out.push({ kind: "del", text: body, old: oldNo++ });
        oldLeft--;
        continue;
      }
      if (mark === " " || line === "") {
        out.push({ kind: "ctx", text: body, old: oldNo++, new: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
    }
    const m = HUNK.exec(line);
    if (!m) continue;
    oldNo = Number(m[1]);
    newNo = Number(m[3]);
    oldLeft = m[2] === undefined ? 1 : Number(m[2]);
    newLeft = m[4] === undefined ? 1 : Number(m[4]);
    out.push({ kind: "hunk", text: line });
  }
  return out;
}

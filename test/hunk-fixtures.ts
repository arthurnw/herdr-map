// Output shapes captured from hunk 0.22.0 and the jhochenbaum.hunkdiff plugin 0.2.0 against a
// scratch repo, with synthetic paths, IDs, and note text.

export const REPO = "/work/sandbox";
export const SESSION = "e156d44b-8974-4962-b15d-f782539872bb";

/** `hunk session comment list --type all --json`. A reply names its parent; a note on a removed line has `oldRange`. */
export const COMMENTS = {
  comments: [
    {
      noteId: "user:1790809087334-1",
      source: "user",
      filePath: "greet.ts",
      hunkIndex: 0,
      oldRange: [2, 2],
      body: "Keep the exclamation mark out of the greeting",
      author: "user",
      createdAt: "2026-09-30T22:58:07.334Z",
      editable: true,
    },
    {
      noteId: "mcp:9b9def82-635a-44ec-8dc3-b52b81ea152d",
      parentId: "user:1790809087334-1",
      source: "agent",
      filePath: "greet.ts",
      hunkIndex: 0,
      oldRange: [2, 2],
      body: "Dropping it in the next turn",
      author: "pi",
      createdAt: "2026-09-30T22:58:14.913Z",
      editable: false,
    },
    {
      noteId: "mcp:95ce3ca5-41b9-47b4-8e9f-a3e02681c526",
      source: "agent",
      filePath: "math.ts",
      hunkIndex: 0,
      newRange: [3, 3],
      body: "Added mul; should div guard against zero?\n\nA rationale follows the summary after a blank line.",
      author: "pi",
      createdAt: "2026-09-30T22:58:01.254Z",
      editable: false,
    },
    {
      noteId: "user:1790808965938-1",
      source: "user",
      filePath: "greet.ts",
      hunkIndex: 0,
      newRange: [3, 3],
      body: "Please add a test for the polite farewell",
      author: "user",
      createdAt: "2026-09-30T22:56:05.938Z",
      editable: true,
    },
  ],
};

/** `hunk session list --json`: each session carries its notes in `snapshot.state.reviewNotes`. */
export function sessionList(notes: unknown[] | null = COMMENTS.comments) {
  return {
    sessions: [
      {
        sessionId: SESSION,
        pid: 86875,
        cwd: REPO,
        repoRoot: REPO,
        launchedAt: "2026-09-30T22:55:07.222Z",
        terminal: { locations: [{ source: "tty", tty: "/dev/ttys059" }] },
        inputKind: "vcs",
        title: "sandbox working tree",
        sourceLabel: REPO,
        experimentalFeatures: [],
        fileCount: 2,
        files: [{ id: `${REPO}:0:greet.ts`, path: "greet.ts", additions: 3, deletions: 3, hunkCount: 1 }],
        snapshot: {
          updatedAt: "2026-09-30T22:58:14.917Z",
          state: {
            selectedFileId: `${REPO}:0:greet.ts`,
            selectedFilePath: "greet.ts",
            selectedHunkIndex: 0,
            showAgentNotes: true,
            liveCommentCount: 2,
            liveComments: [],
            ...(notes && { reviewNoteCount: notes.length, reviewNotes: notes }),
          },
        },
      },
    ],
  };
}

/**
 * The plugin's `review-index.json`, keyed by worktree. `sent` holds the IDs of your comments
 * `send-review` delivered; `paneId` is the review pane and is dropped when that pane closes.
 */
export const INDEX = {
  [REPO]: {
    worktree: REPO,
    agentName: "pi",
    agentPaneId: "w1:p1",
    sent: ["user:1790808965938-1"],
    requestedMode: "working",
    paneId: "w1:p2",
  },
  "/work/other": { worktree: "/work/other", agentName: "claude", agentPaneId: "w9:p1", sent: [] },
};

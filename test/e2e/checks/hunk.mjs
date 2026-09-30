// hunk review notes, read by the hunk probe from test/e2e/hunk-stub.sh and a stand-in plugin index.
// The session is only served while these checks run, so the other checks see no reviews.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_DIRS } from "../fixture.mjs";

const SESSION = "0e2e0000-0000-4000-8000-00000000cafe";
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const note = (id, source, author, file, line, body, extra = {}) => ({
  noteId: id,
  source,
  filePath: file,
  hunkIndex: 0,
  newRange: [line, line],
  body,
  author,
  createdAt: ago(60_000),
  editable: source === "user",
  ...extra,
});
// Shaped like `hunk session list --json` from hunk 0.22, with synthetic content.
const NOTES = [
  note("user:e2e-1", "user", "user", "auth.ts", 3, "Rename this to refreshToken"),
  note("mcp:e2e-r1", "agent", "claude", "auth.ts", 3, "Renamed in the next commit", { parentId: "user:e2e-1" }),
  note("user:e2e-2", "user", "user", "auth.ts", 9, "Already sent to the agent"),
  note("mcp:e2e-a1", "agent", "claude", "api.ts", 10, "Consider caching the token\n\nIt's read on every request."),
];
const sessions = () => ({
  sessions: [
    {
      sessionId: SESSION,
      cwd: GIT_DIRS.w1,
      repoRoot: GIT_DIRS.w1,
      title: "api working tree",
      inputKind: "vcs",
      fileCount: 2,
      snapshot: { state: { reviewNoteCount: NOTES.length, reviewNotes: NOTES } },
    },
  ],
});
// The plugin's record: w1:p1 owns the review, w1:p2 shows it, and one comment was sent.
const INDEX = { [GIT_DIRS.w1]: { worktree: GIT_DIRS.w1, agentName: "claude", agentPaneId: "w1:p1", paneId: "w1:p2", sent: ["user:e2e-2"] } };
const PLUGINS = { result: { plugins: [{ plugin_id: "jhochenbaum.hunkdiff", enabled: true }] } };

export default function hunkChecks({ test, assert, openPage, card, needsYouRow, actions, clearActions, stubDir }) {
  const header = (page, id) => page.locator(`.react-flow__node-workspace[data-id="ws:${id}"] .ws-header`);
  const review = (page) => page.locator("aside section[aria-label='Review']");
  const row = (page, id) => review(page).locator(`li[data-note="${id}"]`);
  const text = async (locator) => ((await locator.count()) ? (await locator.first().textContent()).trim() : "");
  const files = { sessions: join(stubDir, "hunk-sessions.json"), index: join(stubDir, "hunk-index.json"), plugins: join(stubDir, "plugins.json") };

  function serveReview() {
    writeFileSync(files.index, JSON.stringify(INDEX));
    writeFileSync(files.plugins, JSON.stringify(PLUGINS));
    writeFileSync(files.sessions, JSON.stringify(sessions()));
  }
  // The hunk probe runs every 10 s.
  const waitForChip = (page) => header(page, "w1").locator(".ws-hunk").waitFor({ timeout: 15_000 });
  const pinLead = async (page) => {
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    await review(page).waitFor();
  };

  test("review counts show on the workspace header and the owning agent's card, and unread notes need you", async (page) => {
    const needing = async () => Number(/^\((\d+)\)/.exec(await page.title())?.[1] ?? 0);
    const before = await needing();
    serveReview();
    await waitForChip(page);
    const ws = header(page, "w1");
    assert((await text(ws.locator(".hunk-unsent"))) === "1", `unsent on w1: ${await text(ws.locator(".hunk-unsent"))}`);
    assert((await text(ws.locator(".hunk-agent"))) === "2", `agent notes on w1: ${await text(ws.locator(".hunk-agent"))}`);
    assert((await ws.locator(".ws-hunk").getAttribute("title")).includes("1 comment from you not sent yet, 2 notes from agents"), "the chip's title explains it");
    const chip = card(page, "w1:p1").locator(".hunk-chip");
    assert((await chip.locator(".hunk-agent.hunk-unread").count()) === 1, "unread agent notes stand out on the card");
    for (const id of ["w2", "w3", "w4", "w5", "w6"]) assert((await header(page, id).locator(".ws-hunk").count()) === 0, `${id} has no review`);
    assert((await text(needsYouRow(page, "lead"))).includes("2 notes"), "the lead agent is in Needs you for its unread notes");
    assert((await needing()) === before + 1, `the title should count one more agent: ${await page.title()}`);
  });

  test("the Review section threads notes, and opening it marks them read", async (page) => {
    serveReview();
    await waitForChip(page);
    await pinLead(page);
    await row(page, "mcp:e2e-a1").waitFor();
    const order = await review(page).locator("li[data-note]").evaluateAll((els) => els.map((e) => e.dataset.note));
    assert(order.join(",") === "mcp:e2e-a1,user:e2e-1,mcp:e2e-r1,user:e2e-2", `note order: ${order}`);
    const agentRow = await text(row(page, "mcp:e2e-a1"));
    assert(agentRow.includes("claude") && agentRow.includes("api.ts:10") && agentRow.includes("Consider caching the token"), `agent row: ${agentRow}`);
    assert((await text(row(page, "user:e2e-1"))).includes("not sent"), "an unsent comment says so");
    assert((await text(row(page, "user:e2e-2"))).includes("sent"), "a sent comment says so");
    assert((await row(page, "mcp:e2e-r1").getAttribute("style")).includes("--depth: 1"), "a reply is indented under its note");
    assert((await review(page).locator(".hunk-note-dot").count()) === 2, "notes new at opening keep a dot while open");
    await page.waitForTimeout(300);
    assert((await card(page, "w1:p1").locator(".hunk-unread").count()) === 0, "opening the section marks the notes read");
    assert((await page.locator("aside li", { hasText: "lead" }).count()) === 0, "read notes leave Needs you");
    await page.reload();
    await card(page, "w1:p1").locator(".hunk-chip").waitFor({ state: "attached" });
    assert((await card(page, "w1:p1").locator(".hunk-unread").count()) === 0, "read notes stay read after a reload");
  });

  test("clicking a note moves hunk to it and focuses the review pane", async (page) => {
    serveReview();
    await waitForChip(page);
    await pinLead(page);
    clearActions();
    await row(page, "mcp:e2e-a1").locator(".hunk-note-main").click();
    await page.waitForTimeout(400);
    await row(page, "user:e2e-1").locator(".hunk-note-main").click();
    await page.waitForTimeout(400);
    const log = actions();
    assert(
      log.join("|") ===
        [
          `hunk session navigate ${SESSION} --comment=mcp:e2e-a1 --json`,
          "plugin pane focus w1:p2",
          `hunk session navigate ${SESSION} --file=auth.ts --new-line=3 --json`,
          "plugin pane focus w1:p2",
        ].join("|"),
      `got ${log}`,
    );
  });

  test("a reply posts a threaded hunk comment", async (page) => {
    serveReview();
    await waitForChip(page);
    await pinLead(page);
    clearActions();
    await row(page, "mcp:e2e-r1").getByRole("button", { name: "Reply" }).click();
    const box = row(page, "mcp:e2e-r1").getByRole("textbox", { name: "Reply to this note" });
    await box.fill("Thanks, looks right");
    await box.press("Enter");
    await page.waitForTimeout(500);
    const expected = `hunk session comment add ${SESSION} --reply-to=mcp:e2e-r1 --summary=Thanks, looks right --author=herdr-map --json`;
    assert(actions().includes(expected), `got ${actions()}`);
    assert((await box.count()) === 0, "the reply box closes once sent");
  });

  test("Send review and the comment steps run the plugin's actions from the owning agent", async (page) => {
    serveReview();
    // The page checks for the plugin once per load.
    await page.reload();
    await waitForChip(page);
    await pinLead(page);
    await review(page).getByRole("button", { name: "Send review" }).waitFor();
    clearActions();
    await review(page).getByRole("button", { name: "Send review" }).click();
    await page.waitForTimeout(400);
    await review(page).getByRole("button", { name: "Next comment" }).click();
    await page.waitForTimeout(400);
    const log = actions();
    assert(
      log.join("|") ===
        [
          "agent focus w1:p1",
          "plugin action invoke send-review --plugin jhochenbaum.hunkdiff",
          "agent focus w1:p1",
          "plugin action invoke next-comment --plugin jhochenbaum.hunkdiff",
          "plugin pane focus w1:p2",
        ].join("|"),
      `got ${log}`,
    );
  });

  test("hunk routes refuse sessions, notes, and actions the probe didn't report", async (page) => {
    serveReview();
    await waitForChip(page);
    clearActions();
    const statuses = await page.evaluate(async (session) => {
      const post = async (path, body) =>
        (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
      return [
        await post("/api/hunk/navigate", { session: "0e2e0000-0000-4000-8000-000000000bad", note: "mcp:e2e-a1" }),
        await post("/api/hunk/navigate", { session, note: "mcp:unknown" }),
        await post("/api/hunk/reply", { session, note: "user:e2e-1", text: "  " }),
        await post("/api/hunk/action", { pane: "w1:p1", action: "close-review" }),
        await post("/api/hunk/action", { pane: "w1:p2", action: "send-review" }),
      ];
    }, SESSION);
    assert(statuses.every((s) => s === 400), `expected 400s, got ${statuses}`);
    assert(actions().length === 0, `refused requests must not reach hunk or herdr, got ${actions()}`);
  });

  test("review counts go away when the hunk session ends", async (page) => {
    try {
      serveReview();
      await waitForChip(page);
      rmSync(files.sessions, { force: true });
      await header(page, "w1").locator(".ws-hunk").waitFor({ state: "detached", timeout: 15_000 });
      assert((await card(page, "w1:p1").locator(".hunk-chip").count()) === 0, "the card's chip goes too");
    } finally {
      for (const f of Object.values(files)) rmSync(f, { force: true });
    }
  });
}

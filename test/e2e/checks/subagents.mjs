// Subagent lists, their transcripts, and task progress, from the synthetic transcripts in
// ../transcripts and the Codex rollouts fixture.mjs writes at startup.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSCRIPTS } from "../fixture.mjs";

const CLAUDE_SESSION = "1fcd536a-ca43-43bf-8d03-a6ed74098343";

export default function subagentChecks({ test, assert, card, actions, clearActions }) {
  // The probe runs every 5 s, so a change can take a full round to show.
  async function waitFor(check, what, timeoutMs = 12_000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await check();
      if (last === true) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`expected ${what}, got ${JSON.stringify(last)}`);
  }
  const textOf = async (locator) => ((await locator.count()) ? await locator.first().textContent() : "");
  const chip = (page, paneId) => card(page, paneId).locator(".subagent-chip");
  const popover = (page) => page.locator('[data-slot="popover-content"][aria-label="Subagents"]');
  const row = (page, text) => popover(page).locator(".subagent-row", { hasText: text });
  const transcript = (page) => page.locator('aside [aria-label="Subagent transcript"]');
  async function openList(page, paneId) {
    await waitFor(async () => (await chip(page, paneId).count()) > 0, `a subagent chip on ${paneId}`);
    await chip(page, paneId).click();
    await popover(page).waitFor();
  }

  test("subagents aren't drawn on the map; the agent card counts them", async (page) => {
    await waitFor(async () => (await textOf(chip(page, "w1:p1"))) === "1/1" || (await textOf(chip(page, "w1:p1"))), "a 1/1 subagent chip");
    await card(page, "w1:p1").hover();
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    await page.getByRole("button", { name: "Unpin" }).waitFor();
    assert((await page.locator(".react-flow__node-subagent").count()) === 0, "no subagent nodes on the canvas");
    assert((await page.locator(".react-flow__node-pane .pane.agent").count()) === 6, "only agent cards");
  });

  test("the chip lists the agent's subagents, and a row pins the agent and shows the transcript, focusing nothing", async (page) => {
    await waitFor(async () => (await chip(page, "w1:p1").count()) > 0, "a subagent chip");
    clearActions();
    await openList(page, "w1:p1");
    const explore = row(page, "Explore");
    await waitFor(async () => {
      const t = await textOf(explore);
      return (t.includes("running") && t.includes("Map the auth middleware") && t.includes("12k tokens · 2 tools")) || t;
    }, "a running Explore row");
    assert(actions().length === 0, `opening the list must not focus the terminal, got ${actions()}`);
    assert((await page.getByRole("button", { name: "Unpin" }).count()) === 0, "opening the list doesn't select the agent");
    await explore.click();
    await waitFor(async () => {
      const t = await textOf(transcript(page));
      return (t.includes("→ Grep authMiddleware") && t.trimEnd().endsWith("Synthetic finding: the middleware lives in src/auth.ts.")) || t;
    }, "the subagent's messages, newest last");
    assert(actions().length === 0, `clicking a subagent must not focus the terminal, got ${actions()}`);
    await popover(page).waitFor({ state: "detached" });
    await openList(page, "w1:p1");
    assert((await row(page, "Explore").and(page.locator(".selected")).count()) === 1, "the open subagent's row is marked");
    await page.keyboard.press("Escape");
    await popover(page).waitFor({ state: "detached" });
    await page.getByRole("button", { name: /Back to lead/ }).click();
    await page.getByRole("button", { name: "Unpin" }).waitFor();
    assert((await transcript(page).count()) === 0, "Back returns to the agent's preview");
  });

  test("the preview lists the agent's subagents, and a row opens its transcript", async (page) => {
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    const row = page.locator("aside .subagent-list button").first();
    await row.waitFor({ timeout: 12_000 });
    assert((await row.textContent()).includes("Explore"), "the list names the subagent");
    await row.click();
    await page.locator('aside [aria-label="Subagent transcript"]').waitFor();
  });

  test("an agent card shows its todo progress, and the preview names the current task", async (page) => {
    await waitFor(async () => (await textOf(card(page, "w1:p1").locator(".task-chip"))) === "3/7" || (await textOf(card(page, "w1:p1").locator(".task-chip"))), "3/7");
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    const line = await textOf(page.locator('aside [aria-label="Tasks"]'));
    assert(line.includes("3 of 7 tasks done") && line.includes("Rewrite the token check"), `unexpected task line: ${line}`);
  });

  test("Codex subagents show as a tree, and approval reviews as a chip", async (page) => {
    await openList(page, "w2:p4");
    const child = row(page, "reviewer");
    const grandchild = row(page, "Noether");
    await waitFor(async () => (await child.count()) > 0 && (await grandchild.count()) > 0, "both Codex subagent rows");
    const c = await textOf(child);
    assert(c.includes("running") && c.includes("token cache review") && c.includes("42k tokens · 1 tool"), `unexpected row: ${c}`);
    const g = await textOf(grandchild);
    assert(g.includes("done · 40s") && g.includes("lint"), `unexpected nested row: ${g}`);
    const depths = await popover(page).locator("li").evaluateAll((els) => els.map((el) => [el.dataset.depth, el.textContent]));
    const i = depths.findIndex(([, t]) => t.includes("reviewer"));
    assert(depths[i][0] === "0" && depths[i + 1]?.[0] === "1" && depths[i + 1][1].includes("Noether"), `the nested subagent follows its parent: ${JSON.stringify(depths)}`);
    const [cb, gb] = [await child.boundingBox(), await grandchild.boundingBox()];
    assert(gb.x > cb.x && gb.y > cb.y, "the nested subagent is indented under its parent");
    assert((await card(page, "w2:p4").locator(".review-chip").count()) === 1, "a running review shows as a chip");
    await child.click();
    await waitFor(async () => {
      const text = await textOf(transcript(page));
      return (text.includes("Synthetic review note.") && !text.includes("Synthetic parent history.")) || text;
    }, "the Codex subagent's own messages, without the history it copied from its parent");
    await page.getByRole("button", { name: /Back to/ }).click();
    const nested = await page.locator("aside .subagent-list li").evaluateAll((els) => els.map((el) => [el.dataset.depth, el.textContent]));
    assert(nested.some(([d, t]) => d === "1" && t.includes("Noether")), `the preview nests it too: ${JSON.stringify(nested)}`);
  });

  // Last: the notification stays in the transcript for the rest of the run.
  test("a finished background subagent turns done with the numbers it reported", async (page) => {
    await openList(page, "w1:p1");
    const explore = row(page, "Explore");
    await explore.waitFor();
    const note = {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: new Date().toISOString(),
      content: `<task-notification>\n<tool-use-id>toolu_e2e_agent</tool-use-id>\n<status>completed</status>\n<usage><subagent_tokens>15000</subagent_tokens><tool_uses>3</tool_uses><duration_ms>42000</duration_ms></usage>\n</task-notification>`,
    };
    appendFileSync(join(TRANSCRIPTS, "claude", "projects", "-repos-w1", `${CLAUDE_SESSION}.jsonl`), `${JSON.stringify(note)}\n`);
    await waitFor(async () => {
      const t = await textOf(explore);
      return (t.includes("done") && t.includes("15k tokens · 3 tools")) || t;
    }, "a done row");
    assert((await explore.and(page.locator(".sub-done")).count()) === 1, "the row takes the done color");
    assert((await textOf(chip(page, "w1:p1"))) === "1", "the chip counts it without a running share");
  });
}

// Subagent cards, their transcripts, and task progress, from the synthetic transcripts in
// ../transcripts and the Codex rollouts fixture.mjs writes at startup.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_CHILD, CODEX_GRANDCHILD, TRANSCRIPTS } from "../fixture.mjs";

const CLAUDE_SESSION = "1fcd536a-ca43-43bf-8d03-a6ed74098343";
const CLAUDE_SUB = "ae2e0000000000001";

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
  const subCard = (page, paneId, id) => page.locator(`.react-flow__node-subagent[data-id="sub:${paneId}:${id}"]`);

  test("a running subagent shows as a card beside its agent", async (page) => {
    const sub = subCard(page, "w1:p1", CLAUDE_SUB);
    // The agent card shows a count; the cards themselves appear only on hover or selection.
    await waitFor(async () => (await textOf(card(page, "w1:p1").locator(".subagent-chip"))) === "1/1" || (await textOf(card(page, "w1:p1").locator(".subagent-chip"))), "a 1/1 subagent chip");
    assert((await sub.count()) === 0, "no card until the agent is hovered or selected");
    await card(page, "w1:p1").hover();
    await waitFor(async () => {
      const t = await textOf(sub);
      return (t.includes("Explore") && t.includes("running") && t.includes("Map the auth middleware") && t.includes("12k tokens · 2 tools")) || t;
    }, "a running Explore card");
    const parent = await card(page, "w1:p1").boundingBox();
    const box = await sub.boundingBox();
    assert(box.x >= parent.x + parent.width, "the card sits right of its agent's card");
    assert((await page.locator(".react-flow__node-pane .pane.agent").count()) === 6, "subagent cards aren't agent cards");
    // A card shown on hover may cover the next workspace's agent, so it lets clicks through.
    const neighbor = await card(page, "w2:p3").boundingBox();
    const hit = (b) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".react-flow__node")?.dataset.id, [b.x + b.width / 2, b.y + 10]);
    assert((await hit(neighbor)) === "w2:p3", "a hover-only card doesn't block the agent under it");
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    await page.locator(".react-flow__node-subagent.raised").first().waitFor();
    assert((await hit(neighbor)) === `sub:w1:p1:${CLAUDE_SUB}`, "selecting the agent brings its subagent cards forward");
  });

  test("clicking a subagent card shows its transcript without focusing anything", async (page) => {
    const sub = subCard(page, "w1:p1", CLAUDE_SUB);
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    await sub.waitFor({ timeout: 12_000 });
    clearActions();
    await sub.click();
    const transcript = page.locator('aside [aria-label="Subagent transcript"]');
    await waitFor(async () => {
      const t = await textOf(transcript);
      return (t.includes("→ Grep authMiddleware") && t.trimEnd().endsWith("Synthetic finding: the middleware lives in src/auth.ts.")) || t;
    }, "the subagent's messages, newest last");
    assert(actions().length === 0, `clicking a subagent must not focus the terminal, got ${actions()}`);
    assert((await sub.locator(".subagent.selected").count()) === 1, "the open card is outlined");
    await page.getByRole("button", { name: /Back to lead/ }).click();
    await page.getByRole("button", { name: "Unpin" }).waitFor();
    assert((await transcript.count()) === 0, "Back returns to the agent's preview");
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
    const child = subCard(page, "w2:p4", CODEX_CHILD);
    const grandchild = subCard(page, "w2:p4", CODEX_GRANDCHILD);
    await card(page, "w2:p4").click({ modifiers: ["Alt"] });
    await waitFor(async () => (await child.count()) > 0 && (await grandchild.count()) > 0, "both Codex subagent cards");
    const c = await textOf(child);
    assert(c.includes("reviewer") && c.includes("running") && c.includes("token cache review") && c.includes("42k tokens · 1 tool"), `unexpected card: ${c}`);
    const g = await textOf(grandchild);
    assert(g.includes("Noether") && g.includes("done · 40s") && g.includes("lint"), `unexpected nested card: ${g}`);
    const [cb, gb] = [await child.boundingBox(), await grandchild.boundingBox()];
    assert(gb.x > cb.x && gb.y > cb.y, "the nested subagent is indented under its parent");
    assert((await card(page, "w2:p4").locator(".review-chip").count()) === 1, "a running review shows as a chip");
    await child.click();
    await waitFor(async () => {
      const text = await textOf(page.locator('aside [aria-label="Subagent transcript"]'));
      return (text.includes("Synthetic review note.") && !text.includes("Synthetic parent history.")) || text;
    }, "the Codex subagent's own messages, without the history it copied from its parent");
  });

  // Last: the notification stays in the transcript for the rest of the run.
  test("a finished background subagent turns done with the numbers it reported", async (page) => {
    const sub = subCard(page, "w1:p1", CLAUDE_SUB);
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    await sub.waitFor({ timeout: 12_000 });
    const note = {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: new Date().toISOString(),
      content: `<task-notification>\n<tool-use-id>toolu_e2e_agent</tool-use-id>\n<status>completed</status>\n<usage><subagent_tokens>15000</subagent_tokens><tool_uses>3</tool_uses><duration_ms>42000</duration_ms></usage>\n</task-notification>`,
    };
    appendFileSync(join(TRANSCRIPTS, "claude", "projects", "-repos-w1", `${CLAUDE_SESSION}.jsonl`), `${JSON.stringify(note)}\n`);
    await waitFor(async () => {
      const t = await textOf(sub);
      return (t.includes("done") && t.includes("15k tokens · 3 tools")) || t;
    }, "a done card");
    assert((await sub.locator(".subagent.sub-done").count()) === 1, "the card takes the done color");
  });
}

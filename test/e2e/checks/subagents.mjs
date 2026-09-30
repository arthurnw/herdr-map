// Subagent cards, from the synthetic transcripts in
// ../transcripts and the Codex rollouts fixture.mjs writes at startup.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_CHILD, CODEX_GRANDCHILD, TRANSCRIPTS } from "../fixture.mjs";

const CLAUDE_SESSION = "1fcd536a-ca43-43bf-8d03-a6ed74098343";
const CLAUDE_SUB = "ae2e0000000000001";

export default function subagentChecks({ test, assert, card }) {
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
    await waitFor(async () => {
      const t = await textOf(sub);
      return (t.includes("Explore") && t.includes("running") && t.includes("Map the auth middleware") && t.includes("12k tokens · 2 tools")) || t;
    }, "a running Explore card");
    const parent = await card(page, "w1:p1").boundingBox();
    const box = await sub.boundingBox();
    assert(box.x >= parent.x + parent.width, "the card sits right of its agent's card");
    assert((await page.locator(".react-flow__node-pane .pane.agent").count()) === 6, "subagent cards aren't agent cards");
    assert((await textOf(card(page, "w1:p1").locator(".subagent-chip"))) === "1", "the agent card counts its running subagents");
    // Beside a packed workspace the card would cover the next agent, so it sits under other agents
    // until its own agent is selected.
    const neighbor = await card(page, "w2:p3").boundingBox();
    const hit = (b) => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".react-flow__node")?.dataset.id, [b.x + b.width / 2, b.y + 10]);
    assert((await hit(neighbor)) === "w2:p3", "another agent's card stays on top of the subagent card");
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    await page.locator(".react-flow__node-subagent.raised").first().waitFor();
    assert((await hit(neighbor)) === `sub:w1:p1:${CLAUDE_SUB}`, "selecting the agent brings its subagent cards forward");
  });

  test("Codex subagents show as a tree, and approval reviews as a chip", async (page) => {
    const child = subCard(page, "w2:p4", CODEX_CHILD);
    const grandchild = subCard(page, "w2:p4", CODEX_GRANDCHILD);
    await waitFor(async () => (await child.count()) > 0 && (await grandchild.count()) > 0, "both Codex subagent cards");
    const c = await textOf(child);
    assert(c.includes("reviewer") && c.includes("running") && c.includes("token cache review") && c.includes("42k tokens · 1 tool"), `unexpected card: ${c}`);
    const g = await textOf(grandchild);
    assert(g.includes("Noether") && g.includes("done · 40s") && g.includes("lint"), `unexpected nested card: ${g}`);
    const [cb, gb] = [await child.boundingBox(), await grandchild.boundingBox()];
    assert(gb.x > cb.x && gb.y > cb.y, "the nested subagent is indented under its parent");
    assert((await card(page, "w2:p4").locator(".review-chip").count()) === 1, "a running review shows as a chip");
  });

  // Last: the notification stays in the transcript for the rest of the run.
  test("a finished background subagent turns done with the numbers it reported", async (page) => {
    const sub = subCard(page, "w1:p1", CLAUDE_SUB);
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

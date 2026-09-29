// Context meter and cost, read by the usage probe from the synthetic transcripts in ../transcripts.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSCRIPTS } from "../fixture.mjs";

export default function usageChecks({ test, assert, card, base }) {
  // The probe runs every 5 s, so a change can take a full round to show.
  async function waitForText(locator, text, timeoutMs = 12_000) {
    const end = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < end) {
      last = (await locator.count()) ? await locator.first().textContent() : "";
      if (last.includes(text)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`expected "${text}", got "${last}"`);
  }

  const ctx = (page, paneId) => card(page, paneId).locator(".usage-ctx");

  test("agent cards show context use from each kind of transcript", async (page) => {
    await waitForText(ctx(page, "w1:p1"), "61% ctx");
    assert((await card(page, "w1:p1").locator(".usage-bar").count()) === 1, "a known window draws a bar");
    await waitForText(ctx(page, "w2:p4"), "50% ctx");
    await waitForText(card(page, "w4:p7").locator(".usage-ctx.high"), "85% ctx");
    // This Pi agent's model isn't in Pi's registry, so only tokens show.
    await waitForText(ctx(page, "w2:p3"), "43k ctx");
    assert((await card(page, "w2:p3").locator(".usage-bar").count()) === 0, "no window, no bar");
    const { probeError } = await (await fetch(`${base}/api/fleet`)).json();
    assert(probeError === undefined, `the probe should run cleanly, got ${probeError}`);
  });

  test("the preview shows context, cost, and model for a Pi agent", async (page) => {
    await card(page, "w5:p9").click({ modifiers: ["Alt"] });
    const line = page.locator('aside [aria-label="Usage"]');
    await waitForText(line, "109k of 272k context (40%)");
    const text = await line.textContent();
    assert(text.includes("$1.75 spent") && text.includes("gpt-6-luna"), `unexpected usage line: ${text}`);
  });

  test("a new turn in a working agent's transcript updates its meter", async (page) => {
    const file = join(TRANSCRIPTS, "claude", "projects", "-repos-w1", "1fcd536a-ca43-43bf-8d03-a6ed74098343.jsonl");
    const turn = (read) =>
      `${JSON.stringify({
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: 12_000 } },
      })}\n`;
    await waitForText(ctx(page, "w1:p1"), "61% ctx");
    appendFileSync(file, turn(888_000));
    try {
      await waitForText(card(page, "w1:p1").locator(".usage-ctx.high"), "90% ctx");
    } finally {
      appendFileSync(file, turn(600_000));
      await waitForText(ctx(page, "w1:p1"), "61% ctx");
    }
  });
}

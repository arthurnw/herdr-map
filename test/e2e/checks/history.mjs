// A pinned preview of a fullscreen agent: its history comes from its transcript, not herdr's scrollback.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function historyChecks({ test, assert, card, stubDir }) {
  test("a pinned fullscreen agent shows its transcript above the live screen, without scrolling it", async (page) => {
    const reads = join(stubDir, "reads.log");
    writeFileSync(reads, "");
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    const view = page.getByLabel("Screen preview");
    await view.locator(".history-divider").waitFor({ timeout: 10_000 });
    // Let the layout settle after the history arrives.
    await page.waitForTimeout(300);

    const layout = await view.evaluate((el) => {
      const history = el.querySelector(".preview-history");
      const divider = el.querySelector(".history-divider");
      const screen = el.querySelector(":scope > pre");
      return {
        historyFirst: !!(history.compareDocumentPosition(screen) & Node.DOCUMENT_POSITION_FOLLOWING),
        dividerText: divider.textContent,
        dividerLast: history.lastElementChild === divider,
        screen: screen.textContent,
        history: history.textContent,
        overflow: el.scrollHeight > el.clientHeight + 100,
        atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 24,
      };
    });
    assert(layout.historyFirst && layout.dividerLast && layout.dividerText === "Live screen", `history, then the divider, then the screen: ${JSON.stringify(layout)}`);
    assert(layout.screen.includes("screen of w1:p1"), `the live screen shows below the divider, got ${layout.screen}`);
    assert(layout.history.includes("Synthetic summary: the README is done.") && layout.history.includes("→ Edit /repos/w1/src/audit-log.ts"), "replies and tool calls show");
    assert(!layout.history.includes("Synthetic thinking.") && !layout.history.includes("Synthetic tool output.") && !layout.history.includes("Synthetic sidechain words."), "thinking, tool output, and subagents' lines are left out");
    assert(layout.overflow, "the history should be taller than the preview");
    assert(layout.atBottom, "the preview starts at the bottom");

    await view.evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(300);
    const first = view.locator(".history-prompt", { hasText: "Synthetic history prompt: start with the session cookie." });
    assert((await first.count()) === 1, "the oldest prompt is in the history");
    const inView = await first.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const area = el.closest('[aria-label="Screen preview"]').getBoundingClientRect();
      return box.top >= area.top && box.bottom <= area.bottom;
    });
    assert(inView, "scrolling up shows the oldest prompt");
    assert(await page.getByText("Paused").isVisible(), "scrolling up pauses refreshes");

    const log = readFileSync(reads, "utf8");
    assert(log.includes("pane read w1:p1 --source visible"), `the preview reads the visible screen, got ${log}`);
    assert(!log.includes("pane read w1:p1 --source recent"), `a fullscreen agent's scrollback must never be read, got ${log}`);
  });
}

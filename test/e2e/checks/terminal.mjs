// The preview draws the screen in its terminal colors, at native size, on a dark surface.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WIDE_LINE } from "../fixture.mjs";

export default function terminalChecks({ test, assert, card, stubDir }) {
  /** The preview's screen: its spans' colors, its text, and how it fits the sidebar. */
  const inspect = (page) =>
    page.getByLabel("Screen preview").evaluate((el, wide) => {
      const pre = el.querySelector(":scope > pre");
      const span = (text) => [...pre.querySelectorAll("span")].find((s) => s.textContent === text);
      const colors = (text) => {
        const s = span(text);
        return s ? { color: getComputedStyle(s).color, background: getComputedStyle(s).backgroundColor, weight: getComputedStyle(s).fontWeight } : undefined;
      };
      const wideSpan = span(wide);
      const before = el.scrollLeft;
      el.scrollLeft = 300;
      const scrolled = el.scrollLeft;
      el.scrollLeft = before;
      return {
        text: pre.textContent,
        error: colors("error:"),
        orange: colors("orange 256"),
        truecolor: colors("truecolor bg"),
        inverse: colors("inverse"),
        wideLines: wideSpan ? wideSpan.getClientRects().length : 0,
        whiteSpace: getComputedStyle(pre).whiteSpace,
        overflowX: el.scrollWidth - el.clientWidth,
        scrolled,
        surface: getComputedStyle(el).backgroundColor,
        screenBackground: getComputedStyle(pre).backgroundColor,
        screenColor: getComputedStyle(pre).color,
      };
    }, WIDE_LINE);

  async function checkScreen(page, where) {
    const view = page.getByLabel("Screen preview");
    await view.locator("span", { hasText: "orange 256" }).waitFor({ timeout: 5000 });
    const screen = await inspect(page);
    assert(screen.error?.color === "rgb(248, 113, 113)" && Number(screen.error.weight) >= 700, `${where}: bold red error, got ${JSON.stringify(screen.error)}`);
    assert(screen.orange?.color === "rgb(255, 135, 0)", `${where}: 256-color orange, got ${JSON.stringify(screen.orange)}`);
    assert(screen.truecolor?.background === "rgb(0, 95, 135)", `${where}: truecolor background, got ${JSON.stringify(screen.truecolor)}`);
    assert(
      screen.inverse?.color === "rgb(12, 12, 14)" && screen.inverse.background === "rgb(212, 212, 216)",
      `${where}: inverse swaps the default colors, got ${JSON.stringify(screen.inverse)}`,
    );
    assert(screen.text.includes("error: token cache <stale> & expired"), `${where}: text with < and & shows as typed, got ${screen.text}`);
    assert(![...screen.text].some((c) => (c < " " && c !== "\n" && c !== "\t") || c === "\u007f"), `${where}: no escape or control characters in the text: ${JSON.stringify(screen.text)}`);
    assert(!screen.text.includes("[?25l") && !screen.text.includes("codex\u0007") && !screen.text.includes("0;codex"), `${where}: other sequences are dropped: ${JSON.stringify(screen.text)}`);
    assert(screen.whiteSpace === "pre" && screen.wideLines === 1, `${where}: the wide line stays on one line, got ${JSON.stringify(screen)}`);
    assert(screen.overflowX > 300 && screen.scrolled > 0, `${where}: the screen scrolls sideways, got ${JSON.stringify(screen)}`);
    assert(screen.surface === "rgb(12, 12, 14)" && screen.screenColor === "rgb(212, 212, 216)", `${where}: dark surface, light text, got ${JSON.stringify(screen)}`);
    return screen;
  }

  test("the preview shows the screen in its terminal colors, scrolling sideways for wide lines", async (page) => {
    const reads = join(stubDir, "reads.log");
    writeFileSync(reads, "");
    await card(page, "w2:p4").hover();
    await checkScreen(page, "hover");
    assert(readFileSync(reads, "utf8").includes("pane read w2:p4 --source visible --lines 60 --format ansi"), "the hover preview asks for ANSI");

    await card(page, "w2:p4").click({ modifiers: ["Alt"] });
    await page.getByRole("button", { name: "Unpin" }).waitFor();
    await page.waitForTimeout(400);
    await checkScreen(page, "pinned");
    assert(readFileSync(reads, "utf8").includes("pane read w2:p4 --source recent --lines 1000 --format ansi"), "the pinned preview asks for ANSI scrollback");
  });

  test("the screen stays dark in the light theme", async (page) => {
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "Light" }).click();
    await page.keyboard.press("Escape");
    await card(page, "w2:p4").hover();
    const screen = await checkScreen(page, "light theme");
    const app = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert(app !== screen.surface, `the app itself is light, got ${app}`);
    assert(screen.error.color === "rgb(248, 113, 113)", "colors are drawn as sent, not remapped to the theme");
  });
}

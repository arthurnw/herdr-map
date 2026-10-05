// The preview's compact header, the tool a working agent is running, and the screen's links and tools.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { SCREEN_PATH, SCREEN_URL, TRANSCRIPTS } from "../fixture.mjs";

export default function previewChecks({ test, assert, card, detailTitle, base }) {
  async function waitUntil(fn, what, timeoutMs = 15_000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await fn();
      if (last) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  const details = (page) => page.locator('aside [aria-label="Pane details"]');
  const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
  const grantClipboard = (page) => page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });

  test("the preview header shows the agent's kind, name, status with its age, and a details line", async (page) => {
    await card(page, "w2:p4").click({ modifiers: ["Alt"] });
    const header = detailTitle(page);
    await header.waitFor();
    const mark = header.getByRole("img", { name: "Codex" });
    assert((await mark.textContent()) === "CX", `kind mark: ${await mark.textContent()}`);
    assert((await header.locator("h2").textContent()) === "Codex", `an unnamed agent goes by its kind, got ${await header.locator("h2").textContent()}`);
    const pill = await header.locator(".status-pill").textContent();
    assert(/^done \d+[smhd]/.test(pill), `status pill with its age: ${pill}`);
    for (const name of ["Star", "Open in terminal", "Unpin", "Refresh", "Rename agent"]) {
      assert((await header.getByRole("button", { name, exact: true }).count()) === 1, `the header has a ${name} button`);
    }
    // Git, context, and memory come from three probes that each take a round to report.
    await waitUntil(async () => (await details(page).locator(".git-pr").count()) && (await details(page).getByLabel("Memory").count()), "the details line to fill in", 20_000);
    const line = await details(page).textContent();
    for (const part of ["api-auth", "auth-tokens", "●3", "#42", "50% ctx", "195 MB"]) assert(line.includes(part), `details line has ${part}: ${line}`);
    // A line that wraps hides the dot before the first item on each line.
    const lineStarts = await details(page).evaluate((el) => {
      const left = el.getBoundingClientRect().left;
      const items = [...el.querySelectorAll(".preview-meta-items > *")];
      const tops = [...new Set(items.map((i) => Math.round(i.getBoundingClientRect().top)))];
      return tops.map((top) => {
        const first = items.find((i) => Math.round(i.getBoundingClientRect().top) === top);
        return first.getBoundingClientRect().left + parseFloat(getComputedStyle(first, "::before").width) - left;
      });
    });
    assert(lineStarts.every((x) => Math.abs(x) < 1), `each line's first item starts at the edge with its dot clipped: ${lineStarts}`);
    const where = await details(page).locator(".meta-ws").getAttribute("title");
    assert(where.startsWith("api-auth / agents\n/"), `the workspace's title has the tab and cwd: ${where}`);
  });

  test("a non-agent pane's header shows what it runs and where", async (page) => {
    await page.getByRole("button", { name: "View" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Only agent panes" }).click();
    await page.keyboard.press("Escape");
    await page.locator(".pane.tool", { hasText: "nvim billing.ts" }).hover();
    const header = detailTitle(page);
    await header.locator("h2", { hasText: "nvim billing.ts" }).waitFor();
    assert((await header.locator(".status-pill").count()) === 0, "no status for a non-agent pane");
    assert((await header.locator("svg").count()) >= 1, "a mark for what the pane runs");
    await details(page).locator(".git-line").waitFor({ timeout: 20_000 });
    const line = await details(page).textContent();
    assert(line.includes("api-billing") && line.includes("billing-retry"), `details line: ${line}`);
  });

  test("a working agent's preview and card say which tool it's running, and for how long", async (page) => {
    const file = join(TRANSCRIPTS, "claude", "projects", "-repos-w1", "1fcd536a-ca43-43bf-8d03-a6ed74098343.jsonl");
    const line = (o) => appendFileSync(file, `${JSON.stringify({ sessionId: "1fcd536a-ca43-43bf-8d03-a6ed74098343", isSidechain: false, ...o })}\n`);
    const usage = { input_tokens: 3, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 12_000, output_tokens: 40 };
    line({
      type: "assistant",
      timestamp: new Date(Date.now() - 42_000).toISOString(),
      message: { id: "msg_e2e_run", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_e2e_run", name: "Bash", input: { command: "npm test -- --grep auth" } }], usage },
    });
    try {
      await card(page, "w1:p1").hover();
      const running = page.locator('aside [aria-label="Current tool"]');
      await running.waitFor({ timeout: 15_000 });
      const text = await running.textContent();
      const seconds = Number(/· (\d+)s$/.exec(text)?.[1]);
      assert(text.startsWith("Running") && text.includes("Bash npm test -- --grep auth") && seconds >= 40 && seconds < 90, `running line: ${text}`);
      const { height } = await details(page).boundingBox();
      assert(height < 24, `a short details line stays on one line, got ${height}px`);
      const title = await card(page, "w1:p1").locator(".pane.agent").getAttribute("title");
      assert(title === "Running Bash npm test -- --grep auth", `card tooltip: ${title}`);
      assert((await card(page, "w2:p4").locator(".pane.agent").getAttribute("title")) === null, "an agent that isn't working has no tooltip");
    } finally {
      line({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_e2e_run", type: "tool_result", content: "Synthetic tool output." }] }, toolUseResult: { stdout: "" } });
    }
    await waitUntil(async () => (await page.locator('aside [aria-label="Current tool"]').count()) === 0, "the line to go once the tool returns");
  });

  test("URLs in the screen open in a new tab and keep their colors", async (page) => {
    await card(page, "w2:p4").hover();
    const url = page.getByLabel("Screen preview").locator("a.terminal-link");
    await url.waitFor({ timeout: 5000 });
    const link = await url.evaluate((a) => ({
      text: a.textContent,
      href: a.getAttribute("href"),
      target: a.target,
      rel: a.rel,
      pieces: [...a.children].map((s) => ({ text: s.textContent, color: getComputedStyle(s).color, weight: getComputedStyle(s).fontWeight })),
    }));
    assert(link.text === SCREEN_URL && link.href === SCREEN_URL && link.target === "_blank" && link.rel === "noreferrer", `link: ${JSON.stringify(link)}`);
    const cyan = "rgb(34, 211, 238)";
    assert(
      link.pieces.length === 3 && link.pieces.every((p) => p.color === cyan) && Number(link.pieces[1].weight) >= 700 && link.pieces[1].text === "token-cache",
      `the link keeps each run's color and weight: ${JSON.stringify(link.pieces)}`,
    );
  });

  test("clicking a path:line reference copies it, and look-alikes aren't references", async (page) => {
    await grantClipboard(page);
    await card(page, "w2:p4").hover();
    const refs = page.getByLabel("Screen preview").locator("[data-copy]");
    await refs.first().waitFor({ timeout: 5000 });
    const texts = await refs.allTextContents();
    assert(JSON.stringify(texts) === JSON.stringify([SCREEN_PATH, "src/token-cache.ts:42:7"]), `references: ${JSON.stringify(texts)}`);
    await refs.first().click();
    await page.getByText(`Copied ${SCREEN_PATH}`).waitFor({ timeout: 3000 });
    assert((await clipboard(page)) === SCREEN_PATH, `clipboard: ${await clipboard(page)}`);
    await refs.nth(1).click();
    await waitUntil(async () => (await clipboard(page)) === "src/token-cache.ts:42", "the reference without its column");
  });

  test("text selection runs across links and lines, and doesn't copy a reference", async (page) => {
    await grantClipboard(page);
    await page.evaluate(() => navigator.clipboard.writeText("untouched"));
    await card(page, "w2:p4").hover();
    const view = page.getByLabel("Screen preview");
    const refs = view.locator("[data-copy]");
    await refs.first().waitFor({ timeout: 5000 });
    const drag = async (from, to) => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (let i = 1; i <= 5; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 5, from.y + ((to.y - from.y) * i) / 5);
      await page.mouse.up();
      return page.evaluate(() => window.getSelection().toString());
    };
    const a = await refs.first().boundingBox();
    const b = await refs.nth(1).boundingBox();
    const fromRef = await drag({ x: a.x + 2, y: a.y + a.height / 2 }, { x: b.x + b.width - 2, y: b.y + b.height / 2 });
    assert(fromRef.includes("ache.ts:12") && fromRef.includes("\n") && fromRef.includes("at refresh"), `a drag from a reference selects across lines: ${JSON.stringify(fromRef)}`);
    const url = await view.locator("a.terminal-link").boundingBox();
    const acrossUrl = await drag({ x: url.x - 30, y: url.y + url.height / 2 }, { x: b.x + 10, y: b.y + b.height / 2 });
    assert(acrossUrl.includes(": https://example.com/token-cache?v=2. Changed") && acrossUrl.includes("\n  at"), `a drag across a URL selects it with the next line: ${JSON.stringify(acrossUrl)}`);
    await page.waitForTimeout(300);
    assert((await clipboard(page)) === "untouched", "ending a selection on a reference doesn't copy it");
  });

  test("Copy screen copies the screen as plain text", async (page) => {
    await grantClipboard(page);
    await card(page, "w2:p4").hover();
    const view = page.getByLabel("Screen preview");
    await view.locator("a.terminal-link").waitFor({ timeout: 5000 });
    await view.hover();
    await page.getByRole("button", { name: "Copy screen" }).click();
    await page.getByText("Copied screen").waitFor({ timeout: 3000 });
    const text = await clipboard(page);
    assert(text.includes("error: token cache <stale> & expired") && text.includes(`docs: ${SCREEN_URL}. Changed ${SCREEN_PATH}`), `copied: ${JSON.stringify(text)}`);
    assert(![...text].some((c) => (c < " " && c !== "\n" && c !== "\t") || c === "\u007f"), `no escape or control characters: ${JSON.stringify(text)}`);
  });

  test("scrolling up pauses a pinned preview, and Jump to bottom resumes it", async (page) => {
    await card(page, "w1:p1").click({ modifiers: ["Alt"] });
    const view = page.getByLabel("Screen preview");
    await view.locator(".history-divider").waitFor({ timeout: 10_000 });
    const tools = page.locator("aside .screen-tools");
    const jump = page.getByRole("button", { name: "Jump to bottom" });
    assert((await tools.textContent()).includes("Live") && (await jump.count()) === 0, "a preview at the bottom is live, with nothing to jump to");
    await view.evaluate((el) => (el.scrollTop = 0));
    await jump.waitFor({ timeout: 2000 });
    assert((await tools.textContent()).includes("Paused") && (await jump.isVisible()), "scrolling up shows Paused and Jump to bottom together");
    await jump.click();
    await waitUntil(async () => (await jump.count()) === 0 && (await tools.textContent()).includes("Live"), "Live again after the jump", 3000);
    const atBottom = await view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    assert(atBottom, "Jump to bottom scrolls to the bottom");
  });
}

// Stuck detection, finish markers, stars, and rename.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RATE_LIMIT_SCREEN } from "../fixture.mjs";

export default function attentionChecks({ test, assert, openPage, card, needsYouRow, actions, clearActions, stubDir, base }) {
  const screenFile = (paneId) => join(stubDir, "screens", `${paneId.replace(":", "_")}.txt`);

  async function waitFor(check, message, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(message);
  }

  const stuckInFleet = async (paneId) => {
    const { fleet } = await (await fetch(`${base}/api/fleet`)).json();
    for (const g of fleet.groups)
      for (const ws of g.workspaces)
        for (const t of ws.tabs) for (const p of t.panes) if (p.id === paneId) return !!p.agent?.stuck;
    return false;
  };

  // The server reads working agents' screens every 10 polls (3 s in these checks).
  async function withRateLimitedLead(fn) {
    writeFileSync(screenFile("w1:p1"), RATE_LIMIT_SCREEN);
    try {
      await waitFor(() => stuckInFleet("w1:p1"), "the server should flag the rate-limited agent");
      await fn();
    } finally {
      rmSync(screenFile("w1:p1"), { force: true });
      await waitFor(async () => !(await stuckInFleet("w1:p1")), "the stuck flag should clear once the banner is gone");
    }
  }

  test("a working agent with a rate-limit banner is flagged and listed after blocked", async (page) => {
    await withRateLimitedLead(async () => {
      const marker = card(page, "w1:p1").locator(".agent-stuck");
      await marker.waitFor({ timeout: 3000 });
      assert((await marker.textContent()).includes("rate limited"), `unexpected marker: ${await marker.textContent()}`);
      const rows = await page.locator("aside section").first().locator("li").allTextContents();
      assert(rows[0].includes("api-auth"), `blocked should come first, got ${rows[0]}`);
      assert(rows[1].includes("lead") && rows[1].includes("rate limited"), `stuck should come second, got ${rows[1]}`);
      // Earlier checks can leave other agents done, so only the order and the total are fixed.
      assert((await page.title()) === `(${rows.length}) herdr-map`, `unexpected title: ${await page.title()}`);
      await card(page, "w1:p1").click({ modifiers: ["Alt"] });
      await page.locator("aside").getByText("rate limited").nth(1).waitFor();
    });
  });

  test("an agent that starts to look stuck raises a notification in the background", async () => {
    const page = await openPage({ background: true });
    try {
      await page.waitForTimeout(600);
      await withRateLimitedLead(async () => {
        await page.waitForTimeout(600);
        const notes = await page.evaluate(() => window.__notifications);
        assert(notes.some((n) => n.title.includes("rate limited")), `expected a notification, got ${JSON.stringify(notes)}`);
      });
    } finally {
      await page.context().close();
    }
  });

  test("the Alerts menu has a Looks stuck option", async (page) => {
    await page.getByRole("button", { name: "Alerts" }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Looks stuck" });
    assert((await item.getAttribute("aria-checked")) === "true", "Looks stuck should be on by default");
    await item.click();
    assert((await item.getAttribute("aria-checked")) === "false", "clicking should turn it off");
  });

  test("workspaces with finished agents show a count, and done panes are outlined on the minimap", async (page) => {
    const marker = (ws) => page.locator(`.react-flow__node-workspace[data-id="ws:${ws}"] .ws-done`);
    assert((await marker("w2").textContent()).trim() === "1", "api-auth has one finished agent");
    assert((await marker("w4").textContent()).trim() === "1", "web has one finished agent");
    assert((await marker("w1").count()) === 0, "api has no finished agents");
    const strokes = await page.locator(".react-flow__minimap-node.status-done").evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).stroke),
    );
    assert(strokes.length >= 2 && strokes.every((s) => s && s !== "none"), `done panes should have a stroke, got ${strokes}`);
  });

  test("s stars the selected agent, g cycles through starred agents, and stars survive a reload", async (page) => {
    const starred = page.locator('aside section[aria-label="Starred"]');
    await needsYouRow(page, "stylist").click();
    await page.keyboard.press("s");
    await card(page, "w4:p7").locator(".agent-star").waitFor({ timeout: 2000 });
    assert((await starred.locator("li").count()) === 1, "the Starred section should list one agent");
    // The star button in the detail header stars the agent shown there.
    await needsYouRow(page, "api-auth").click();
    await page.locator("aside").getByRole("button", { name: "Star", exact: true }).click();
    assert((await starred.locator("li").count()) === 2, "the star button should add a second agent");
    await page.reload();
    await page.waitForSelector(".react-flow__node-pane");
    assert((await starred.locator("li").count()) === 2, "stars should survive a reload");
    const selected = () => starred.locator("li.bg-accent").textContent();
    await page.keyboard.press("g");
    await page.waitForTimeout(300);
    assert((await selected()).includes("stylist"), `g should select the first starred agent, got ${await selected()}`);
    await page.keyboard.press("g");
    await page.waitForTimeout(300);
    assert((await selected()).includes("api-auth"), `a second g should move on, got ${await selected()}`);
    await page.keyboard.press("s");
    await page.waitForTimeout(200);
    assert((await starred.locator("li").count()) === 1, "s on a starred agent should unstar it");
    assert((await card(page, "w2:p3").locator(".agent-star").count()) === 0, "the card should lose its star");
  });

  test("stars for panes that no longer exist are not shown", async (page) => {
    await page.evaluate(() => localStorage.setItem("herdr-map.stars", JSON.stringify(["w9:p99", "w5:p9"])));
    await page.reload();
    await page.waitForSelector(".react-flow__node-pane");
    const rows = await page.locator('aside section[aria-label="Starred"] li').allTextContents();
    assert(rows.length === 1, `expected one starred row, got ${rows.length}`);
  });
}

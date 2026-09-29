// Stuck detection, finish markers, stars, and rename.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RATE_LIMIT_SCREEN } from "../fixture.mjs";

export default function attentionChecks({ test, assert, openPage, card, actions, clearActions, stubDir, base }) {
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
}

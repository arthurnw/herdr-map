// Command palette, arrow-key movement between agent cards, and box selection.
import { readFileSync } from "node:fs";

export default function ({ test, assert, card, actions, clearActions, layoutFile }) {
  const palette = (page) => page.getByRole("dialog", { name: "Command palette" });
  const items = (page) => palette(page).locator("[cmdk-item]");
  const selectedPane = (page) => page.locator(".react-flow__node.selected-pane").getAttribute("data-id");

  test("palette: ⌘K opens it, s:blocked filters, Enter selects, ⌘Enter focuses", async (page) => {
    clearActions();
    await page.keyboard.press("Meta+k");
    await palette(page).waitFor();
    assert((await items(page).count()) > 6, "an empty query should list agents, workspaces, and commands");
    await page.keyboard.type("s:blocked");
    await page.waitForTimeout(150);
    assert((await items(page).count()) === 1, `s:blocked should leave one item, got ${await items(page).count()}`);
    assert((await items(page).first().textContent()).includes("api-auth"), "the blocked agent should be listed");
    await page.keyboard.press("Enter");
    await palette(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(500);
    assert((await selectedPane(page)) === "w2:p3", "Enter should select the agent on the map");
    assert(actions().length === 0, `Enter must not focus the terminal, got ${actions()}`);

    await page.getByRole("button", { name: "Command palette" }).click();
    await palette(page).waitFor();
    await page.keyboard.type("s:blocked");
    await page.waitForTimeout(150);
    await page.keyboard.press("Meta+Enter");
    await palette(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    assert(actions().includes("agent focus w2:p3"), `⌘Enter should focus the agent, got ${actions()}`);
  });

  test("palette: lists shortcuts and runs them", async (page) => {
    await page.keyboard.press("Control+k");
    await palette(page).waitFor();
    await page.keyboard.type("filter workspaces");
    await page.waitForTimeout(150);
    const row = items(page).filter({ hasText: "Filter workspaces" });
    assert((await row.locator("kbd").textContent()) === "/", "the command should show its key");
    await page.keyboard.press("Enter");
    await palette(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(200);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("placeholder"));
    assert(focused?.startsWith("Filter workspaces"), `running the command should focus the filter box, got ${focused}`);
  });
}

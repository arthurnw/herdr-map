// Command palette, arrow-key movement between agent cards, and box selection.
import { readFileSync } from "node:fs";

export default function ({ test, assert, card, needsYouRow, actions, clearActions, layoutFile }) {
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

  test("arrow keys move the selection between agent cards", async (page) => {
    clearActions();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    assert(await selectedPane(page), "the first arrow should select the agent nearest the middle of the view");

    await needsYouRow(page, "api-auth").click();
    await page.waitForTimeout(200);
    assert((await selectedPane(page)) === "w2:p3", "the Needs you row should select the blocked agent");
    const steps = [
      ["ArrowDown", "w2:p4"],
      ["ArrowRight", "w3:p5"],
      ["ArrowLeft", "w2:p3"],
      ["ArrowLeft", "w1:p1"],
      ["ArrowDown", "w4:p7"],
      ["ArrowUp", "w1:p1"],
    ];
    for (const [key, expected] of steps) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150);
      const got = await selectedPane(page);
      assert(got === expected, `${key} should select ${expected}, got ${got}`);
    }
    assert(actions().length === 0, `moving the selection must not focus the terminal, got ${actions()}`);
  });

  test("Shift+drag selects workspaces, and dragging one moves them all and saves", async (page) => {
    clearActions();
    const ws = (id) => page.locator(`.react-flow__node-workspace[data-id="ws:${id}"]`);
    const boxed = page.locator(".react-flow__node-workspace.box-selected");
    const [a, b, c] = await Promise.all(["w1", "w2", "w3"].map((id) => ws(id).boundingBox()));

    // From just outside api's top-left corner, on the repo box, to the middle of api-auth.
    await page.keyboard.down("Shift");
    await page.mouse.move(a.x - 6, a.y - 6);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(a.x - 6 + ((b.x + b.width / 2 - a.x + 6) * i) / 5, a.y - 6 + ((b.y + b.height / 2 - a.y + 6) * i) / 5);
    }
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.waitForTimeout(200);
    const ids = await boxed.evaluateAll((els) => els.map((e) => e.dataset.id).sort());
    assert(JSON.stringify(ids) === JSON.stringify(["ws:w1", "ws:w2"]), `expected api and api-auth selected, got ${ids}`);

    await page.mouse.move(a.x + 30, a.y + 6);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(a.x + 30 + i * 10, a.y + 6 + i * 8);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const [a2, b2, c2] = await Promise.all(["w1", "w2", "w3"].map((id) => ws(id).boundingBox()));
    const moved = (p, q) => [Math.round(q.x - p.x), Math.round(q.y - p.y)];
    assert(moved(a, a2)[0] > 20 && moved(a, a2)[1] > 20, `api should move, moved ${moved(a, a2)}`);
    assert(JSON.stringify(moved(a, a2)) === JSON.stringify(moved(b, b2)), `api-auth should move with api: ${moved(a, a2)} vs ${moved(b, b2)}`);
    assert(JSON.stringify(moved(c, c2)) === "[0,0]", `api-billing wasn't selected and should stay, moved ${moved(c, c2)}`);
    const saved = JSON.parse(readFileSync(layoutFile, "utf8")).current.workspaces;
    assert(saved.w1 && saved.w2 && saved.w3, `the drag should save every position, got ${JSON.stringify(saved)}`);
    assert(!saved.w1.detached && !saved.w2.detached, `workspaces moved together near their repo should stay in it, got ${JSON.stringify(saved)}`);
    assert(actions().length === 0, `a drag must not focus anything, got ${actions()}`);

    await card(page, "w2:p3").click();
    await page.waitForTimeout(300);
    assert(actions().includes("agent focus w2:p3"), `clicking a pane should still focus it, got ${actions()}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    assert((await boxed.count()) === 0, "Esc should clear the box selection");
  });
}

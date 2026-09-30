import { existsSync, readFileSync } from "node:fs";

// Moving agent cards within their tab in the agent-panes view.
export default ({ test, assert, card, actions, clearActions, layoutFile }) => {
  const cards = () => (existsSync(layoutFile) ? (JSON.parse(readFileSync(layoutFile, "utf8")).current?.cards ?? {}) : {});
  const tab = (page) => page.locator('.react-flow__node-tab[data-id="tab:w2:t1"]');
  const boxes = (page) => Promise.all(["w2:p3", "w2:p4"].map((id) => card(page, id).boundingBox()));
  const sideBySide = ([a, b]) => b.x >= a.x + a.width - 1 && Math.abs(b.y - a.y) < 2;
  const stacked = ([a, b]) => Math.abs(b.x - a.x) < 2 && b.y >= a.y + a.height - 1;

  test("dragging a card within its tab moves it, grows the tab after the drop, and saves", async (page) => {
    clearActions();
    const [upper, lower] = await boxes(page);
    const tabBefore = await tab(page).boundingBox();
    // Grabbed by its name line; the subagent chip lower down doesn't start drags.
    const from = { x: lower.x + lower.width / 4, y: lower.y + 12 };
    const to = { x: from.x + upper.width + 20, y: from.y - (lower.y - upper.y) };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // React Flow starts the drag from where the pointer passes its 1px threshold.
    await page.mouse.move(from.x + 2, from.y);
    await page.mouse.move(from.x, from.y);
    for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
    await page.waitForTimeout(200);
    const during = await tab(page).boundingBox();
    await page.mouse.up();
    await page.waitForTimeout(500);

    assert(Math.abs(during.width - tabBefore.width) < 1, "the tab should keep its size during the drag");
    assert(sideBySide(await boxes(page)), `w2:p4 should sit right of w2:p3, got ${JSON.stringify(await boxes(page))}`);
    const tabAfter = await tab(page).boundingBox();
    assert(tabAfter.width > tabBefore.width + upper.width / 2, `the tab should grow to hold the card, ${tabBefore.width} -> ${tabAfter.width}`);
    assert(actions().length === 0, `a drag must not focus anything, got ${actions()}`);
    const saved = cards();
    assert(saved["w2:p3"] && saved["w2:p4"], `both cards in the tab should be saved, got ${JSON.stringify(saved)}`);

    await page.reload();
    await page.waitForSelector(".react-flow__node-pane");
    await page.waitForTimeout(500);
    assert(sideBySide(await boxes(page)), "the arrangement should survive a reload");

    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(500);
    assert(stacked(await boxes(page)), `⌘Z should restack the cards, got ${JSON.stringify(await boxes(page))}`);
    assert(Object.keys(cards()).length === 0, "undo should clear the saved card positions");

    await page.keyboard.press("Meta+Shift+z");
    await page.waitForTimeout(500);
    assert(sideBySide(await boxes(page)), "redo should bring the move back");
    const ws = page.locator('.react-flow__node-workspace[data-id="ws:w2"]');
    await ws.locator(".ws-header").hover();
    await ws.getByRole("button", { name: "Actions for api-auth" }).click();
    await page.getByRole("menuitem", { name: "Restack cards" }).click();
    await page.waitForTimeout(500);
    assert(stacked(await boxes(page)), "Restack cards should put the cards back in a column");
    assert(!cards()["w2:p3"] && !cards()["w2:p4"], `Restack cards should clear the tab's positions, got ${JSON.stringify(cards())}`);
    // The reload fitted the wider map, so the zoom differs from the first measurement.
    const [first] = await boxes(page);
    assert((await tab(page).boundingBox()).width < first.width * 1.1, "the tab should shrink back to one card wide");
    assert(actions().length === 0, `none of this should focus anything, got ${actions()}`);
  });
};

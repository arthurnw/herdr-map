// The board view: status columns in place of the canvas, with the same filters, selection, and keys.
export default function boardChecks({ test, assert, chip, needsYouRow, actions, clearActions }) {
  const toggle = (page, name) => page.getByRole("group", { name: "Map or board" }).getByRole("button", { name });
  const column = (page, id) => page.locator(`.board-column[data-column="${id}"]`);
  const boardCard = (page, id) => page.locator(`.board-card[data-id="${id}"]`);
  const cardIds = (page, id) => column(page, id).locator(".board-card").evaluateAll((els) => els.map((e) => e.dataset.id));
  const count = async (page, id) => Number(await column(page, id).locator(".board-count").textContent());
  const selected = (page) => page.locator(".board-card.selected").getAttribute("data-id");
  const palette = (page) => page.getByRole("dialog", { name: "Command palette" });
  const columnIds = (page) => page.locator(".board-column").evaluateAll((els) => els.map((e) => e.dataset.column));

  // Earlier checks can leave an agent done (a finished turn stays done until focused), so the
  // expected columns come from the server's fleet rather than the fixture.
  async function expectedColumns(page) {
    const { fleet } = await page.evaluate(async () => (await fetch("/api/fleet")).json());
    const out = { needs: [], working: [], done: [], idle: [] };
    for (const g of fleet.groups)
      for (const ws of g.workspaces)
        for (const t of ws.tabs)
          for (const p of t.panes) {
            if (!p.agent) continue;
            const col = p.agent.status === "blocked" || p.agent.stuck ? "needs" : p.agent.status;
            (out[col] ??= []).push(p.id);
          }
    return out;
  }

  async function showBoard(page) {
    await toggle(page, "Board").click();
    await page.locator(".board").waitFor();
  }

  test("board: the toggle and b switch views, with a column per status", async (page) => {
    await showBoard(page);
    assert((await page.locator(".react-flow").count()) === 0, "the board should replace the canvas");
    const columns = await columnIds(page);
    assert(JSON.stringify(columns) === '["needs","working","done","idle"]', `no agent is unknown, so no Unknown column: ${columns}`);
    const expected = await expectedColumns(page);
    assert(expected.needs.includes("w2:p3") && expected.done.includes("w4:p7"), `unexpected fixture state: ${JSON.stringify(expected)}`);
    for (const [id, ids] of Object.entries(expected)) {
      assert((await count(page, id)) === ids.length, `${id} should count ${ids.length}, got ${await count(page, id)}`);
      const got = (await cardIds(page, id)).sort();
      assert(JSON.stringify(got) === JSON.stringify(ids.sort()), `${id} should hold ${ids}, got ${got}`);
    }
    const where = await boardCard(page, "w2:p3").locator(".board-where").textContent();
    assert(where.includes("api · api-auth") && where.includes("#42"), `the card should name its repo, workspace, and PR, got ${where}`);

    await page.keyboard.press("b");
    await page.locator(".react-flow__node-pane").first().waitFor();
    assert((await page.locator(".board").count()) === 0, "b should switch back to the map");
    assert((await toggle(page, "Map").getAttribute("aria-pressed")) === "true", "the Map button should be pressed");
    await page.keyboard.press("b");
    await page.locator(".board").waitFor();

    await page.keyboard.press("Meta+k");
    await palette(page).waitFor();
    await page.keyboard.type("map and board");
    const row = palette(page).locator("[cmdk-item]").filter({ hasText: "Switch between map and board" });
    assert((await row.locator("kbd").textContent()) === "b", "the palette should list the b shortcut");
  });

  test("board: status chips and the text filter hide cards", async (page) => {
    await showBoard(page);
    const done = await count(page, "done");
    assert((await count(page, "idle")) > 0, "the fixture has idle agents");
    await chip(page, "idle").click();
    await page.waitForTimeout(200);
    assert((await count(page, "idle")) === 0, "hiding idle should empty the Idle column");
    assert((await column(page, "idle").locator(".board-card").count()) === 0, "no idle cards should be drawn");
    assert((await count(page, "done")) === done && done > 0, "other columns keep their cards");
    await chip(page, "idle").click();
    await page.getByPlaceholder("Filter workspaces, agents, summaries").fill("billing");
    await page.waitForTimeout(200);
    const shown = await page.locator(".board-card").evaluateAll((els) => els.map((e) => e.dataset.id));
    assert(JSON.stringify(shown) === '["w3:p5"]', `only the api-billing agent should be left, got ${shown}`);
  });

  test("board: a click pins the preview, and double-click or o focuses", async (page) => {
    await showBoard(page);
    clearActions();
    await boardCard(page, "w3:p5").click();
    await page.getByRole("button", { name: "Unpin" }).waitFor();
    await page.waitForTimeout(300);
    assert(actions().length === 0, `a click must not focus the terminal, got ${actions()}`);
    assert((await selected(page)) === "w3:p5", "the clicked card should be outlined");
    await boardCard(page, "w5:p9").hover();
    await page.waitForTimeout(300);
    assert((await page.locator("aside h2").nth(1).textContent()).includes("api-billing"), "the pinned preview should stay while hovering");

    await page.keyboard.press("o");
    await page.waitForTimeout(300);
    assert(actions().includes("agent focus w3:p5"), `o should focus the selection, got ${actions()}`);
    clearActions();
    await boardCard(page, "w1:p1").dblclick();
    await page.waitForTimeout(300);
    assert(actions().includes("agent focus w1:p1"), `double-click should focus the agent, got ${actions()}`);
  });

  test("board: arrow keys move within and across columns", async (page) => {
    await showBoard(page);
    clearActions();
    const [needs, working, done] = await Promise.all(["needs", "working", "done"].map((id) => cardIds(page, id)));
    assert(needs.length && working.length && done.length > 1, "the fixture fills Needs you and Working, and Done with two or more");
    const last = done.length - 1;
    const steps = [
      ["ArrowRight", needs[0]],
      ["ArrowRight", working[0]],
      ["ArrowRight", done[0]],
      ["ArrowDown", done[1]],
      ...done.slice(2).map((id) => ["ArrowDown", id]),
      ["ArrowDown", done[last]],
      ["ArrowLeft", working[Math.min(last, working.length - 1)]],
      ["ArrowLeft", needs[Math.min(last, working.length - 1, needs.length - 1)]],
    ];
    for (const [key, expected] of steps) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150);
      const got = await selected(page);
      assert(got === expected, `${key} should select ${expected}, got ${got}`);
    }
    assert(actions().length === 0, `moving the selection must not focus the terminal, got ${actions()}`);
  });

  test("board: Needs you and the palette scroll the card into view on a narrow screen", async (page) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await showBoard(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `the page itself should not scroll sideways, overflows by ${overflow}px`);
    const inView = (id) =>
      page.evaluate((id) => {
        const board = document.querySelector(".board").getBoundingClientRect();
        const card = document.querySelector(`.board-card[data-id="${id}"]`).getBoundingClientRect();
        return card.left >= board.left - 1 && card.right <= board.right + 1;
      }, id);
    assert(!(await inView("w5:p9")), "the Idle column should start out of view");

    await page.keyboard.press("Meta+k");
    await palette(page).waitFor();
    await page.keyboard.type("web-redesign");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await palette(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(800);
    assert((await selected(page)) === "w5:p9", "Enter in the palette should select the agent's card");
    assert(await inView("w5:p9"), "the board should scroll to the selected card");

    await needsYouRow(page, "api-auth").click();
    await page.waitForTimeout(800);
    assert((await selected(page)) === "w2:p3", "the Needs you row should select the card");
    assert(await inView("w2:p3"), "the board should scroll back to the Needs you card");
  });

  test("board: the choice persists across a reload, and Map brings the canvas back", async (page) => {
    await showBoard(page);
    await page.reload();
    await page.locator(".board").waitFor();
    assert((await toggle(page, "Board").getAttribute("aria-pressed")) === "true", "Board should still be on after a reload");
    await toggle(page, "Map").click();
    await page.locator(".react-flow__node-pane").first().waitFor();
    assert((await page.locator(".board").count()) === 0, "Map should replace the board with the canvas");
    await page.reload();
    await page.locator(".react-flow__node-pane").first().waitFor();
    assert((await page.locator(".board").count()) === 0, "Map should still be on after a reload");
  });
}

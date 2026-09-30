import { existsSync, readFileSync } from "node:fs";

// Organizing the canvas: collapsing, colors, tags, notes, undo and redo, and bulk actions.
export default ({ test, assert, layoutFile, actions, clearActions }) => {
  const ws = (page, id) => page.locator(`.react-flow__node-workspace[data-id="ws:${id}"]`);
  const store = () => (existsSync(layoutFile) ? JSON.parse(readFileSync(layoutFile, "utf8")) : {});
  const menu = async (page, id, label) => {
    await ws(page, id).locator(".ws-header").hover();
    await ws(page, id).getByRole("button", { name: `Actions for ${label}` }).click();
  };

  test("organize: collapse a workspace to its header and expand it again", async (page) => {
    clearActions();
    const box = page.locator('.react-flow__node-group-box[data-id="group:/repos/api/.git"]');
    const before = await box.boundingBox();
    await menu(page, "w2", "api-auth");
    await page.getByRole("menuitem", { name: "Collapse to header" }).click();
    await page.waitForTimeout(400);
    assert(store().workspaces?.w2?.collapsed === true, `w2 should be saved as collapsed, got ${JSON.stringify(store().workspaces)}`);
    assert((await page.locator('.react-flow__node-pane[data-id="w2:p3"]').count()) === 0, "a collapsed workspace hides its panes");
    const counts = await ws(page, "w2").locator(".ws-status-counts").getAttribute("title");
    assert(counts?.includes("1 blocked"), `the header should count the blocked agent, got ${counts}`);
    const after = await box.boundingBox();
    assert(after.height < before.height, "the repo box should shrink");
    assert(actions().length === 0, "collapsing must not focus the workspace");

    await ws(page, "w2").locator(".ws-label").click();
    await page.waitForTimeout(300);
    assert(actions().includes("workspace focus w2"), `clicking a collapsed header focuses it, got ${actions()}`);

    await menu(page, "w2", "api-auth");
    await page.getByRole("menuitem", { name: "Expand" }).click();
    await page.waitForTimeout(400);
    assert(!store().workspaces?.w2, "expanding clears the saved flag");
    assert((await page.locator('.react-flow__node-pane[data-id="w2:p3"]').count()) === 1, "expanding shows the panes again");
  });

  test("organize: color a repo box and a workspace", async (page) => {
    const box = page.locator('.react-flow__node-group-box[data-id="group:/repos/api/.git"]');
    await box.locator(".group-header").hover();
    await page.getByRole("button", { name: "Color for api" }).click();
    await page.getByRole("menuitem", { name: "Teal" }).click();
    await page.waitForTimeout(400);
    assert(store().groups?.["/repos/api/.git"]?.color === "teal", `the box color should be saved, got ${JSON.stringify(store().groups)}`);
    assert(await box.locator(".group-box.tint-teal").count(), "the box should be tinted");
    await page.reload();
    await page.waitForSelector(".react-flow__node-pane");
    assert(await box.locator(".group-box.tint-teal").count(), "the tint should survive a reload");

    await menu(page, "w4", "web");
    await page.getByRole("menuitem", { name: "Color" }).click();
    await page.getByRole("menuitem", { name: "Pink" }).click();
    await page.waitForTimeout(400);
    assert(store().workspaces?.w4?.color === "pink", "the workspace color should be saved");
    assert(await ws(page, "w4").locator(".workspace.tint-pink").count(), "the workspace should be tinted");

    await box.locator(".group-header").hover();
    await page.getByRole("button", { name: "Color for api" }).click();
    await page.getByRole("menuitem", { name: "No color" }).click();
    await page.waitForTimeout(400);
    assert(!store().groups?.["/repos/api/.git"], "No color should clear the saved color");
  });

  test("organize: tag a workspace, then find it by tag in the filter and the palette", async (page) => {
    await menu(page, "w5", "web-redesign");
    await page.getByRole("menuitem", { name: "Add tag…" }).click();
    const input = ws(page, "w5").getByRole("textbox", { name: "New tag" });
    await input.waitFor();
    assert(await input.evaluate((el) => el === document.activeElement), "the tag input should take focus");
    await page.keyboard.type("Needs Review");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    assert(JSON.stringify(store().workspaces?.w5?.tags) === '["needs-review"]', `tag should be saved, got ${JSON.stringify(store().workspaces)}`);
    assert((await ws(page, "w5").locator(".ws-user-tag").textContent()) === "needs-review", "the header should show the tag");

    await page.getByPlaceholder("Filter workspaces, agents, summaries").fill("needs-rev");
    await page.waitForTimeout(200);
    const undimmed = await page.locator(".react-flow__node-workspace:not(.dim)").evaluateAll((els) => els.map((e) => e.dataset.id));
    assert(JSON.stringify(undimmed) === '["ws:w5"]', `the filter should match the tag, got ${undimmed}`);
    await page.getByPlaceholder("Filter workspaces, agents, summaries").fill("");

    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.waitFor();
    await page.keyboard.type("t:needs");
    await page.waitForTimeout(150);
    const rows = await palette.locator("[cmdk-item]").allTextContents();
    assert(rows.length === 2 && rows.every((r) => r.includes("web-redesign")), `t:needs should list the agent and workspace, got ${rows}`);
    await page.keyboard.press("Escape");

    await menu(page, "w5", "web-redesign");
    await page.getByRole("menuitem", { name: "Remove tag “needs-review”" }).click();
    await page.waitForTimeout(400);
    assert(!store().workspaces?.w5, "removing the last tag clears the metadata");
  });

  // A point on empty canvas, away from every node, panel, and the minimap.
  const emptySpot = (page) =>
    page.evaluate(() => {
      const r = document.querySelector(".react-flow").getBoundingClientRect();
      for (let y = r.top + 40; y < r.bottom - 40; y += 20)
        for (let x = r.left + 80; x < r.right - 260; x += 20) {
          const hits = [-30, 0, 30].flatMap((dx) => [-30, 0, 30].map((dy) => document.elementFromPoint(x + dx, y + dy)));
          if (hits.every((el) => el?.classList.contains("react-flow__pane"))) return { x, y };
        }
      return undefined;
    });

  test("organize: sticky notes are added, edited, moved, recolored, and deleted", async (page) => {
    clearActions();
    const spot = await emptySpot(page);
    assert(spot, "the map should have some empty canvas");
    await page.mouse.dblclick(spot.x, spot.y);
    const note = page.locator(".react-flow__node-note");
    await note.waitFor();
    const text = note.getByRole("textbox", { name: "Note text" });
    assert(await text.evaluate((el) => el === document.activeElement), "a new note should take focus");
    await page.keyboard.type("Check the deploy");
    // Typing doesn't trigger shortcuts: "n" would select from Needs you, "o" would open.
    assert(actions().length === 0, `typing in a note must not run shortcuts, got ${actions()}`);
    await page.waitForTimeout(900);
    assert(store().notes?.[0]?.text === "Check the deploy", `the text should be saved, got ${JSON.stringify(store().notes)}`);
    assert(Object.keys(store().current?.workspaces ?? {}).length === 0, "adding a note must not freeze the automatic layout");

    const start = await note.boundingBox();
    const before = store().notes[0];
    await page.mouse.move(start.x + 20, start.y + 8);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(start.x + 20 + i * 12, start.y + 8 + i * 10);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = store().notes[0];
    assert(after.x > before.x && after.y > before.y, `dragging the bar should move the note, ${JSON.stringify([before, after])}`);
    assert(Object.keys(store().current?.workspaces ?? {}).length === 0, "moving a note must not save workspace positions");
    assert(actions().length === 0, `moving a note must not focus anything, got ${actions()}`);

    await note.hover();
    await note.getByRole("button", { name: "Note color" }).click();
    await page.getByRole("menuitem", { name: "Blue" }).click();
    await page.waitForTimeout(400);
    assert(store().notes[0].color === "blue", "the note color should be saved");
    assert(await note.locator(".note.tint-blue").count(), "the note should be tinted");

    await page.reload();
    await page.waitForSelector(".react-flow__node-note");
    assert((await note.getByRole("textbox").inputValue()) === "Check the deploy", "the note should survive a reload");

    await note.hover();
    await note.getByRole("button", { name: "Delete note" }).click();
    await page.waitForTimeout(400);
    assert(store().notes.length === 0, "deleting should remove the note");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForTimeout(400);
    assert(store().notes[0]?.text === "Check the deploy", "Undo in the toast should bring the note back");
  });

  test("organize: the palette adds a note, and notes don't join box selections", async (page) => {
    await page.keyboard.press("Meta+k");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    await page.keyboard.type("new note");
    await page.keyboard.press("Enter");
    await page.locator(".react-flow__node-note").waitFor();
    await page.waitForTimeout(300);
    assert(store().notes?.length === 1, "the palette command should add a note");
    await page.keyboard.press("Escape");
    await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });

    // Shift+drag a box over the whole map: every workspace on the map is selected, and no note is.
    const r = await page.locator(".react-flow").boundingBox();
    await page.keyboard.down("Shift");
    await page.mouse.move(r.x + 4, r.y + 4);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.move(r.x + r.width - 4, r.y + r.height - 4);
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.waitForTimeout(200);
    const selected = await page.locator(".react-flow__node.box-selected").evaluateAll((els) => els.map((e) => e.dataset.id));
    const total = await page.locator(".react-flow__node-workspace").count();
    assert(selected.length === total && selected.every((id) => id.startsWith("ws:")), `expected all ${total} workspaces, got ${selected}`);
  });

  test("organize: ⌘Z undoes layout moves and ⇧⌘Z redoes them", async (page) => {
    const start = await ws(page, "w4").boundingBox();
    await page.mouse.move(start.x + 40, start.y + 8);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(start.x + 40 + i * 15, start.y + 8 + i * 15);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const moved = store().current.workspaces.w4;
    assert(moved, "the drag should save positions");

    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(400);
    assert(Object.keys(store().current.workspaces).length === 0, `undo should return to the automatic layout, got ${JSON.stringify(store().current)}`);
    const back = await ws(page, "w4").boundingBox();
    assert(Math.abs(back.x - start.x) < 1 && Math.abs(back.y - start.y) < 1, "the workspace should be back where it was");

    await page.keyboard.press("Meta+Shift+z");
    await page.waitForTimeout(400);
    assert(JSON.stringify(store().current.workspaces.w4) === JSON.stringify(moved), "redo should bring the move back");

    await menu(page, "w3", "api-billing");
    await page.getByRole("menuitem", { name: "Take out of the api box" }).click();
    await page.waitForTimeout(400);
    assert(store().current.workspaces.w3?.detached, "the menu should detach w3");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    assert(!store().current.workspaces.w3?.detached, "Ctrl+Z should undo taking it out of the box");
    assert((await ws(page, "w3").locator(".ws-repo-tag").count()) === 0, "the map should show it back in the box");

    // In a note, ⌘Z is the text field's own undo.
    const spot = await emptySpot(page);
    await page.mouse.dblclick(spot.x, spot.y);
    await page.locator(".react-flow__node-note textarea").waitFor();
    const before = JSON.stringify(store().current);
    await page.keyboard.type("x");
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(400);
    assert(JSON.stringify(store().current) === before, "⌘Z in a note must not undo the layout");
  });

  test("organize: bulk actions for box-selected workspaces", async (page) => {
    clearActions();
    const [a, b] = await Promise.all(["w1", "w2"].map((id) => ws(page, id).boundingBox()));
    await page.keyboard.down("Shift");
    await page.mouse.move(a.x - 6, a.y - 6);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x + b.width / 2) / 2, a.y + 20);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.up();
    await page.keyboard.up("Shift");
    const bar = page.getByRole("toolbar", { name: "Selected workspaces" });
    await bar.waitFor();
    assert((await bar.textContent()).includes("2 workspaces"), `the bar should count the selection, got ${await bar.textContent()}`);

    await bar.getByRole("button", { name: "Collapse" }).click();
    await page.waitForTimeout(400);
    const meta = () => store().workspaces ?? {};
    assert(meta().w1?.collapsed && meta().w2?.collapsed && !meta().w3, `both should collapse, got ${JSON.stringify(meta())}`);

    await bar.getByRole("button", { name: "Add tag" }).click();
    await page.keyboard.type("batch");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    assert(meta().w1?.tags?.includes("batch") && meta().w2?.tags?.includes("batch"), `both should be tagged, got ${JSON.stringify(meta())}`);
    assert((await page.locator(".react-flow__node.box-selected").count()) === 2, "Enter in the tag input keeps the selection");

    await bar.getByRole("button", { name: "Expand" }).click();
    await bar.getByRole("button", { name: "Take out of box" }).click();
    await page.waitForTimeout(500);
    const cur = () => store().current?.workspaces ?? {};
    assert(cur().w1?.detached && cur().w2?.detached && !cur().w3?.detached, `both should leave the box, got ${JSON.stringify(cur())}`);
    const [a2, b2] = await Promise.all(["w1", "w2"].map((id) => ws(page, id).boundingBox()));
    assert(Math.round(b2.x - a2.x) === Math.round(b.x - a.x), "workspaces taken out together keep their arrangement");
    assert(await bar.getByRole("button", { name: "Take out of box" }).isDisabled(), "the box's last workspace can't be taken out");

    await bar.getByRole("button", { name: "Put back in box" }).click();
    await page.waitForTimeout(500);
    assert(!cur().w1 && !cur().w2, `putting them back hands their positions to the box, got ${JSON.stringify(cur())}`);
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(400);
    assert(cur().w1?.detached && cur().w2?.detached, "one undo should take both out again");

    await bar.getByRole("button", { name: "Clear selection" }).click();
    await page.waitForTimeout(200);
    assert((await bar.count()) === 0 && (await page.locator(".react-flow__node.box-selected").count()) === 0, "Clear should end the selection");
    assert(actions().length === 0, `bulk actions must not focus anything, got ${actions()}`);
  });
};

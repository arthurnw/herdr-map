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
};

import { readFileSync } from "node:fs";

// Taking workspaces out of their repo box and putting them back.
export default ({ test, assert, layoutFile, actions, clearActions }) => {
  const ws = (page, id) => page.locator(`.react-flow__node-workspace[data-id="ws:${id}"]`);
  const saved = () => JSON.parse(readFileSync(layoutFile, "utf8")).current;

  test("the header menu takes a workspace out of its repo box and puts it back", async (page) => {
    clearActions();
    await ws(page, "w3").locator(".ws-header").hover();
    await ws(page, "w3").getByRole("button", { name: "Actions for api-billing" }).click();
    await page.getByRole("menuitem", { name: "Take out of the api box" }).click();
    await page.waitForTimeout(500);
    assert(saved().w3?.detached === true, `w3 should be detached, got ${JSON.stringify(saved().w3)}`);
    assert((await ws(page, "w3").locator(".ws-repo-tag").textContent()).includes("api"), "a detached workspace shows its repo");
    assert(actions().length === 0, "using the menu must not focus the workspace");
    await ws(page, "w3").locator(".ws-header").hover();
    await ws(page, "w3").getByRole("button", { name: "Actions for api-billing" }).click();
    await page.getByRole("menuitem", { name: "Put back in the api box" }).click();
    await page.waitForTimeout(500);
    assert(!saved().w3, "putting it back should hand its position back to the box");
    assert((await ws(page, "w3").locator(".ws-repo-tag").count()) === 0, "an attached workspace has no repo tag");
  });

  test("dragging a workspace away shows a drop hint and keeps the box in place", async (page) => {
    const box = page.locator('.react-flow__node-group-box[data-id="group:/repos/api/.git"]');
    const before = await box.boundingBox();
    const start = await ws(page, "w3").boundingBox();
    await page.mouse.move(start.x + 40, start.y + 8);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(start.x + 40, start.y + 8 + i * 45);
    await page.waitForTimeout(200);
    const hint = await ws(page, "w3").locator(".ws-drop-hint").textContent();
    const during = await box.boundingBox();
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert(hint.includes("take out of the api box"), `expected a detach hint, got ${hint}`);
    assert(during.height <= before.height + 1, "the repo box should not stretch to follow the drag");
    assert(saved().w3?.detached === true, "the drop should detach the workspace");
  });
};

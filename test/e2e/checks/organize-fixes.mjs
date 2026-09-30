// Collapse and expand all; note colors; ⌘Z bringing back a deleted note.
export default ({ test, assert }) => {
  test("View menu collapses and expands every workspace", async (page) => {
    const total = await page.locator(".react-flow__node-workspace").count();
    await page.getByRole("button", { name: "View" }).click();
    await page.getByRole("menuitem", { name: "Collapse all to their headers" }).click();
    await page.waitForTimeout(600);
    const collapsed = await page.locator(".react-flow__node-workspace .workspace.collapsed").count();
    assert(collapsed === total, `expected ${total} collapsed, got ${collapsed}`);
    await page.getByRole("button", { name: "View" }).click();
    await page.getByRole("menuitem", { name: "Expand all" }).click();
    await page.waitForTimeout(600);
    assert((await page.locator(".workspace.collapsed").count()) === 0, "expand all should expand everything");
  });

  test("picking a note color changes the note's color", async (page) => {
    await page.getByRole("button", { name: "New note" }).click();
    const note = page.locator(".react-flow__node-note .note").first();
    await note.waitFor();
    const before = await note.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.locator(".react-flow__node-note").first().hover();
    await page.getByRole("button", { name: "Note color" }).first().click();
    await page.getByRole("menuitem", { name: "Blue" }).click();
    await page.waitForTimeout(300);
    const after = await note.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert((await note.getAttribute("class")).includes("tint-blue"), "the note should get the blue class");
    assert(before !== after, `the background should change (${before} → ${after})`);
  });

  test("⌘Z brings back a deleted note", async (page) => {
    await page.getByRole("button", { name: "New note" }).click();
    await page.locator(".note-text").first().fill("keep me");
    await page.waitForTimeout(800);
    await page.locator(".react-flow__node-note").first().hover();
    await page.getByRole("button", { name: "Delete note" }).first().click();
    await page.waitForTimeout(300);
    assert((await page.locator(".react-flow__node-note").count()) === 0, "the note should be gone");
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(800);
    assert((await page.locator(".react-flow__node-note").count()) === 1, "⌘Z should restore the note");
    assert((await page.locator(".note-text").first().inputValue()) === "keep me", "with its text");
  });
};

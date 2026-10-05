// The preview's Changes tab, read by the changes probe from the fixture's temp repos.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLUGINS = { result: { plugins: [{ plugin_id: "jhochenbaum.hunkdiff", enabled: true }] } };

export default function changesChecks({ test, assert, card, actions, clearActions, stubDir }) {
  const header = (page, id) => page.locator(`.react-flow__node-workspace[data-id="ws:${id}"] .ws-header`);
  const tab = (page, name) => page.locator("aside").getByRole("tab", { name });
  const changes = (page) => page.locator("aside section[aria-label='Changes']");
  const scope = (page, name) => changes(page).getByRole("radio", { name });
  const fileRow = (page, path) => changes(page).locator(`li[data-path="${path}"]`);
  const text = async (locator) => ((await locator.count()) ? (await locator.first().textContent()).trim() : "");
  // The git probe's first run follows the server's first snapshot by about a second.
  const waitForPr = (page, id) => header(page, id).locator(".git-pr").waitFor({ timeout: 15_000 });

  async function openChanges(page, paneId, ws) {
    await waitForPr(page, ws);
    await card(page, paneId).click({ modifiers: ["Alt"] });
    await tab(page, "Changes").click();
    await changes(page).waitFor();
  }

  test("Changes lists a workspace's uncommitted files, and a file expands to its diff", async (page) => {
    await openChanges(page, "w2:p3", "w2");
    assert((await scope(page, "Uncommitted").getAttribute("aria-checked")) === "true", "a dirty worktree opens on Uncommitted");
    await fileRow(page, "auth.ts").waitFor();
    const summary = await text(changes(page).getByLabel("Changes summary"));
    assert(summary.includes("3 files") && summary.includes("+3") && summary.includes("−1") && summary.includes("auth-tokens") && summary.includes("↑2 ↓0"), `summary: ${summary}`);
    const paths = await changes(page).locator("li[data-path]").evaluateAll((els) => els.map((e) => e.dataset.path));
    assert(paths.join(",") === "auth.ts,notes.txt,staged.ts", `files: ${paths}`);
    const row = await text(fileRow(page, "auth.ts").locator("button"));
    assert(row.includes("M") && row.includes("+1") && row.includes("−1"), `auth.ts row: ${row}`);
    assert((await text(fileRow(page, "notes.txt").locator(".changes-status"))) === "?", "an untracked file is marked ?");
    assert((await text(fileRow(page, "staged.ts").locator(".changes-status"))) === "A", "a staged new file is marked A");

    await fileRow(page, "auth.ts").locator("button").click();
    const add = fileRow(page, "auth.ts").locator(".diff-add");
    await add.waitFor();
    assert((await text(add)).includes("changed"), `added line: ${await text(add)}`);
    assert((await text(fileRow(page, "auth.ts").locator(".diff-del"))).includes("auth.ts"), "the removed line is shown");
    const [addBg, delBg] = await Promise.all([add, fileRow(page, "auth.ts").locator(".diff-del")].map((l) => l.evaluate((e) => getComputedStyle(e).backgroundColor)));
    assert(addBg !== delBg && !addBg.includes("rgba(0, 0, 0, 0)"), `added and removed lines have their own backgrounds: ${addBg} / ${delBg}`);
    assert((await fileRow(page, "auth.ts").locator(".diff-hunk").count()) === 1, "one hunk header");

    await scope(page, "Branch").click();
    await fileRow(page, "refresh.ts").waitFor();
    const branchPaths = await changes(page).locator("li[data-path]").evaluateAll((els) => els.map((e) => e.dataset.path));
    assert(branchPaths.join(",") === "auth.ts,expiry.ts,notes.txt,refresh.ts,staged.ts", `branch files: ${branchPaths}`);
    const branchSummary = await text(changes(page).getByLabel("Changes summary"));
    assert(branchSummary.includes("3 commits since origin/main"), `branch summary: ${branchSummary}`);
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
  });

  test("Changes shows the PR with its failing check names, and a clean branch has no changes", async (page) => {
    await openChanges(page, "w3:p5", "w3");
    assert((await scope(page, "Branch").getAttribute("aria-checked")) === "true", "a clean worktree opens on Branch");
    const pr = changes(page).getByLabel("Pull request");
    await pr.waitFor();
    const shown = await text(pr);
    assert(shown.includes("#57") && shown.includes("Retry failed charges") && shown.includes("Draft") && shown.includes("1 passed, 1 failed"), `PR: ${shown}`);
    assert((await text(pr.getByLabel("Failing checks"))) === "test", `failing checks: ${await text(pr.getByLabel("Failing checks"))}`);
    await changes(page).getByText("No changes").waitFor();
  });

  test("Open in hunk runs the plugin's review action, and the tab choice survives a reload", async (page) => {
    try {
      writeFileSync(join(stubDir, "plugins.json"), JSON.stringify(PLUGINS));
      // The page checks for the plugin once per load.
      await page.reload();
      await openChanges(page, "w2:p3", "w2");
      const open = changes(page).getByRole("button", { name: "Open in hunk" });
      await open.waitFor();
      clearActions();
      await open.click();
      await page.waitForTimeout(400);
      const log = actions();
      assert(log.join("|") === "agent focus w2:p3|plugin action invoke review --plugin jhochenbaum.hunkdiff", `got ${log}`);
    } finally {
      rmSync(join(stubDir, "plugins.json"), { force: true });
    }
    await page.reload();
    await page.waitForSelector(".react-flow__node-pane");
    await card(page, "w2:p3").click({ modifiers: ["Alt"] });
    await changes(page).waitFor();
    assert((await tab(page, "Changes").getAttribute("aria-selected")) === "true", "Changes is still the tab after a reload");
    assert((await changes(page).getByRole("button", { name: "Open in hunk" }).count()) === 0, "no plugin, no button");
  });

  test("c switches between Screen and Changes, and the palette lists it", async (page) => {
    await card(page, "w2:p3").click({ modifiers: ["Alt"] });
    await tab(page, "Screen").waitFor();
    assert((await page.locator("aside [aria-label='Screen preview']").isVisible()) === true, "Screen is the default tab");
    await page.keyboard.press("c");
    await changes(page).waitFor();
    assert((await page.locator("aside [aria-label='Screen preview']").isVisible()) === false, "the screen is hidden on Changes");
    assert(await page.locator("aside textarea").first().isVisible(), "the reply box stays on Changes");
    await page.keyboard.press("c");
    await changes(page).waitFor({ state: "detached" });
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog");
    await palette.locator("[cmdk-input]").fill("switch the preview");
    const item = palette.locator("[cmdk-item]", { hasText: "Switch the preview between Screen and Changes" });
    await item.waitFor();
    assert((await text(item.locator("kbd"))) === "c", `palette row: ${await text(item)}`);
  });
}

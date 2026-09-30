// Branch, changes, and PR badges, read by the git probe from the fixture's temp repos with a stub gh.
export default function gitChecks({ test, assert, card, actions, clearActions }) {
  const header = (page, id) => page.locator(`.react-flow__node-workspace[data-id="ws:${id}"] .ws-header`);
  // The git probe's first run follows the server's first snapshot by about a second.
  const waitForPr = (page, id) => header(page, id).locator(".git-pr").waitFor({ timeout: 15_000 });
  const text = async (locator) => ((await locator.count()) ? (await locator.first().textContent()).trim() : "");

  test("workspace headers show branch, changes, ahead count, and the PR with its checks", async (page) => {
    await waitForPr(page, "w2");
    const w2 = header(page, "w2");
    assert((await text(w2.locator(".git-branch-name"))) === "auth-tokens", `w2 branch: ${await text(w2.locator(".git-branch-name"))}`);
    assert((await text(w2.locator(".git-dirty"))) === "●3", `w2 dirty: ${await text(w2.locator(".git-dirty"))}`);
    assert((await text(w2.locator(".git-ahead"))) === "↑2", `w2 ahead: ${await text(w2.locator(".git-ahead"))}`);
    assert((await w2.locator(".git-behind").count()) === 0, "nothing behind shows no ↓");
    assert((await text(w2.locator(".git-pr"))) === "#42", `w2 PR: ${await text(w2.locator(".git-pr"))}`);
    assert((await w2.locator(".git-pr .git-ci-pass").count()) === 1, "w2's checks pass");
    const title = await w2.locator(".git-pr").getAttribute("title");
    assert(title.includes("Add token refresh") && title.includes("Checks: 2 passed") && title.includes("approved"), `w2 PR title: ${title}`);
    assert((await w2.locator(".git-branch").getAttribute("title")).includes("2 ahead, 0 behind origin/auth-tokens"), "the branch title names the upstream");

    await waitForPr(page, "w3");
    const w3 = header(page, "w3");
    assert((await text(w3.locator(".git-pr"))) === "#57", `w3 PR: ${await text(w3.locator(".git-pr"))}`);
    assert((await w3.locator(".git-pr.pr-draft .git-ci-fail").count()) === 1, "w3's draft PR has failing checks");
    assert((await w3.locator(".git-dirty").count()) === 0, "a clean worktree shows no dirty count");

    await waitForPr(page, "w5");
    assert((await header(page, "w5").locator(".git-pr .git-ci-pending").count()) === 1, "w5's checks are pending");

    // The default branch gets no PR lookup, and workspaces outside a repo get no badge.
    assert((await text(header(page, "w1").locator(".git-branch-name"))) === "main", "w1 is on main");
    assert((await header(page, "w1").locator(".git-pr").count()) === 0, "main has no PR badge");
    for (const id of ["w4", "w6"]) assert((await header(page, id).locator(".git-branch").count()) === 0, `${id} is outside a repo`);
  });

  test("clicking a PR badge opens the PR in a new tab without focusing herdr or moving the map", async (page) => {
    await page.context().route("https://github.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>PR</title>" }));
    await waitForPr(page, "w2");
    const viewport = () => page.locator(".react-flow__viewport").getAttribute("style");
    const before = await viewport();
    clearActions();
    const [popup] = await Promise.all([page.context().waitForEvent("page"), header(page, "w2").locator(".git-pr").click()]);
    await popup.waitForLoadState();
    assert(popup.url() === "https://github.com/example/api/pull/42", `opened ${popup.url()}`);
    await page.waitForTimeout(400);
    assert(actions().length === 0, `a PR click must not reach herdr, got ${actions()}`);
    assert((await viewport()) === before, "a PR click must not pan or zoom the map");
  });

  test("the preview shows the workspace's branch and PR", async (page) => {
    await waitForPr(page, "w2");
    await card(page, "w2:p3").click({ modifiers: ["Alt"] });
    const line = page.locator("aside .git-line");
    await line.waitFor();
    const shown = await line.textContent();
    assert(shown.includes("auth-tokens") && shown.includes("●3") && shown.includes("#42"), `preview git line: ${shown}`);
  });
}

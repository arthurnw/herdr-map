// Palette prefixes for the workspace's PR, checks, and changes, and for agent memory, against the
// fixture's git repos (PRs #42 open and passing, #57 draft and failing, #88 pending) and canned `ps`.
export default function paletteChecks({ test, assert, card }) {
  const palette = (page) => page.getByRole("dialog", { name: "Command palette" });
  const items = (page) => palette(page).locator("[cmdk-item]");
  const values = (page) => items(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-value")));

  // The git and memory probes report a second or so after the server starts.
  async function openPalette(page) {
    await page.locator('.react-flow__node-workspace[data-id="ws:w5"] .git-pr').waitFor({ timeout: 15_000 });
    await card(page, "w4:p7").locator(".mem-chip").waitFor({ timeout: 20_000 });
    await page.keyboard.press("Meta+k");
    await palette(page).waitFor();
  }

  async function search(page, query) {
    await palette(page).locator("[cmdk-input]").fill(query);
    await page.waitForTimeout(150);
    return values(page);
  }

  // Agent order within a status depends on when the server first saw each one, so most checks compare sets.
  const same = (got, expected) => JSON.stringify([...got].sort()) === JSON.stringify([...expected].sort());

  test("palette: pr:, ci:, and dirty: narrow agents and workspaces by their workspace's repo", async (page) => {
    await openPalette(page);
    const cases = {
      "pr:open": ["agent:w2:p3", "agent:w2:p4", "agent:w5:p9", "ws:w2", "ws:w5"],
      "pr:draft": ["agent:w3:p5", "ws:w3"],
      "pr:none": ["agent:w1:p1", "agent:w4:p7", "ws:w1", "ws:w4", "ws:w6"],
      "pr:any": ["agent:w2:p3", "agent:w2:p4", "agent:w3:p5", "agent:w5:p9", "ws:w2", "ws:w3", "ws:w5"],
      "pr:merged": [],
      "pr:closed": [],
      "ci:pass": ["agent:w2:p3", "agent:w2:p4", "ws:w2"],
      "ci:fail": ["agent:w3:p5", "ws:w3"],
      "ci:pending": ["agent:w5:p9", "ws:w5"],
      "dirty:yes": ["agent:w2:p3", "agent:w2:p4", "ws:w2"],
      "dirty:no": ["agent:w1:p1", "agent:w3:p5", "agent:w5:p9", "ws:w1", "ws:w3", "ws:w5"],
      "pr:open ci:pending": ["agent:w5:p9", "ws:w5"],
      "pr:open s:blocked": ["agent:w2:p3"],
      "pr:any dirty:no a:codex": ["agent:w3:p5"],
      "ci:pass auth": ["agent:w2:p3", "agent:w2:p4", "ws:w2"],
    };
    for (const [query, expected] of Object.entries(cases)) {
      const got = await search(page, query);
      assert(same(got, expected), `${query}: expected ${expected}, got ${got}`);
      assert((await palette(page).locator('[aria-label="Memory"]').count()) === 0, `${query} shouldn't show memory figures`);
    }
    await search(page, "pr:merged");
    assert(await palette(page).getByText("No matches.").isVisible(), "pr:merged should say there are no matches");
  });

  test("palette: mem: keeps agents over or under a threshold and shows their memory", async (page) => {
    await openPalette(page);
    const rows = async () =>
      items(page).evaluateAll((els) => els.map((e) => [e.getAttribute("data-value"), e.querySelector('[aria-label="Memory"]')?.textContent ?? ""].join(" ")));
    const cases = {
      "mem:>1g": ["agent:w4:p7 2.2 GB"],
      "mem:<300m": ["agent:w2:p3 265 MB", "agent:w2:p4 195 MB"],
      "mem:>200m mem:<300m": ["agent:w2:p3 265 MB"],
      "mem:>200m ci:pass": ["agent:w2:p3 265 MB"],
      "mem:>=335m pi": ["agent:w5:p9 335 MB"],
      "mem:>4g": [],
    };
    for (const [query, expected] of Object.entries(cases)) {
      await search(page, query);
      const got = await rows();
      assert(JSON.stringify(got) === JSON.stringify(expected), `${query}: expected ${expected}, got ${got}`);
    }
    await search(page, "mem:>1g");
    const figure = palette(page).locator('[aria-label="Memory"]');
    assert((await figure.getAttribute("title")).startsWith("2.2 GB in 4 processes"), `figure title: ${await figure.getAttribute("title")}`);
  });

  test("palette: Sort agents by memory orders agents heaviest first with their figures", async (page) => {
    await openPalette(page);
    const footer = await palette(page).locator('[aria-label="Prefixes"]').textContent();
    for (const prefix of ["s:", "a:", "w:", "t:", "pr:", "ci:", "dirty:", "mem:", "sort:mem"])
      assert(footer.includes(prefix), `the hints should list ${prefix}, got ${footer}`);

    await search(page, "sort agents by memory");
    assert((await values(page))[0] === "cmd:sort:mem", `the command should be listed first, got ${await values(page)}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    assert(await palette(page).isVisible(), "sorting should keep the palette open");
    const input = palette(page).locator("[cmdk-input]");
    assert((await input.inputValue()) === "sort:mem ", `the command should type sort:mem, got "${await input.inputValue()}"`);
    const agents = await items(page).evaluateAll((els) =>
      els
        .filter((e) => e.getAttribute("data-value").startsWith("agent:"))
        .map((e) => [e.getAttribute("data-value"), e.querySelector('[aria-label="Memory"]')?.textContent ?? "-"].join(" ")),
    );
    const measured = ["agent:w4:p7 2.2 GB", "agent:w5:p9 335 MB", "agent:w2:p3 265 MB", "agent:w2:p4 195 MB"];
    // Unmeasured agents keep the default order, which depends on statuses earlier checks left behind.
    const unmeasured = ["agent:w1:p1 -", "agent:w3:p5 -"];
    const ok =
      JSON.stringify(agents.slice(0, measured.length)) === JSON.stringify(measured) &&
      JSON.stringify(agents.slice(measured.length).sort()) === JSON.stringify(unmeasured);
    assert(ok, `sorted agents: ${agents}`);
    assert((await values(page)).includes("ws:w1"), "sorting doesn't hide workspaces");
    assert((await items(page).first().getAttribute("aria-selected")) === "true", "the heaviest agent should be selected");
    assert((await palette(page).locator("[cmdk-list]").evaluate((e) => e.scrollTop)) === 0, "the list should scroll back to the top");

    // The same command, now checked, takes the sort out again.
    await input.press("End");
    await page.keyboard.type("by memory");
    await page.waitForTimeout(150);
    const command = items(page).filter({ hasText: "Sort agents by memory" });
    assert(!(await command.locator("svg").first().getAttribute("class")).includes("invisible"), "the command should be checked while sorting");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert((await input.inputValue()) === "", `the command should clear sort:mem and its search, got "${await input.inputValue()}"`);
    assert((await items(page).count()) > 6, "the full list should be back");
    assert((await palette(page).locator('[aria-label="Memory"]').count()) === 0, "no figures without the sort");
  });
}

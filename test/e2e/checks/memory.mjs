// Memory figures, measured by the memory probe from the canned `ps` output in ../fixture.mjs.
export default function memoryChecks({ test, assert, card, base }) {
  // The memory probe runs every 15 s; its first run is a second after the server starts.
  async function waitFor(locator, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await locator.count()) return locator.first();
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${locator}`);
  }

  test("agent cards show memory, amber over 2 GB, with the heaviest processes in the title", async (page) => {
    const heavy = await waitFor(card(page, "w4:p7").locator(".mem-chip.high"));
    assert((await heavy.textContent()) === "· 2.2 GB", `unexpected figure: ${await heavy.textContent()}`);
    const title = await heavy.getAttribute("title");
    assert(title === "2.2 GB in 4 processes: claude 1.4 GB, node ×2 800 MB, zsh 6 MB", `unexpected title: ${title}`);
    const pi = card(page, "w2:p3").locator(".mem-chip");
    assert((await pi.textContent()) === "· 265 MB" && !(await pi.getAttribute("class")).includes("high"), "a light agent isn't amber");
    assert((await card(page, "w2:p4").locator(".mem-chip").textContent()) === "· 195 MB", "a child process counts toward its agent");
    assert((await card(page, "w1:p1").locator(".mem-chip").count()) === 0, "no process info, no figure");
  });

  test("the preview lists memory and the heaviest processes", async (page) => {
    await waitFor(card(page, "w4:p7").locator(".mem-chip"));
    await card(page, "w4:p7").click({ modifiers: ["Alt"] });
    const line = await waitFor(page.locator('aside [aria-label="Memory"]'));
    const text = await line.textContent();
    assert(text === "2.2 GB memory in 4 processes · claude 1.4 GB · node ×2 800 MB · zsh 6 MB", `unexpected memory line: ${text}`);
  });

  test("the toolbar totals memory across agents and names the heaviest", async (page) => {
    const total = await waitFor(page.locator('header [aria-label="Agent memory"]'));
    const text = await total.textContent();
    assert(/^2\.9 GB\(\d+%\)$/.test(text), `unexpected total: ${text}`);
    const title = await total.getAttribute("title");
    const lines = title.split("\n");
    assert(/^Agents use 2\.9 GB of .+ \(\d+%\) across 4 agents$/.test(lines[0]), `unexpected summary: ${lines[0]}`);
    assert(
      lines.slice(1).join("|") === "Heaviest:|stylist (web): 2.2 GB|Pi (web-redesign): 335 MB|Pi (api-auth): 265 MB|Codex (api-auth): 195 MB",
      `unexpected heaviest list: ${title}`,
    );
    const { fleet } = await (await fetch(`${base}/api/fleet`)).json();
    assert(fleet.memory.bytes === 3001 * 1024 * 1024 && fleet.memory.agents === 4, `unexpected fleet total: ${JSON.stringify(fleet.memory)}`);
  });
}

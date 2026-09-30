// Agents working together: handoff edges and the queue's pause.
export default function togetherChecks({ test, assert, card, actions, clearActions, writeSnapshot, snapshot, setStatus, base }) {
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };

  // The queue lives in its own file, which openPage doesn't reset.
  async function resetAutomation() {
    const state = await api("GET", "/api/automation");
    for (const item of state.items) await api("POST", `/api/queue/${item.id}/cancel`);
    for (const l of state.links ?? []) await api("DELETE", `/api/links/${l.id}`);
    await api("POST", "/api/automation/pause", { paused: false });
  }

  async function waitFor(check, message, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(message);
  }

  const promptsTo = (pane) => actions().filter((a) => a.startsWith(`agent prompt ${pane} `));
  const savedLinks = async () => (await api("GET", "/api/links"));

  /** Drags from a node's link dot onto an agent card. */
  async function drawLink(page, fromNode, toPane) {
    await fromNode.hover();
    const dot = fromNode.locator(".link-source");
    const from = await dot.boundingBox();
    const to = await card(page, toPane).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await page.mouse.move(
        from.x + (to.x + to.width / 2 - from.x) * t,
        from.y + (to.y + to.height / 2 - from.y) * t,
      );
    }
    await page.mouse.up();
  }

  async function withReset(fn) {
    await resetAutomation();
    try {
      await fn();
    } finally {
      writeSnapshot(snapshot());
      await resetAutomation();
    }
  }

  test("together: a handoff edge prompts the target with the source's output once it's idle", async (page) =>
    withReset(async () => {
      // w5:p9 (A) is working and w1:p1 (B, "lead") is working in the fixture.
      writeSnapshot(setStatus(snapshot(), "w5:p9", "working"));
      await page.waitForTimeout(800);
      clearActions();
      await drawLink(page, card(page, "w5:p9"), "w1:p1");
      await page.getByRole("button", { name: /^Handoff/ }).click();
      await waitFor(async () => (await savedLinks()).length === 1, "the handoff should be saved");
      const [link] = await savedLinks();
      assert(link.kind === "handoff" && link.from.id === "w5:p9" && link.to.id === "w1:p1", `unexpected link ${JSON.stringify(link)}`);
      await page.locator(".react-flow__edge.link-handoff").waitFor({ timeout: 3000 });
      assert(!actions().some((a) => a.startsWith("agent focus")), `drawing a link must not focus anything: ${actions()}`);

      // A finishes; B is still working, so the handoff waits in the queue.
      writeSnapshot(setStatus(setStatus(snapshot(), "w5:p9", "idle"), "w1:p1", "working"));
      await waitFor(
        async () => (await api("GET", "/api/automation")).items.some((i) => i.target === "w1:p1" && i.source.kind === "handoff"),
        "A finishing should queue a handoff for B",
      );
      await page.locator('[data-testid="queue-count"]').waitFor({ timeout: 4000 });
      assert(promptsTo("w1:p1").length === 0, `nothing goes to a working agent: ${actions()}`);

      // B goes idle: the handoff is delivered, once.
      writeSnapshot(setStatus(setStatus(snapshot(), "w5:p9", "idle"), "w1:p1", "idle"));
      await waitFor(() => promptsTo("w1:p1").length > 0, "the handoff should reach B once it's idle");
      const [prompt] = promptsTo("w1:p1");
      assert(prompt.includes("Handoff from") && prompt.includes("pane w5:p9"), `unexpected prompt: ${prompt}`);
      assert(actions().some((a) => a.includes("screen of w5:p9")), "the handoff should carry A's output");
      await page.waitForTimeout(3500);
      assert(promptsTo("w1:p1").length === 1, `the same turn must not hand off twice: ${promptsTo("w1:p1")}`);
      const state = await api("GET", "/api/automation");
      assert(state.items.length === 0 && state.history.at(-1)?.target === "w1:p1", "the delivery should move to the history");
    }));

  test("together: pausing stops delivery until resumed", async (page) =>
    withReset(async () => {
      clearActions();
      await page.getByRole("button", { name: "Pause automation" }).click();
      await page.getByRole("button", { name: "Resume automation" }).waitFor();
      await api("POST", "/api/queue", { target: "w5:p9", text: "queued while paused" });
      await page.waitForTimeout(4500);
      assert(promptsTo("w5:p9").length === 0, `nothing is sent while paused: ${actions()}`);
      await page.getByRole("button", { name: /^Queue, 1 waiting/ }).click();
      await page.locator('[data-testid="queue-item"]').getByText("Paused", { exact: true }).waitFor({ timeout: 3000 });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Resume automation" }).click();
      await waitFor(() => promptsTo("w5:p9").length === 1, "resuming should deliver the queued prompt");
    }));
}

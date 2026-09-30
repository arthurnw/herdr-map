// Agents working together: handoff edges, context links, note links, the queue's pause,
// and schedules that wait to be armed.
export default function togetherChecks({ test, assert, card, actions, clearActions, writeSnapshot, snapshot, setStatus, base }) {
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };

  // The queue and schedules live in their own file, which openPage doesn't reset.
  async function resetAutomation() {
    const state = await api("GET", "/api/automation");
    for (const item of state.items) await api("POST", `/api/queue/${item.id}/cancel`);
    for (const s of state.schedules ?? []) await api("DELETE", `/api/schedules/${s.id}`);
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

  /** Drags from a node's link dot to the middle of an agent card, and holds the button down. */
  async function dragLinkOver(page, fromNode, toPane) {
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
  }

  /** Drags from a node's link dot onto an agent card. */
  async function drawLink(page, fromNode, toPane) {
    await dragLinkOver(page, fromNode, toPane);
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

  test("together: a handoff edge prompts the target with the source's final reply once it's idle", async (page) =>
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
      assert(prompt.includes("Handoff from") && prompt.includes("pane w5:p9") && prompt.includes("Its final reply:"), `unexpected prompt: ${prompt}`);
      // A's final reply from its synthetic transcript, not its screen or the turn's earlier text.
      assert(actions().includes("Synthetic final reply: the redesign is ready for review."), `the handoff should carry A's final reply: ${actions()}`);
      assert(!actions().some((a) => a.includes("screen of w5:p9") || a.includes("Synthetic narration")), `the handoff should not carry A's screen: ${actions()}`);
      await page.waitForTimeout(3500);
      assert(promptsTo("w1:p1").length === 1, `the same turn must not hand off twice: ${promptsTo("w1:p1")}`);
      const state = await api("GET", "/api/automation");
      assert(state.items.length === 0 && state.history.at(-1)?.target === "w1:p1", "the delivery should move to the history");
    }));

  test("together: a handoff between stacked agents runs straight down between them, with an arrowhead in its color", async (page) =>
    withReset(async () => {
      // w2:p3 sits directly above w2:p4 in their tab.
      await drawLink(page, card(page, "w2:p3"), "w2:p4");
      await page.getByRole("button", { name: /^Handoff/ }).click();
      const path = page.locator(".react-flow__edge.link-handoff path.link-path");
      // A straight vertical path has no width, so Playwright never counts it as visible.
      await path.waitFor({ state: "attached", timeout: 3000 });
      const upper = await card(page, "w2:p3").boundingBox();
      const lower = await card(page, "w2:p4").boundingBox();
      assert(upper.y + upper.height <= lower.y, `the fixture agents should be stacked: ${JSON.stringify([upper, lower])}`);
      const box = await path.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      const left = Math.min(upper.x, lower.x);
      const right = Math.max(upper.x + upper.width, lower.x + lower.width);
      assert(box.x >= left - 1 && box.x + box.width <= right + 1, `the edge should stay within the cards' span: ${JSON.stringify(box)}`);
      assert(box.y >= upper.y + upper.height / 2 && box.y + box.height <= lower.y + lower.height / 2, `the edge should run between the cards: ${JSON.stringify(box)}`);

      const colors = () =>
        path.evaluate((el) => {
          const marker = document.getElementById(el.getAttribute("marker-end").match(/#([^')]+)/)[1]);
          return [getComputedStyle(el).stroke, marker && getComputedStyle(marker.querySelector("polyline")).fill];
        });
      let [stroke, fill] = await colors();
      assert(stroke === fill, `the arrowhead should match the edge in dark mode: ${stroke} vs ${fill}`);
      await page.getByRole("button", { name: "Theme" }).click();
      await page.getByRole("menuitemradio", { name: "Light" }).click();
      await page.waitForTimeout(200);
      const dark = stroke;
      [stroke, fill] = await colors();
      assert(stroke === fill && stroke !== dark, `the arrowhead should match the edge in light mode: ${stroke} vs ${fill}`);
    }));

  test("together: while a link is drawn over a card, it ends on the side it will attach to", async (page) =>
    withReset(async () => {
      await dragLinkOver(page, card(page, "w2:p3"), "w2:p4");
      const line = page.locator(".react-flow__connection-path");
      await line.waitFor({ state: "attached", timeout: 3000 });
      // The path's end points, in screen pixels.
      const [start, end] = await line.evaluate((el) => {
        const nums = el.getAttribute("d").match(/-?\d+(\.\d+)?(e-?\d+)?/g).map(Number);
        const m = el.getScreenCTM();
        const at = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
        return [at(nums[0], nums[1]), at(nums.at(-2), nums.at(-1))];
      });
      const upper = await card(page, "w2:p3").boundingBox();
      const lower = await card(page, "w2:p4").boundingBox();
      const near = (a, b) => Math.abs(a - b) <= 2;
      assert(near(start.y, upper.y + upper.height), `the line should leave the upper card's bottom: ${JSON.stringify({ start, upper })}`);
      assert(near(end.y, lower.y), `the line should end on the lower card's top, not its middle: ${JSON.stringify({ end, lower })}`);
      assert(end.x >= lower.x && end.x <= lower.x + lower.width, `the line should end within the lower card's span: ${JSON.stringify({ end, lower })}`);
      const arrow = await line.evaluate((el) => !!document.getElementById(el.getAttribute("marker-end").match(/#([^')]+)/)[1]));
      assert(arrow, "the line should have an arrowhead");

      await page.mouse.up();
      await page.getByRole("button", { name: /^Handoff/ }).click();
      await waitFor(async () => (await savedLinks()).length === 1, "the handoff should be saved");
      const [link] = await savedLinks();
      assert(link.kind === "handoff" && link.from.id === "w2:p3" && link.to.id === "w2:p4", `unexpected link ${JSON.stringify(link)}`);
      await page.locator(".react-flow__edge.link-handoff").waitFor({ state: "attached", timeout: 3000 });
    }));

  test("together: a context link sends the read instructions once, and its menu removes it", async (page) =>
    withReset(async () => {
      clearActions();
      await drawLink(page, card(page, "w3:p5"), "w5:p9");
      await page.getByRole("button", { name: /^Context link/ }).click();
      await waitFor(() => promptsTo("w5:p9").length > 0, "the context link should prompt the target");
      assert(promptsTo("w5:p9")[0].includes("herdr agent read w3:p5 --lines 200"), `unexpected prompt: ${promptsTo("w5:p9")}`);
      await page.waitForTimeout(3000);
      assert(promptsTo("w5:p9").length === 1, `a context link sends once: ${promptsTo("w5:p9")}`);
      const edge = page.locator(".react-flow__edge.link-context");
      await edge.waitFor({ timeout: 3000 });
      await page.getByRole("button", { name: "context link" }).click();
      await page.getByRole("menuitem", { name: "Remove link" }).click();
      await waitFor(async () => (await savedLinks()).length === 0, "Remove link should delete the link");
      await edge.waitFor({ state: "detached", timeout: 3000 });
    }));

  test("together: a note dragged to an agent sends its text, shows where it went, and can send an edit", async (page) =>
    withReset(async () => {
      await api("POST", "/api/notes", { x: -500, y: 0, w: 240, h: 160, text: "Check the flaky login test" });
      await page.reload();
      await page.waitForSelector(".react-flow__node-note");
      await page.getByRole("button", { name: "Fit everything" }).click();
      await page.waitForTimeout(500);
      clearActions();
      await drawLink(page, page.locator(".react-flow__node-note"), "w5:p9");
      await waitFor(() => promptsTo("w5:p9").length > 0, "the note should reach the agent");
      assert(promptsTo("w5:p9")[0].includes("A note from the user:"), `unexpected prompt: ${promptsTo("w5:p9")}`);
      assert(actions().includes("Check the flaky login test"), `the note text should be sent: ${actions()}`);
      const links = page.locator(".note-links");
      await links.getByText(/sent .* ago/).waitFor({ timeout: 4000 });
      assert((await links.getByRole("button", { name: "Send again" }).count()) === 0, "no Send again before an edit");
      await page.locator(".note-text").fill("Check the flaky login test on CI");
      await page.locator(".note-text").blur();
      await links.getByRole("button", { name: "Send again" }).click();
      await waitFor(() => actions().includes("Check the flaky login test on CI"), "Send again should send the edited note", 12000);
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

  test("together: a schedule does nothing until armed, and an edit disarms it", async (page) =>
    withReset(async () => {
      clearActions();
      await card(page, "w5:p9").click({ modifiers: ["Alt"] });
      const block = page.locator('[data-testid="agent-automation"]');
      await block.getByRole("button", { name: /Automation/ }).click();
      await block.getByRole("button", { name: "Schedule a prompt" }).click();
      await block.getByLabel("Prompt to send").fill("Post a status update");
      await block.getByLabel("Repeat").selectOption("minutes");
      await block.getByLabel("Every").fill("1");
      await block.getByRole("button", { name: "Save" }).click();
      const row = block.locator('[data-testid="schedule"]');
      await row.getByText("Not armed").first().waitFor({ timeout: 3000 });
      let [s] = (await api("GET", "/api/automation")).schedules;
      assert(s && !s.armed && s.timing.minutes === 1 && s.target === "w5:p9", `unexpected schedule ${JSON.stringify(s)}`);
      await page.waitForTimeout(2500);
      assert((await api("GET", "/api/automation")).items.length === 0 && promptsTo("w5:p9").length === 0, "an unarmed schedule sends nothing");

      await row.getByRole("button", { name: "Arm" }).click();
      await row.getByText(/Next run/).waitFor({ timeout: 3000 });
      [s] = (await api("GET", "/api/automation")).schedules;
      assert(s.armed && s.nextRunAt > Date.now() + 30_000, `arming should set the next run a minute out: ${JSON.stringify(s)}`);

      await row.getByRole("button", { name: "Edit schedule" }).click();
      await block.getByLabel("Prompt to send").fill("Post a short status update");
      await block.getByRole("button", { name: "Save" }).click();
      await row.getByText("Not armed").first().waitFor({ timeout: 3000 });
      [s] = (await api("GET", "/api/automation")).schedules;
      assert(!s.armed && s.nextRunAt === undefined, "an edit should disarm the schedule");
      assert(promptsTo("w5:p9").length === 0, `nothing should have been sent: ${actions()}`);
      await row.getByRole("button", { name: "Delete schedule" }).click();
      await waitFor(async () => (await api("GET", "/api/automation")).schedules.length === 0, "delete should remove the schedule");
    }));

}

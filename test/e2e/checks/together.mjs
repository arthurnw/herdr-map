// Agents working together: the prompt queue and its pause.
export default function togetherChecks({ test, assert, actions, clearActions, writeSnapshot, snapshot, base }) {
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

  async function withReset(fn) {
    await resetAutomation();
    try {
      await fn();
    } finally {
      writeSnapshot(snapshot());
      await resetAutomation();
    }
  }

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

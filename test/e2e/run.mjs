// End-to-end checks: runs herdr-map against test/e2e/herdr-stub.sh and a made-up
// snapshot, then drives the page in Chrome. Nothing here talks to a real herdr.
//
//   npm run build && npm run test:e2e            all checks
//   npm run test:e2e -- --grep reply             checks whose name contains "reply"
//
// Needs Google Chrome installed; playwright-core drives it through the "chrome" channel.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PROCESS_INFO, PS_OUTPUT, SCREENS, setStatus, snapshot } from "./fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const grep = process.argv.includes("--grep") ? process.argv[process.argv.indexOf("--grep") + 1] : undefined;

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "herdr-map-e2e-"));
const stub = join(here, "herdr-stub.sh");
chmodSync(stub, 0o755);
const psStub = join(here, "ps-stub.sh");
chmodSync(psStub, 0o755);
writeFileSync(join(dir, "ps.txt"), `${PS_OUTPUT}\n`);
mkdirSync(join(dir, "screens"));
for (const [id, text] of Object.entries(SCREENS)) writeFileSync(join(dir, "screens", `${id.replace(":", "_")}.txt`), text);
mkdirSync(join(dir, "process-info"));
for (const [id, info] of Object.entries(PROCESS_INFO)) writeFileSync(join(dir, "process-info", `${id.replace(":", "_")}.json`), JSON.stringify(info));
const writeSnapshot = (snap) => writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snap));
writeSnapshot(snapshot());
writeFileSync(join(dir, "actions.log"), "");

const actions = () => readFileSync(join(dir, "actions.log"), "utf8").trim().split("\n").filter(Boolean);
const clearActions = () => writeFileSync(join(dir, "actions.log"), "");
const layoutFile = join(dir, "layout.json");

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [join(root, "server/index.ts"), "--port", String(port), "--herdr", stub, "--no-activate", "--layout", layoutFile, "--interval", "300"],
  { env: { ...process.env, HERDR_STUB_DIR: dir, HERDR_MAP_PS: psStub }, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const body = await (await fetch(`${base}/api/fleet`)).json();
      if (body.fleet) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${serverLog}`);
}

const browser = await chromium.launch({ channel: "chrome" });

/** A fresh page with empty browser storage and the default layout. */
async function openPage({ background = false } = {}) {
  rmSync(layoutFile, { force: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, colorScheme: "dark" });
  await context.addInitScript((isBackground) => {
    if (!sessionStorage.getItem("e2e-initialized")) {
      localStorage.clear();
      sessionStorage.setItem("e2e-initialized", "1");
    }
    // Record notifications instead of showing them.
    window.__notifications = [];
    window.Notification = class {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title, options) {
        window.__notifications.push({ title, body: options?.body });
      }
      close() {}
    };
    if (isBackground) {
      document.hasFocus = () => false;
      localStorage.setItem("herdr-map.alerts", JSON.stringify({ desktop: true, sound: false, onBlocked: true, onDone: true }));
    }
  }, background);
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector(".react-flow__node-pane");
  await page.waitForTimeout(500);
  return page;
}

const agentCards = (page) => page.locator(".react-flow__node-pane .pane.agent");
const chip = (page, status) =>
  page.getByRole("group", { name: "Filter agents by status" }).getByRole("button", { name: new RegExp(`\\b${status}\\b`) });
const card = (page, paneId) => page.locator(`.react-flow__node-pane[data-id="${paneId}"]`);
const needsYouRow = (page, text) => page.locator("aside li", { hasText: text }).locator("button").first();
const detailTitle = (page) => page.locator("aside h2").nth(1);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("renders agents, hides tool panes, and counts attention in the title", async (page) => {
  assert((await agentCards(page).count()) === 6, `expected 6 agent cards, got ${await agentCards(page).count()}`);
  assert((await page.locator(".pane.tool").count()) === 0, "tool panes should be hidden by default");
  assert((await page.title()) === "(3) herdr-map", `unexpected title: ${await page.title()}`);
});

test("status chips hide, solo, and remember statuses", async (page) => {
  await chip(page, "idle").click();
  await page.waitForTimeout(200);
  assert((await agentCards(page).count()) === 4, "hiding idle should leave 4 agents");
  await page.reload();
  await page.waitForSelector(".react-flow__node-pane");
  assert((await chip(page, "idle").getAttribute("aria-pressed")) === "false", "hidden status should survive a reload");
  await chip(page, "idle").click();
  await chip(page, "working").click({ modifiers: ["Alt"] });
  await page.waitForTimeout(200);
  assert((await agentCards(page).count()) === 1, "Option-click should show only working agents");
  await chip(page, "working").click({ modifiers: ["Alt"] });
  await page.waitForTimeout(200);
  assert((await agentCards(page).count()) === 6, "a second Option-click should show everything");
});

test("text filter dims workspaces that don't match", async (page) => {
  await page.getByPlaceholder("Filter workspaces, agents, summaries").fill("billing");
  await page.waitForTimeout(200);
  const total = await page.locator(".react-flow__node-workspace").count();
  const dimmed = await page.locator(".react-flow__node-workspace.dim").count();
  assert(dimmed === total - 1, `expected ${total - 1} dimmed workspaces, got ${dimmed}`);
});

test("View menu shows the full tab layout", async (page) => {
  await page.getByRole("button", { name: "View" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Only agent panes" }).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert((await page.locator(".pane.tool").count()) >= 3, "tool panes should appear");
});

test("dragging saves the layout, and layouts save, reset, and restore", async (page) => {
  clearActions();
  const ws = page.locator(".react-flow__node-workspace").first();
  const box = await ws.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 6);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + 30 + i * 30, box.y + 6 + i * 20);
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert(actions().length === 0, "a drag must not focus anything");
  const saved = JSON.parse(readFileSync(layoutFile, "utf8"));
  assert(Object.keys(saved.current.workspaces).length > 0, "a drag should save positions");
  await page.getByRole("button", { name: "Layouts" }).click();
  await page.getByPlaceholder("Layout name").fill("e2e");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Reset to automatic layout" }).click();
  await page.waitForTimeout(400);
  const store = JSON.parse(readFileSync(layoutFile, "utf8"));
  assert(
    Object.keys(store.current.workspaces).length === 0 && Object.keys(store.current.cards).length === 0,
    "reset should clear the current layout",
  );
  assert(store.named.e2e && store.named["Previous layout"], "save and reset should both store named layouts");
});

test("clicking an agent focuses it in herdr", async (page) => {
  clearActions();
  await card(page, "w1:p1").click();
  await page.waitForTimeout(300);
  assert(actions().includes("agent focus w1:p1"), `expected a focus, got ${actions()}`);
});

test("Needs you selects without focusing, and dialog options press their key", async (page) => {
  clearActions();
  await needsYouRow(page, "api-auth").click();
  await page.waitForTimeout(600);
  assert(actions().length === 0, "selecting from Needs you must not focus the terminal");
  assert((await detailTitle(page).textContent()).includes("api-auth"), "the selected agent should show in the sidebar");
  const options = page.locator("aside button:has(kbd)");
  await options.first().waitFor();
  assert((await options.count()) === 3, `expected 3 dialog options, got ${await options.count()}`);
  await options.nth(1).click();
  await page.waitForTimeout(300);
  assert(actions().includes("agent send-keys w2:p3 2"), `expected key 2, got ${actions()}`);
});

test("a stale dialog answer is refused without sending keys", async (page) => {
  clearActions();
  const res = await page.evaluate(async () =>
    (
      await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane: "w2:p3", keys: ["2"], expect: { key: "2", label: "Somewhere else" } }),
      })
    ).status,
  );
  assert(res === 409, `expected 409, got ${res}`);
  assert(actions().length === 0, "a refused answer must not send keys");
});

test("text typed into a dialog is sent, then Enter", async (page) => {
  await needsYouRow(page, "api-auth").click();
  await page.locator("aside textarea").waitFor();
  clearActions();
  await page.locator("aside textarea").fill("canary");
  await page.locator("aside textarea").press("Enter");
  await page.waitForTimeout(400);
  const log = actions();
  assert(log.includes("pane send-text w2:p3 canary") && log.includes("agent send-keys w2:p3 enter"), `got ${log}`);
});

test("an agent without a dialog gets a prompt", async (page) => {
  await needsYouRow(page, "stylist").click();
  await page.locator("aside textarea").waitFor();
  clearActions();
  await page.locator("aside textarea").fill("summarize your changes");
  await page.locator("aside textarea").press("Enter");
  await page.waitForTimeout(400);
  assert(actions().includes("agent prompt w4:p7 summarize your changes"), `got ${actions()}`);
});

test("a Codex-style picker on an idle agent shows its options", async (page) => {
  await card(page, "w3:p5").click({ modifiers: ["Alt"] });
  const options = page.locator("aside button:has(kbd)");
  await options.first().waitFor({ timeout: 5000 });
  assert((await options.count()) === 3, `expected 3 options, got ${await options.count()}`);
});

test("keyboard: n selects, o opens, r replies, Esc clears", async (page) => {
  clearActions();
  const selectedRow = () => page.locator("aside li.bg-accent").textContent();
  await page.keyboard.press("n");
  await page.waitForTimeout(400);
  const first = await selectedRow();
  await page.keyboard.press("n");
  await page.waitForTimeout(400);
  assert((await selectedRow()) !== first, "a second n should move to the next agent");
  await page.keyboard.press("o");
  await page.waitForTimeout(300);
  assert(actions().some((a) => a.startsWith("agent focus")), "o should focus the selection");
  await page.keyboard.press("r");
  assert((await page.evaluate(() => document.activeElement?.tagName)) === "TEXTAREA", "r should focus the reply box");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert(await page.getByText("Hover a pane to preview its screen.").isVisible(), "Esc should clear the sidebar");
});

test("pinning keeps a preview with scrollback", async (page) => {
  await card(page, "w1:p1").click({ modifiers: ["Alt"] });
  await page.getByRole("button", { name: "Unpin" }).waitFor();
  await card(page, "w5:p9").hover();
  await page.waitForTimeout(400);
  assert((await detailTitle(page).textContent()).includes("api"), "the pinned preview should stay put while hovering");
});

test("an agent becoming blocked raises a notification in the background", async () => {
  const page = await openPage({ background: true });
  try {
    await page.waitForTimeout(600);
    writeSnapshot(setStatus(snapshot(), "w5:p9", "blocked"));
    await page.waitForTimeout(1500);
    const notes = await page.evaluate(() => window.__notifications);
    assert(notes.some((n) => n.title.includes("needs you")), `expected a notification, got ${JSON.stringify(notes)}`);
  } finally {
    writeSnapshot(snapshot());
    await page.context().close();
  }
});

test("a finished turn stays done until herdr-map focuses the pane", async (page) => {
  try {
    writeSnapshot(setStatus(snapshot(), "w1:p1", "idle"));
    // The server polls every 300 ms here; a turn counts as finished after 2.5 s of idle.
    await page.waitForTimeout(3500);
    assert(await card(page, "w1:p1").locator(".pane.status-done").count(), "a finished turn should show as done");
    await card(page, "w1:p1").click();
    await page.waitForTimeout(800);
    assert(await card(page, "w1:p1").locator(".pane.status-idle").count(), "focusing the pane should clear done");
  } finally {
    writeSnapshot(snapshot());
  }
});

test("the theme picker switches to light", async (page) => {
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitemradio", { name: "Light" }).click();
  await page.waitForTimeout(200);
  assert((await page.evaluate(() => document.documentElement.className)).includes("light"), "html should have the light class");
});

test("the app manifest and icons are served", async (page) => {
  const res = await page.evaluate(async () => {
    const m = await fetch("/manifest.webmanifest");
    const i = await fetch("/icon-512.png");
    return [m.status, m.headers.get("content-type"), i.status, i.headers.get("content-type")];
  });
  assert(res[0] === 200 && res[1].includes("manifest") && res[2] === 200 && res[3] === "image/png", `got ${res}`);
});

// Feature checks can live in their own files: each module in checks/ default-exports
// a function that registers tests with the helpers below.
const checksDir = join(here, "checks");
const helpers = {
  test, assert, openPage, agentCards, chip, card, needsYouRow, detailTitle,
  actions, clearActions, writeSnapshot, snapshot, setStatus, layoutFile, stubDir: dir, base,
};
if (existsSync(checksDir)) {
  for (const file of readdirSync(checksDir).filter((f) => f.endsWith(".mjs")).sort()) {
    (await import(join(checksDir, file))).default(helpers);
  }
}

let failures = 0;
try {
  await waitForServer();
  for (const t of tests) {
    if (grep && !t.name.includes(grep)) continue;
    const page = t.fn.length === 0 ? undefined : await openPage();
    try {
      await t.fn(page);
      if (page?.errors.length) throw new Error(`page errors: ${page.errors.join("; ")}`);
      console.log(`✔ ${t.name}`);
    } catch (err) {
      failures++;
      console.log(`✖ ${t.name}\n    ${err.message}`);
    } finally {
      await page?.context().close();
    }
  }
} finally {
  await browser.close();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);

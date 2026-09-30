import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { buildFleet, fleetPanes, StatusClock } from "../shared/model.ts";
import { childrenOf, commandName, memoryUse, paneProcs, parsePs, summarizeProcs, type MemoryInput, type MemoryOutput } from "../probe/memory.ts";
import { herdrProcessInfo, parseProcessInfo, type ProcessInfo } from "../probe/usage.ts";
import { agentPaneIds, createMemoryWatcher, markMemory } from "../server/memory.ts";
import { readMemory } from "../server/probe.ts";
import { fleetMemoryTitle, formatBytes, heaviestAgents, HIGH_MEMORY_BYTES, highMemory, memoryTitle } from "../web/memory-format.ts";
import { snapshotFixture } from "./fixtures.ts";

const MB = 1024 * 1024;
const kb = (mb: number) => mb * 1024;

// pid ppid rss(KiB) comm, as `ps -A -o pid=,ppid=,rss=,comm=` prints it.
const PS = [
  `    1     0 ${kb(12)} /sbin/launchd`,
  `  100     1 ${kb(10)} -zsh`,
  `  101   100 ${kb(800)} /opt/homebrew/bin/claude`,
  `  102   101 ${kb(90)} node`,
  `  103   101 ${kb(60)} node`,
  `  104   102 ${kb(5)} /usr/bin/uvx`,
  `  200     1 ${kb(9)} /bin/zsh`,
  `  201   200 ${kb(300)} codex`,
  // Its parent exited, so it was reparented away from pane 2's shell.
  `  202     1 ${kb(40)} codex`,
  `  300     1 ${kb(500)} /Applications/Some App.app/Contents/MacOS/Some App`,
  "garbage line",
  "",
].join("\n");

const info = (shellPid: number | undefined, ...fg: [number, string][]): ProcessInfo => ({
  ...(shellPid && { shellPid }),
  foreground: fg.map(([pid, argv0]) => ({ pid, argv0, name: argv0 })),
});

test("parsePs reads pid, parent, RSS in bytes, and the command's basename, even with spaces", () => {
  const procs = parsePs(PS);
  assert.equal(procs.size, 10);
  assert.deepEqual(procs.get(101), { pid: 101, ppid: 100, bytes: 800 * MB, name: "claude" });
  assert.equal(procs.get(100)!.name, "zsh", "a login shell's leading dash is dropped");
  assert.equal(procs.get(300)!.name, "Some App");
  assert.equal(commandName("/usr/local/bin/node"), "node");
});

test("a pane's tree is its shell and everything under it, each process once", () => {
  const procs = parsePs(PS);
  const children = childrenOf(procs);
  // The foreground process is under the shell already, so it isn't counted twice.
  const list = paneProcs(info(100, [101, "claude"]), procs, children);
  assert.deepEqual(list.map((p) => p.pid).sort(), [100, 101, 102, 103, 104]);
  const m = summarizeProcs("w1:p1", list);
  assert.equal(m.bytes, (10 + 800 + 90 + 60 + 5) * MB);
  assert.equal(m.processes, 5);
  assert.deepEqual(m.top, [
    { name: "claude", bytes: 800 * MB, count: 1 },
    { name: "node", bytes: 150 * MB, count: 2 },
    { name: "zsh", bytes: 10 * MB, count: 1 },
  ]);
});

test("a foreground process outside the shell's tree counts when ps names it as herdr did", () => {
  const procs = parsePs(PS);
  const children = childrenOf(procs);
  const reparented = paneProcs(info(200, [202, "codex"]), procs, children);
  assert.deepEqual(reparented.map((p) => p.pid).sort(), [200, 201, 202]);
  // pid 300 was reused by another program between process-info and ps.
  const reused = paneProcs(info(200, [300, "codex"]), procs, children);
  assert.deepEqual(reused.map((p) => p.pid).sort(), [200, 201]);
  // Linux truncates names in ps to 15 characters.
  const long = parsePs("  7   1 1024 some-long-agent\n");
  assert.equal(paneProcs(info(undefined, [7, "/usr/bin/some-long-agent-name"]), long, childrenOf(long)).length, 1);
});

test("missing pids and a parent loop are skipped", () => {
  const procs = parsePs(["  10  11 1024 a", "  11  10 1024 b", "  12  12 1024 c"].join("\n"));
  const children = childrenOf(procs);
  assert.deepEqual(paneProcs(info(99, [98, "gone"]), procs, children), []);
  assert.deepEqual(paneProcs(info(10), procs, children).map((p) => p.pid).sort(), [10, 11]);
  assert.deepEqual(paneProcs(info(12), procs, children).map((p) => p.pid), [12]);
});

test("memoryUse measures each pane, totals each process once, and reports panes it can't measure", () => {
  const infos: Record<string, ProcessInfo> = {
    "w1:p1": info(100, [101, "claude"]),
    "w2:p1": info(200, [202, "codex"]),
    // Shares a process with w1:p1, as when the same tree is reported for two panes.
    "w3:p1": info(undefined, [102, "node"]),
    "w4:p1": info(900),
  };
  const out = memoryUse(
    { panes: ["w1:p1", "w2:p1", "w3:p1", "w4:p1", "w5:p1"], top: 2 },
    { ps: () => PS, processInfo: (p) => infos[p], totalmem: () => 16 * 1024 * MB },
  );
  assert.deepEqual(
    out.panes.map((p) => [p.pane, p.bytes / MB, p.processes, p.top.length]),
    [
      ["w1:p1", 965, 5, 2],
      ["w2:p1", 349, 3, 2],
      ["w3:p1", 95, 2, 2],
    ],
  );
  assert.equal(out.totalBytes, (965 + 349) * MB, "w3:p1's processes are already in w1:p1's");
  assert.equal(out.machineBytes, 16 * 1024 * MB);
  assert.deepEqual(out.errors, [
    { pane: "w4:p1", error: "none of the pane's processes are running" },
    { pane: "w5:p1", error: "herdr gave no process info" },
  ]);
});

test("memoryUse reports a failing ps without measuring anything", () => {
  const out = memoryUse({ panes: ["w1:p1"] }, { ps: () => { throw new Error("spawnSync ps ETIMEDOUT\nmore"); }, processInfo: () => info(100), totalmem: () => 1 });
  assert.deepEqual(out, { panes: [], totalBytes: 0, machineBytes: 1, error: "ps failed: spawnSync ps ETIMEDOUT" });
});

test("parseProcessInfo reads the shell pid and foreground processes", () => {
  const out = JSON.stringify({
    id: "cli:pane:process_info",
    result: {
      type: "pane_process_info",
      process_info: {
        pane_id: "w1:p1",
        shell_pid: 4000,
        foreground_process_group_id: 4001,
        foreground_processes: [{ pid: 4001, argv0: "claude", argv: ["claude"], name: "2.1.300", cwd: "/repos/x" }, { pid: 0 }],
      },
    },
  });
  assert.deepEqual(parseProcessInfo(out), { shellPid: 4000, foreground: [{ pid: 4001, argv0: "claude", argv: ["claude"], name: "2.1.300", cwd: "/repos/x" }] });
  assert.deepEqual(parseProcessInfo('{"result":{"process_info":{"shell_pid":-1,"foreground_processes":[]}}}'), { foreground: [] });
  assert.equal(parseProcessInfo('{"error":{"code":"pane_not_found"}}'), undefined);
  assert.equal(parseProcessInfo("not json"), undefined);
  assert.equal(herdrProcessInfo("herdr", () => assert.fail("no call for a bad id"))("--help"), undefined);
});

test("formatBytes uses MB below a gigabyte and GB above", () => {
  assert.equal(formatBytes(0), "0 MB");
  assert.equal(formatBytes(335 * MB), "335 MB");
  assert.equal(formatBytes(999 * MB), "999 MB");
  assert.equal(formatBytes(1000 * MB), "1.0 GB");
  assert.equal(formatBytes(1.24 * 1024 * MB), "1.2 GB");
  assert.equal(formatBytes(12.6 * 1024 * MB), "13 GB");
  const m = { bytes: HIGH_MEMORY_BYTES + 1, processes: 3, top: [{ name: "node", bytes: 300 * MB, count: 2 }] };
  assert.equal(highMemory(m), true);
  assert.equal(highMemory({ ...m, bytes: HIGH_MEMORY_BYTES }), false);
  assert.equal(memoryTitle(m), "2.0 GB in 3 processes: node ×2 300 MB");
});

function fleet() {
  return buildFleet(snapshotFixture(), new StatusClock().observe(snapshotFixture().agents, 0));
}

test("markMemory sets figures on measured agents and the fleet total; the title lists the heaviest", () => {
  const f = fleet();
  assert.deepEqual(agentPaneIds(f), ["w1:p1", "w2:p1"]);
  const panes = new Map([
    ["w1:p1", { bytes: 900 * MB, processes: 4, top: [] }],
    ["w2:p1", { bytes: 1500 * MB, processes: 2, top: [] }],
    ["w1:p2", { bytes: 1, processes: 1, top: [] }],
  ]);
  markMemory(f, { panes, total: { bytes: 2400 * MB, agents: 2, machineBytes: 8 * 1024 * MB } });
  const byId = new Map(fleetPanes(f).map((p) => [p.id, p]));
  assert.equal(byId.get("w1:p1")!.agent!.memory!.bytes, 900 * MB);
  assert.equal(byId.get("w1:p2")!.agent, undefined, "a tool pane gets nothing");
  assert.deepEqual(heaviestAgents(f).map((a) => a.label), ["pi (api-feature)", "lead (api)"]);
  assert.equal(fleetMemoryTitle(f), "Agents use 2.3 GB of 8.0 GB (29%) across 2 agents\nHeaviest:\npi (api-feature): 1.5 GB\nlead (api): 900 MB");
});

test("the memory watcher merges each run, logs each distinct error once, and keeps figures through a failure", async () => {
  const lines: string[] = [];
  let changes = 0;
  const inputs: MemoryInput[] = [];
  let next: MemoryOutput | Error = { panes: [{ pane: "w1:p1", bytes: 10, processes: 1, top: [] }], totalBytes: 10, machineBytes: 100 };
  const w = createMemoryWatcher({
    probe: { node: "node", herdr: "/opt/herdr" },
    intervalMs: 15_000,
    panes: () => ["w1:p1", "w2:p1"],
    onChange: () => changes++,
    run: async (input) => {
      inputs.push(input);
      if (next instanceof Error) throw next;
      return next;
    },
    log: (l) => lines.push(l),
  });
  await w.round();
  assert.deepEqual(inputs[0], { panes: ["w1:p1", "w2:p1"], herdr: "/opt/herdr" });
  assert.deepEqual(w.memory().total, { bytes: 10, agents: 1, machineBytes: 100 });
  assert.equal(w.memory().panes.get("w1:p1")!.bytes, 10);
  assert.equal(changes, 1);
  await w.round();
  assert.equal(changes, 1, "the same figures don't count as a change");

  next = { panes: [{ pane: "w1:p1", bytes: 20, processes: 1, top: [] }], errors: [{ pane: "w2:p1", error: "herdr gave no process info" }], totalBytes: 20 };
  await w.round();
  await w.round();
  assert.equal(changes, 2);
  assert.deepEqual(lines, ["memory probe: w2:p1: herdr gave no process info"]);

  next = new Error("probe timed out after 20s");
  await w.round();
  await w.round();
  next = { panes: [], totalBytes: 0, error: "ps failed: EACCES" };
  await w.round();
  assert.equal(w.memory().panes.get("w1:p1")!.bytes, 20, "figures stay through failures");
  assert.equal(w.error(), "ps failed: EACCES");
  assert.deepEqual(lines.slice(1), ["memory probe: probe timed out after 20s", "memory probe: ps failed: EACCES"]);
});

test("the memory watcher runs on its own interval and clears figures when no agents are left", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let runs = 0;
    let panes = ["w1:p1"];
    const w = createMemoryWatcher({
      probe: { node: "node" },
      intervalMs: 15_000,
      panes: () => panes,
      onChange: () => undefined,
      run: async () => (runs++, { panes: [{ pane: "w1:p1", bytes: 1, processes: 1, top: [] }], totalBytes: 1 }),
    });
    const flush = () => new Promise<void>((r) => setImmediate(r));
    w.start(1000);
    mock.timers.tick(999);
    await flush();
    assert.equal(runs, 0);
    mock.timers.tick(1);
    await flush();
    assert.equal(runs, 1);
    mock.timers.tick(14_999);
    await flush();
    assert.equal(runs, 1, "the next run waits a full interval");
    mock.timers.tick(1);
    await flush();
    assert.equal(runs, 2);
    panes = [];
    await w.round();
    assert.equal(w.memory().panes.size, 0);
    assert.equal(runs, 2, "nothing to measure, no run");
  } finally {
    mock.timers.reset();
  }
});

test("readMemory runs the joined probe in a child Node", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-map-memory-"));
  const ps = join(dir, "ps");
  writeFileSync(ps, `#!/bin/sh\n[ "$*" = "-A -o pid=,ppid=,rss=,comm=" ] || exit 1\nprintf '  50 1 2048 -zsh\\n  51 50 4096 pi\\n'\n`);
  const herdr = join(dir, "herdr");
  const pi = { result: { process_info: { shell_pid: 50, foreground_processes: [{ pid: 51, argv0: "pi", name: "pi" }] } } };
  writeFileSync(herdr, `#!/bin/sh\n[ "$1 $2 $3 $4" = "pane process-info --pane w1:p1" ] || exit 1\necho '${JSON.stringify(pi)}'\n`);
  chmodSync(ps, 0o755);
  chmodSync(herdr, 0o755);
  const saved = process.env.HERDR_MAP_PS;
  process.env.HERDR_MAP_PS = ps;
  try {
    const out = await readMemory({ node: process.execPath }, { panes: ["w1:p1"], herdr });
    assert.deepEqual(out.panes, [{ pane: "w1:p1", bytes: 6 * 1024 * 1024, processes: 2, top: [{ name: "pi", bytes: 4 * MB, count: 1 }, { name: "zsh", bytes: 2 * MB, count: 1 }] }]);
    assert.ok(out.machineBytes! > 0);
  } finally {
    if (saved === undefined) delete process.env.HERDR_MAP_PS;
    else process.env.HERDR_MAP_PS = saved;
  }
});

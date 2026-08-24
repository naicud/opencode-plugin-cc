import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import { classifyDelegation } from "../plugins/opencode/mcp/lib/delegation-router.mjs";
import { detectFreeCandidates } from "../plugins/opencode/scripts/sync-models.mjs";
import { checkBudget, computeSpend } from "../plugins/opencode/mcp/lib/budget.mjs";
import { createActivitySink } from "../plugins/opencode/mcp/lib/activity-log.mjs";
import { upsertJob } from "../plugins/opencode/scripts/lib/state.mjs";

let tmpDir;
let cwd;

beforeEach(() => {
  tmpDir = createTmpDir();
  setupTestEnv(tmpDir);
  cwd = createTmpDir("oc-impr-ws");
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
  cleanupTmpDir(cwd);
});

describe("router: multilingual delegation intent", () => {
  it("routes Italian subagent asks", () => {
    const v = classifyDelegation({
      description: "manda un subagente",
      prompt: "delega questo task in background",
    });
    assert.equal(v.route, true);
    assert.match(v.reason, /subagente|delega|background/);
  });

  it("routes English delegation asks without heavy words", () => {
    const v = classifyDelegation({
      description: "spawn two workers",
      prompt: "fan out this refactor across files",
    });
    assert.equal(v.route, true);
  });

  it("keeps Italian quick-look asks local", () => {
    const v = classifyDelegation({
      description: "cerca veloce",
      prompt: "leggi il file e riassumi",
    });
    assert.equal(v.route, false);
  });
});

describe("sync: free-model detection", () => {
  const baseConfig = () => ({
    provider: "opencode",
    defaults: { tier: 0 },
    models: [
      { id: "x-preview-f-free", tier: 0, default: true, variants: ["max"], cost: { input: 0, output: 0 } },
    ],
    excluded: [{ id: "muse-contributor-free", reason: "training" }],
  });

  it("suggests new free ids without promoting by default", () => {
    const prev = baseConfig();
    const merged = structuredClone(prev);
    merged.models.push({ id: "brand-new-free", tier: null, unclassified: true, variants: ["max"], cost: { input: 0, output: 0 } });
    const { promoted, suggested } = detectFreeCandidates(prev, merged);
    assert.deepEqual(promoted, []);
    assert.deepEqual(suggested, ["brand-new-free"]);
    assert.equal(merged.models[1].tier, null); // untouched
  });

  it("auto-promotes new free ids to tier 0 with --auto-free", () => {
    const prev = baseConfig();
    const merged = structuredClone(prev);
    merged.models.push({ id: "brand-new-free", tier: null, unclassified: true, variants: ["max"], cost: { input: 0, output: 0 } });
    const { promoted } = detectFreeCandidates(prev, merged, { autoFree: true });
    assert.deepEqual(promoted, ["brand-new-free"]);
    assert.equal(merged.models[1].tier, 0);
    assert.equal(merged.models[1].unclassified, false);
  });

  it("never steals the default flag and skips excluded/paid ids", () => {
    const prev = baseConfig();
    const merged = structuredClone(prev);
    merged.models.push(
      { id: "another-default-free", default: true, variants: [], cost: { input: 0, output: 0 } },
      { id: "muse-contributor-free", variants: [], cost: { input: 0, output: 0 } },
      { id: "paid-thing", variants: [], cost: { input: 3, output: 15 } }
    );
    const { suggested } = detectFreeCandidates(prev, merged, { autoFree: true });
    // muse is excluded upstream (never merged), paid is not free; the other
    // default keeps its flag and IS promoted as a candidate.
    assert.ok(!suggested.includes("muse-contributor-free"));
    const stolen = merged.models.find((m) => m.id === "x-preview-f-free");
    assert.equal(stolen.default, true);
    assert.equal(merged.defaults.tier, 0);
  });
});

describe("budget: per-account daily caps", () => {
  const NOW = new Date("2026-08-24T15:00:00Z");
  const config = (accounts) => ({
    budget: { maxJobCostUsd: 10, maxDailyCostUsd: 100, ...(accounts ? { accounts } : {}) },
  });

  it("blocks when the named account exceeds its own daily cap", () => {
    const jobs = [
      { status: "completed", account: "work", cost: 4.5, createdAt: NOW.toISOString() },
    ];
    const v = checkBudget(config({ work: { maxDailyCostUsd: 5 } }), jobs, { pendingCost: 1, account: "work", now: NOW });
    assert.equal(v.ok, false);
    assert.equal(v.code, "BUDGET_ACCOUNT_DAILY_MAX");
    assert.match(v.reason, /"work"/);
  });

  it("other accounts are unaffected by work's cap", () => {
    const jobs = [{ status: "completed", account: "work", cost: 4.5, createdAt: NOW.toISOString() }];
    const v = checkBudget(config({ work: { maxDailyCostUsd: 5 } }), jobs, { pendingCost: 1, account: "personal", now: NOW });
    assert.equal(v.ok, true);
  });

  it("account:'auto' or missing account only faces global caps", () => {
    const jobs = [{ status: "completed", account: "work", cost: 99, createdAt: NOW.toISOString() }];
    for (const account of [null, "auto"]) {
      const v = checkBudget(config({ work: { maxDailyCostUsd: 5 } }), jobs, { pendingCost: 0.5, account, now: NOW });
      assert.equal(v.ok, true, `account=${account}`);
    }
  });

  it("computeSpend buckets today's spend per account", () => {
    const jobs = [
      { status: "completed", account: "a", cost: 2, createdAt: NOW.toISOString() },
      { status: "completed", account: "b", cost: 3, createdAt: "2026-08-20T10:00:00Z" }, // old day
      { status: "failed", account: "a", cost: 9, createdAt: NOW.toISOString() }, // not completed
    ];
    const s = computeSpend(jobs, { now: NOW });
    assert.deepEqual(s.byAccountToday, { a: 2 });
  });
});

describe("activity buffer persistence across restarts", () => {
  it("tail() falls back to the persisted snapshot of a previous process", async () => {
    const job = { id: "task-persist-1", sessionID: "sess-p1", directory: cwd };
    upsertJob(cwd, job);
    const sinkA = createActivitySink();
    sinkA.note(cwd, "sess-p1", "delegate", "line survives restarts");
    sinkA.flush();

    // Fresh instance = simulated server restart.
    const { createActivitySink: fresh } = await import("../plugins/opencode/mcp/lib/activity-log.mjs?restart=1");
    const sinkB = fresh();
    const lines = sinkB.tail("task-persist-1", 10);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[delegate\] line survives restarts$/);
  });
});

describe("wait auto-slice", () => {
  it("slices to 60s when no timeoutSec/progressToken, 600s with token", async () => {
    const { effectiveWaitTimeoutSec } = await import("../plugins/opencode/mcp/server.mjs");
    assert.equal(effectiveWaitTimeoutSec({}, {}), 60);
    assert.equal(effectiveWaitTimeoutSec({ timeoutSec: 300 }, {}), 300);
    assert.equal(effectiveWaitTimeoutSec({}, { progressToken: "t" }), 600);
    process.env.OPENCODE_WAIT_SLICE_SEC = "1";
    assert.equal(effectiveWaitTimeoutSec({}, {}), 1);
    delete process.env.OPENCODE_WAIT_SLICE_SEC;
  });
});

describe("orphan reaper", () => {
  it("removes dead entries, keeps young ones, refuses foreign stale processes", async () => {
    const { spawn, spawnSync } = await import("node:child_process");
    const { reapStaleServers, recordServerEntry } = await import("../plugins/opencode/scripts/lib/opencode-server.mjs");
    const { stateRoot, stateBase } = await import("../plugins/opencode/scripts/lib/state.mjs");
    const entryPath = (port) => path.join(stateRoot(cwd), "servers", `serve-${port}.json`);
    const backdate = (port) => {
      const p = entryPath(port);
      const e = JSON.parse(fs.readFileSync(p, "utf8"));
      e.startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(p, JSON.stringify(e));
    };

    // 1. dead pid -> entry removed
    const dead = spawnSync(process.execPath, ["-e", ""]);
    recordServerEntry(cwd, { pid: dead.pid, port: 59901, host: "127.0.0.1", account: null });

    // 2. young alive process -> untouched
    const young = spawn(process.execPath, ["-e", "setInterval(()=>{},250)"], { detached: true }); young.unref();
    recordServerEntry(cwd, { pid: young.pid, port: 59902, host: "127.0.0.1", account: null });

    // 3. stale alive FOREIGN process -> identity check refuses the kill
    const stale = spawn(process.execPath, ["-e", "setInterval(()=>{},250)"], { detached: true }); stale.unref();
    recordServerEntry(cwd, { pid: stale.pid, port: 59903, host: "127.0.0.1", account: null });
    backdate(59903);

    try {
      const r = await reapStaleServers({ baseDir: stateBase() });
      assert.ok(r.removedDead >= 1, "dead entry removed");
      assert.ok(r.scanned >= 3);
      assert.equal(fs.existsSync(entryPath(59902)), true, "young untouched");
      assert.equal(fs.existsSync(entryPath(59903)), true, "foreign stale refused, not killed");
      assert.ok(r.reaped.every((x) => x.port !== 59902 && x.port !== 59903));
    } finally {
      for (const p of [young.pid, stale.pid]) { try { process.kill(p, 9); } catch {} }
    }
  });
});

// Tests for the server registry + clean shutdown (stopServerEntry identity
// checks, registry lifecycle, account filtering, all-scope collection, and
// the shutdown MCP tool validation).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";

import { setupTestEnv, createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { recordServerEntry, readServerRegistry, removeRegistryEntry, stopServerEntry, stopTrackedServers } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { stateBase } from "../plugins/opencode/scripts/lib/state.mjs";
import { handleRpcMessage } from "../plugins/opencode/mcp/server.mjs";

let tmpDir;
test.beforeEach(() => {
  tmpDir = createTmpDir("shutdown-test");
  setupTestEnv(tmpDir);
});
test.afterEach(() => {
  cleanupTmpDir(tmpDir);
});

function ws(name) {
  return path.join(tmpDir, "workspaces", name);
}

function hash16(workspacePath) {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}

/** Spawn a harmless long-lived node process; returns pid. */
function spawnSleeper() {
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  return proc.pid;
}

async function rpc(method, params, id = 1) {
  return handleRpcMessage({ jsonrpc: "2.0", id, method, params });
}

function resultOf(res) {
  return JSON.parse(res.result.content[0].text);
}

test("recordServerEntry + readServerRegistry round-trip", () => {
  const cwd = ws("a");
  recordServerEntry(cwd, { pid: 4242, port: 4321, host: "127.0.0.1", account: null });
  recordServerEntry(cwd, { pid: 4243, port: 4322, host: "127.0.0.1", account: "work" });
  const entries = readServerRegistry(cwd);
  assert.equal(entries.length, 2);
  const byPort = Object.fromEntries(entries.map((e) => [e.port, e]));
  assert.equal(byPort[4321].pid, 4242);
  assert.equal(byPort[4321].cwd, cwd);
  assert.equal(byPort[4322].account, "work");
  assert.ok(byPort[4321].startedAt);
});

test("removeRegistryEntry deletes only its own file", () => {
  const cwd = ws("b");
  recordServerEntry(cwd, { pid: 1, port: 4301, host: "127.0.0.1" });
  recordServerEntry(cwd, { pid: 2, port: 4302, host: "127.0.0.1" });
  removeRegistryEntry(cwd, 4301);
  const entries = readServerRegistry(cwd);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].port, 4302);
});

test("readServerRegistry on missing dir returns []", () => {
  assert.deepEqual(readServerRegistry(ws("never-spawned")), []);
});

test("corrupt registry files are skipped, not thrown", () => {
  const cwd = ws("c");
  recordServerEntry(cwd, { pid: 5, port: 4311, host: "127.0.0.1" });
  fs.writeFileSync(
    path.join(stateBase(), hash16(cwd), "servers", "serve-9999.json"),
    "{broken"
  );
  const entries = readServerRegistry(cwd).filter((e) => e.port === 4311 || e.port === 9999);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].port, 4311);
});

test("stopServerEntry refuses to kill a foreign live process", async () => {
  const sleeper = spawnSleeper();
  try {
    const res = await stopServerEntry({ pid: sleeper, port: 4401 });
    assert.equal(res.outcome, "refused");
    assert.match(res.reason, /not an opencode serve process/);
    // and it is still alive
    process.kill(sleeper, 0); // throws if dead
  } finally {
    try {
      process.kill(sleeper, "SIGKILL");
    } catch {}
  }
});

test("stopServerEntry reports alreadyDead for gone pids", async () => {
  const res = await stopServerEntry({ pid: 999999999, port: 4402 });
  assert.equal(res.outcome, "alreadyDead");
});

test("stopServerEntry rejects nonsense pids", async () => {
  assert.equal((await stopServerEntry({ pid: -1, port: 1 })).outcome, "alreadyDead");
  assert.equal((await stopServerEntry({})).outcome, "alreadyDead");
});

test("stopTrackedServers filters by account and removes cleaned entries", async () => {
  const cwd = ws("d");
  // two entries pointing at long-dead pids -> alreadyDead -> entries removed
  recordServerEntry(cwd, { pid: 999999998, port: 4411, host: "127.0.0.1", account: null });
  recordServerEntry(cwd, { pid: 999999997, port: 4412, host: "127.0.0.1", account: "work" });
  const results = await stopTrackedServers(cwd, { account: "work" });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "alreadyDead");
  assert.equal(results[0].entry.port, 4412);
  const remaining = readServerRegistry(cwd);
  assert.deepEqual(remaining.map((e) => e.port), [4411]);
});

test("refused entries are KEPT in the registry", async () => {
  const cwd = ws("e");
  const sleeper = spawnSleeper();
  try {
    recordServerEntry(cwd, { pid: sleeper, port: 4421, host: "127.0.0.1", account: null });
    const results = await stopTrackedServers(cwd);
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "refused");
    assert.equal(readServerRegistry(cwd).length, 1, "refused entry must stay for later diagnosis");
  } finally {
    removeRegistryEntry(cwd, 4421);
    try {
      process.kill(sleeper, "SIGKILL");
    } catch {}
  }
});

test("shutdown tool validates argument types", async () => {
  const badAll = await rpc("tools/call", { name: "shutdown", arguments: { all: "yes" } });
  assert.equal(badAll.result.isError, true);
  assert.match(resultOf(badAll).error, /all.*boolean/i);

  const badAccount = await rpc("tools/call", { name: "shutdown", arguments: { account: "" } });
  assert.equal(badAccount.result.isError, true);
  assert.match(resultOf(badAccount).error, /account/);
});

test("shutdown with nothing tracked returns empty report", async () => {
  const res = await rpc("tools/call", { name: "shutdown", arguments: { cwd: ws("empty") } });
  assert.equal(res.result.isError, false);
  const out = resultOf(res);
  assert.equal(out.scope, "workspace");
  assert.deepEqual(out.stopped, []);
  assert.deepEqual(out.refused, []);
  assert.deepEqual(out.abortedSessions, []);
  assert.equal(out.jobsCancelled, 0);
});

test("shutdown cleans stale registry entries for a workspace", async () => {
  const cwd = ws("f");
  recordServerEntry(cwd, { pid: 999999996, port: 4431, host: "127.0.0.1", account: null });
  const res = await rpc("tools/call", { name: "shutdown", arguments: { cwd } });
  assert.equal(res.result.isError, false);
  const out = resultOf(res);
  assert.equal(out.alreadyDead.length, 1);
  assert.equal(out.alreadyDead[0].port, 4431);
  assert.equal(readServerRegistry(cwd).length, 0);
});

test("shutdown scope=all collects entries across workspaces", async () => {
  const a = ws("g1");
  const b = ws("g2");
  recordServerEntry(a, { pid: 999999995, port: 4441, host: "127.0.0.1", account: null });
  recordServerEntry(b, { pid: 999999994, port: 4442, host: "127.0.0.1", account: "work" });
  const res = await rpc("tools/call", { name: "shutdown", arguments: { all: true } });
  assert.equal(res.result.isError, false);
  const out = resultOf(res);
  assert.equal(out.scope, "all");
  const ports = [...out.alreadyDead, ...out.stopped].map((x) => x.port).sort();
  assert.ok(ports.includes(4441), "workspace A entry collected");
  assert.ok(ports.includes(4442), "workspace B entry collected");
  assert.equal(readServerRegistry(a).length, 0);
  assert.equal(readServerRegistry(b).length, 0);
});

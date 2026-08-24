// Tests for the doctor diagnostics module (runDiagnostics + formatDoctorReport).
// No real opencode binary is spawned: checkBinaries:false everywhere.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";

import { setupTestEnv, createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runDiagnostics, formatDoctorReport } from "../plugins/opencode/scripts/lib/doctor.mjs";
import { stateBase, stateRoot } from "../plugins/opencode/scripts/lib/state.mjs";

let tmpDir;
test.beforeEach(() => {
  tmpDir = createTmpDir("doctor-test");
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

function writeRegistryEntry(cwd, port, pid) {
  const dir = path.join(stateBase(), hash16(cwd), "servers");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `serve-${port}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ pid, port, host: "127.0.0.1", account: null, cwd, startedAt: new Date().toISOString() })
  );
  return file;
}

function checkOf(report, name) {
  return report.checks.find((c) => c.name === name);
}

test("auth-accounts: all keys set -> pass", async () => {
  process.env.OPENCODE_DELEGATE_KEY_A = "k-a";
  process.env.OPENCODE_DELEGATE_KEY_B = "k-b";
  try {
    const report = await runDiagnostics({
      cwd: ws("acc-ok"),
      config: { accounts: { names: ["a", "b"], strategy: "round-robin" } },
      checkBinaries: false,
    });
    const c = checkOf(report, "auth-accounts");
    assert.equal(c.status, "pass");
    assert.match(c.detail, /a: key set/);
    assert.match(c.detail, /b: key set/);
  } finally {
    delete process.env.OPENCODE_DELEGATE_KEY_A;
    delete process.env.OPENCODE_DELEGATE_KEY_B;
  }
});

test("auth-accounts: some keys missing -> warn", async () => {
  process.env.OPENCODE_DELEGATE_KEY_A = "k-a";
  try {
    const report = await runDiagnostics({
      cwd: ws("acc-partial"),
      config: { accounts: { names: ["a", "b"], strategy: "fixed", default: "a" } },
      checkBinaries: false,
    });
    const c = checkOf(report, "auth-accounts");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /a: key set/);
    assert.match(c.detail, /b: MISSING \(expected env OPENCODE_DELEGATE_KEY_B\)/);
  } finally {
    delete process.env.OPENCODE_DELEGATE_KEY_A;
  }
});

test("auth-accounts: all keys missing -> fail", async () => {
  const report = await runDiagnostics({
    cwd: ws("acc-none"),
    config: { accounts: { names: ["a"] } },
    checkBinaries: false,
  });
  const c = checkOf(report, "auth-accounts");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /MISSING \(expected env OPENCODE_DELEGATE_KEY_A\)/);
  assert.equal(report.ok, false);
});

test("auth-accounts: no accounts block -> legacy pass", async () => {
  for (const config of [null, {}, { provider: "opencode" }]) {
    const report = await runDiagnostics({ cwd: ws("acc-legacy"), config, checkBinaries: false });
    const c = checkOf(report, "auth-accounts");
    assert.equal(c.status, "pass");
    assert.match(c.detail, /no multi-account block \(legacy mode\)/);
  }
});

test("clean environment: ok=true, binary skipped, checks ordered", async () => {
  const cwd = ws("clean");
  const report = await runDiagnostics({ cwd, checkBinaries: false });
  assert.equal(checkOf(report, "opencode-binary").status, "skip");
  assert.equal(checkOf(report, "opencode-binary").detail, undefined);
  assert.equal(report.ok, true);
  assert.equal(report.platform, process.platform);
  assert.equal(report.node, process.version);
  assert.deepEqual(
    report.checks.map((c) => c.name),
    ["opencode-binary", "node-version", "auth-legacy", "auth-accounts", "ports", "registry", "orphan-reaper", "state-dir"],
  );
  assert.match(checkOf(report, "ports").detail, /all derived ports free/);
  assert.match(checkOf(report, "registry").detail, /no tracked servers/);
  assert.ok(fs.existsSync(stateRoot(cwd)), "state-dir created");
});

test("node-version passes on current node", async () => {
  const report = await runDiagnostics({ cwd: ws("nodever"), checkBinaries: false });
  const c = checkOf(report, "node-version");
  assert.equal(c.status, "pass");
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= 18, `current node ${process.version} must satisfy >=18`);
  assert.match(c.detail, new RegExp(`node v?${major}\\.`));
});

test("registry: dead pid entry removed, detail mentions removed 1", async () => {
  const cwd = ws("reg-dead");
  const file = writeRegistryEntry(cwd, 4321, 999999999);
  const report = await runDiagnostics({ cwd, checkBinaries: false });
  const c = checkOf(report, "registry");
  assert.equal(c.status, "pass");
  assert.match(c.detail, /removed 1 stale/);
  assert.equal(fs.existsSync(file), false, "stale entry file must be removed");
});

test("registry: live pid entry warns still running and is kept", async () => {
  const cwd = ws("reg-live");
  const file = writeRegistryEntry(cwd, 4555, process.pid);
  try {
    const report = await runDiagnostics({ cwd, checkBinaries: false });
    const c = checkOf(report, "registry");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /still running/);
    assert.match(c.detail, new RegExp(`pid ${process.pid} \\(port 4555\\)`));
    assert.equal(fs.existsSync(file), true, "live entry must be kept");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("formatDoctorReport: PASS line, deterministic order, PROBLEMS FOUND on fail", async () => {
  const report = await runDiagnostics({ cwd: ws("fmt"), checkBinaries: false });
  const text1 = formatDoctorReport(report);
  const text2 = formatDoctorReport(report);
  assert.equal(text1, text2, "formatting must be deterministic");
  assert.match(text1, /\[PASS\] node-version/);

  const lines = text1.split("\n").slice(1);
  assert.equal(lines.length, report.checks.length);
  report.checks.forEach((c, i) => {
    assert.ok(lines[i].startsWith(`[${c.status.toUpperCase()}] ${c.name}`), `line ${i} follows checks order`);
  });

  const fake = {
    ok: false,
    platform: "test",
    node: "v0.0.0",
    checks: [{ name: "fabricated", status: "fail", detail: "boom" }],
  };
  const badText = formatDoctorReport(fake);
  assert.match(badText.split("\n")[0], /PROBLEMS FOUND/);
  assert.match(badText.split("\n")[0], /^opencode plugin doctor — /);
  assert.match(badText, /\[FAIL\] fabricated: boom/);
});

test("runDiagnostics never throws on bogus cwd (shape intact)", async () => {
  const report = await runDiagnostics({ cwd: "/definitely/not/existing/path/xyz", checkBinaries: false });
  assert.equal(typeof report, "object");
  assert.equal(typeof report.ok, "boolean");
  assert.equal(typeof report.platform, "string");
  assert.equal(typeof report.node, "string");
  assert.equal(Array.isArray(report.checks), true);
  assert.deepEqual(
    report.checks.map((c) => c.name),
    ["opencode-binary", "node-version", "auth-legacy", "auth-accounts", "ports", "registry", "orphan-reaper", "state-dir"],
  );
  for (const c of report.checks) {
    assert.equal(typeof c.name, "string");
    assert.ok(["pass", "warn", "fail", "skip"].includes(c.status), `valid status for ${c.name}`);
  }
});

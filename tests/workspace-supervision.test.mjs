// Tests for v1.9.0 supervision features:
// - resolveCwd validation (absolute + exists + directory) surfaced through tools
// - workspace-diff snapshots (gitBase recorded at delegation, diff since base)
// - fanOut per-task workspaces ({task, cwd?} objects)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

process.env.NODE_ENV = "test";

import { setupTestEnv, createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { snapshotGitHead, diffSinceSnapshot } from "../plugins/opencode/mcp/lib/workspace-diff.mjs";
import { findJobRecord, handleRpcMessage } from "../plugins/opencode/mcp/server.mjs";
import { createJobRecord } from "../plugins/opencode/scripts/lib/tracked-jobs.mjs";
import { upsertJob } from "../plugins/opencode/scripts/lib/state.mjs";

let tmpDir;
test.beforeEach(() => {
  tmpDir = createTmpDir("supervision-test");
  setupTestEnv(tmpDir);
});
test.afterEach(() => {
  cleanupTmpDir(tmpDir);
});

function ws(name) {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function rpc(method, params, id = 1) {
  return handleRpcMessage({ jsonrpc: "2.0", id, method, params });
}

function resultOf(res) {
  return JSON.parse(res.result.content[0].text);
}

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

/** Init a repo with one committed file; returns {dir, sha}. */
function initRepo(name, fileName = "tracked.txt") {
  const dir = ws(name);
  git(dir, "init");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, fileName), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { dir, sha };
}

/* ------------------------------ snapshot + diff --------------------------- */

test("snapshotGitHead returns null outside a repository", () => {
  assert.equal(snapshotGitHead(ws("plain")), null);
});

test("snapshotGitHead returns HEAD sha inside a repo", () => {
  const { dir, sha } = initRepo("repo1");
  assert.equal(snapshotGitHead(dir), sha);
});

test("diffSinceSnapshot: non-repo reports isRepo false", () => {
  const res = diffSinceSnapshot(ws("plain2"));
  assert.equal(res.isRepo, false);
  assert.equal(res.clean, true);
  assert.match(res.note, /not a git repository/);
});

test("diffSinceSnapshot: clean right after snapshot commit", () => {
  const { dir } = initRepo("repo2");
  const base = snapshotGitHead(dir);
  const res = diffSinceSnapshot(dir, { base });
  assert.equal(res.isRepo, true);
  assert.equal(res.clean, true);
  assert.deepEqual(res.files, []);
  assert.equal(res.stat, null);
});

test("diffSinceSnapshot detects modified tracked files with stat", () => {
  const { dir, sha } = initRepo("repo3");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "changed\n");
  const res = diffSinceSnapshot(dir, { base: sha });
  assert.equal(res.clean, false);
  assert.ok(res.files.includes("tracked.txt"));
  assert.match(res.stat, /tracked\.txt/);
});

test("diffSinceSnapshot lists untracked files even without diff", () => {
  const { dir, sha } = initRepo("repo4");
  fs.writeFileSync(path.join(dir, "agent-new-file.md"), "# hi\n");
  const res = diffSinceSnapshot(dir, { base: sha });
  assert.equal(res.clean, false);
  assert.ok(res.files.includes("agent-new-file.md"), `files=${JSON.stringify(res.files)}`);
});

test("diffSinceSnapshot without base diffs against HEAD and says so", () => {
  const { dir } = initRepo("repo5");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "edited\n");
  const res = diffSinceSnapshot(dir);
  assert.equal(res.isRepo, true);
  assert.equal(res.base, null);
  assert.match(res.note, /no snapshot/);
  assert.ok(res.files.includes("tracked.txt"));
});

/* ---------------------------- resolveCwd via tools ------------------------- */

test("wait rejects relative cwd (CWD_NOT_ABSOLUTE)", async () => {
  const res = await rpc("tools/call", {
    name: "wait",
    arguments: { sessionID: "ses_x", cwd: "relative/path" },
  });
  assert.equal(res.result.isError, true);
  assert.match(resultOf(res).error, /absolute path/);
});

test("status rejects nonexistent cwd (CWD_NOT_FOUND)", async () => {
  const missing = path.join(tmpDir, "does-not-exist");
  const res = await rpc("tools/call", {
    name: "status",
    arguments: { cwd: missing },
  });
  assert.equal(res.result.isError, true);
  assert.match(resultOf(res).error, /does not exist/);
});

test("delegate rejects a file as cwd (CWD_NOT_DIRECTORY)", async () => {
  const filePath = path.join(tmpDir, "afile");
  fs.writeFileSync(filePath, "x");
  const res = await rpc("tools/call", {
    name: "delegate",
    arguments: { task: "t", cwd: filePath },
  });
  assert.equal(res.result.isError, true);
  assert.match(resultOf(res).error, /not a directory/);
});

test("diff requires sessionID", async () => {
  const dir = ws("needSid");
  const res = await rpc("tools/call", { name: "diff", arguments: { cwd: dir } });
  assert.equal(res.result.isError, true);
  assert.match(resultOf(res).error, /sessionID/);
});

/* ------------------------------- diff tool -------------------------------- */

test("diff tool reports changes since the job's recorded gitBase", async () => {
  const { dir, sha } = initRepo("repo6");
  // Simulate a delegate job that snapshotted HEAD before running.
  const job = createJobRecord(dir, "delegate", {
    sessionID: "ses_diff1",
    model: "x-preview-f-free",
    gitBase: sha,
    status: "completed",
  });
  upsertJob(dir, { id: job.id, status: "completed" });

  fs.writeFileSync(path.join(dir, "tracked.txt"), "agent edited\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n");

  const res = await rpc("tools/call", {
    name: "diff",
    arguments: { sessionID: "ses_diff1", cwd: dir },
  });
  assert.equal(res.result.isError, false);
  const out = resultOf(res);
  assert.equal(out.jobId, job.id);
  assert.equal(out.base, sha);
  assert.equal(out.isRepo, true);
  assert.equal(out.clean, false);
  assert.ok(out.files.includes("tracked.txt"));
  assert.ok(out.files.includes("untracked.txt"));
  assert.match(out.stat, /tracked\.txt/);
});

test("diff tool on unknown session still diffs against HEAD", async () => {
  const { dir } = initRepo("repo7");
  const res = await rpc("tools/call", {
    name: "diff",
    arguments: { sessionID: "ses_unknown", cwd: dir },
  });
  assert.equal(res.result.isError, false);
  const out = resultOf(res);
  assert.equal(out.jobId, null);
  assert.equal(out.isRepo, true);
  assert.match(out.note, /no snapshot/);
});

/* --------------------------- fanOut per-task cwd -------------------------- */

test("fanOut accepts {task,cwd} objects and validates each cwd", async () => {
  const dir = ws("fo-good");
  // Fill the concurrency cap so the call stops deterministically AFTER
  // task-shape + cwd validation but BEFORE any server spawn.
  for (let i = 0; i < 8; i += 1) {
    const j = createJobRecord(dir, "delegate", { sessionID: `ses_cap_${i}` });
    upsertJob(dir, { id: j.id, status: "running" });
  }
  const res = await rpc("tools/call", {
    name: "fanOut",
    arguments: { tasks: ["task A", { task: "task B", cwd: dir }], cwd: dir },
  });
  assert.equal(res.result.isError, true);
  const text = resultOf(res);
  assert.match(text.error, /delegate limit reached/);
});

test("fanOut rejects object task without task field", async () => {
  const dir = ws("fo-bad");
  const res = await rpc("tools/call", {
    name: "fanOut",
    arguments: { tasks: [{ cwd: dir }] },
  });
  assert.equal(res.result.isError, true);
  assert.match(resultOf(res).error, /tasks\[0\]/);
});

test("fanOut rejects per-task relative cwd", async () => {
  const res = await rpc("tools/call", {
    name: "fanOut",
    arguments: { tasks: [{ task: "t", cwd: "nope/rel" }] },
  });
  assert.equal(res.result.isError, true);
  assert.match(resultOf(res).error, /absolute path/);
});

test("fanOut rejects per-task nonexistent cwd", async () => {
  const missing = path.join(tmpDir, "ghost");
  const res = await rpc("tools/call", {
    name: "fanOut",
    arguments: { tasks: [{ task: "t", cwd: missing }] },
  });
  assert.equal(res.result.isError, true);
  assert.match(resultOf(res).error, /does not exist/);
});

test("findJobRecord falls back to cross-workspace state scan", () => {
  const primary = path.join(tmpDir, "workspaces", "xw-primary");
  const other = path.join(tmpDir, "workspaces", "xw-other");
  fs.mkdirSync(primary, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  createJobRecord(other, "delegate", { sessionID: "ses_xw1", directory: other });
  // direct hit in owning workspace
  assert.equal(findJobRecord(other, "ses_xw1").jobCwd, other);
  // called with PRIMARY cwd -> falls back through stateBase scan to job.directory
  const found = findJobRecord(primary, "ses_xw1");
  assert.ok(found.job, "cross-workspace job found");
  assert.equal(found.jobCwd, other);
  assert.equal(found.job.sessionID, "ses_xw1");
  // miss stays null and keeps caller cwd
  const miss = findJobRecord(primary, "ses_unknown");
  assert.equal(miss.job, null);
  assert.equal(miss.jobCwd, primary);
});

test("DEFAULT_CWD is an absolute directory anchored at startup", async () => {
  const { DEFAULT_CWD } = await import("../plugins/opencode/mcp/server.mjs");
  assert.equal(typeof DEFAULT_CWD, "string");
  assert.ok(path.isAbsolute(DEFAULT_CWD), `default cwd must be absolute: ${DEFAULT_CWD}`);
  const stat = fs.statSync(DEFAULT_CWD);
  assert.ok(stat.isDirectory(), "default cwd must exist and be a directory");
});

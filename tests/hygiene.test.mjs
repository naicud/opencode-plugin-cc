import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  sweepStateDirs,
  stateTtlMsFromEnv,
  reportTtlMsFromEnv,
  DEFAULT_STATE_TTL_MS,
  DEFAULT_REPORT_TTL_MS,
} from "../plugins/opencode/scripts/lib/hygiene.mjs";

let base;
let wsRoot;
const DAY = 24 * 60 * 60 * 1000;

function makeHashDir(name) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function age(p, days) {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
}

beforeEach(() => {
  base = createTmpDir("hygiene-base");
  wsRoot = createTmpDir("hygiene-ws");
});

afterEach(() => {
  cleanupTmpDir(base);
  cleanupTmpDir(wsRoot);
});

describe("hygiene sweepStateDirs", () => {
  it("removes a whole stale workspace dir with no live servers", () => {
    const dir = makeHashDir("aaaa1111");
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');
    age(path.join(dir, "state.json"), 20);
    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.equal(res.removedDirs.length, 1);
    assert.ok(!fs.existsSync(dir));
    assert.equal(res.errors.length, 0);
  });

  it("keeps a fresh workspace dir", () => {
    const dir = makeHashDir("bbbb2222");
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');
    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.deepEqual(res.removedDirs, []);
    assert.equal(res.keptDirs, 1);
    assert.ok(fs.existsSync(dir));
  });

  it("live tracked server freezes an ancient dir; dead pid does not", () => {
    const liveDir = makeHashDir("cccc3333");
    fs.mkdirSync(path.join(liveDir, "servers"));
    fs.writeFileSync(path.join(liveDir, "servers", "serve-4100.json"), JSON.stringify({ pid: 111, port: 4100 }));

    const deadDir = makeHashDir("dddd4444");
    fs.mkdirSync(path.join(deadDir, "servers"));
    fs.writeFileSync(path.join(deadDir, "servers", "serve-4200.json"), JSON.stringify({ pid: 222, port: 4200 }));

    // Age entire trees (dirs included) so only liveness differs.
    for (const d of [liveDir, path.join(liveDir, "servers"), deadDir, path.join(deadDir, "servers")]) {
      age(d, 90);
    }
    for (const f of [
      path.join(liveDir, "servers", "serve-4100.json"),
      path.join(deadDir, "servers", "serve-4200.json"),
    ]) {
      age(f, 90);
    }

    const res = sweepStateDirs({
      baseDir: base,
      now: new Date(),
      stateTtlMs: 14 * DAY,
      reportTtlMs: null,
      isAlive: (pid) => pid === 111,
    });
    assert.ok(fs.existsSync(liveDir), "live-server dir must survive despite age");
    assert.ok(!fs.existsSync(deadDir), "dead-pid dir must be swept");
    assert.equal(res.removedDirs.length, 1);
  });

  it("prunes orphaned job files inside a kept dir, never referenced ones", () => {
    const dir = makeHashDir("eeee5555");
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ jobs: [{ id: "task-keep" }] }));
    fs.writeFileSync(path.join(jobsDir, "task-keep.log"), "keep me");
    fs.writeFileSync(path.join(jobsDir, "task-gone.log"), "orphan");
    fs.writeFileSync(path.join(jobsDir, "task-gone.json"), "{}");
    age(path.join(jobsDir, "task-gone.log"), 20);
    age(path.join(jobsDir, "task-gone.json"), 20);
    age(path.join(jobsDir, "task-keep.log"), 20);

    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.deepEqual(res.removedJobFiles.sort(), ["task-gone.json", "task-gone.log"]);
    assert.ok(fs.existsSync(path.join(jobsDir, "task-keep.log")));
  });

  it("never touches young files even when orphaned (spawn-race safety)", () => {
    const dir = makeHashDir("ffff6666");
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');
    fs.writeFileSync(path.join(jobsDir, "task-new.log"), "just born");
    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.deepEqual(res.removedJobFiles, []);
    assert.ok(fs.existsSync(path.join(jobsDir, "task-new.log")));
  });

  it("removes crash-leftover .tmp.* files past the TTL", () => {
    const dir = makeHashDir("aaaa7777");
    const jobsDir = path.join(dir, "jobs");
    fs.mkdirSync(jobsDir);
    fs.writeFileSync(path.join(dir, "state.json.tmp.999"), "{}");
    fs.writeFileSync(path.join(jobsDir, "task-x.json.tmp.999"), "{}");
    age(path.join(dir, "state.json.tmp.999"), 20);
    age(path.join(jobsDir, "task-x.json.tmp.999"), 20);
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');

    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.equal(res.removedTmpFiles.length, 2);
    assert.equal(fs.readdirSync(jobsDir).length, 0);
  });

  it("removes base-level crash leftovers (activity-buffer.json.tmp.*) but never the buffer itself", () => {
    fs.writeFileSync(path.join(base, "activity-buffer.json.tmp.4242"), "{}");
    fs.writeFileSync(path.join(base, "activity-buffer.json"), "{}");
    age(path.join(base, "activity-buffer.json.tmp.4242"), 20);
    const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
    assert.ok(res.removedTmpFiles.includes("activity-buffer.json.tmp.4242"));
    assert.ok(!fs.existsSync(path.join(base, "activity-buffer.json.tmp.4242")));
    assert.ok(fs.existsSync(path.join(base, "activity-buffer.json")), "live buffer must survive");
  });

  describe(".oc-report.md reaper", () => {
    function workspaceWithReport(name, jobStatus) {
      const ws = path.join(wsRoot, `ws-${name}`);
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(path.join(ws, ".oc-report.md"), `STATUS: COMPLETED\n${name}`);
      const dir = makeHashDir(`hash-${name}`);
      fs.writeFileSync(
        path.join(dir, "state.json"),
        JSON.stringify({ jobs: [{ id: `task-${name}`, directory: ws, status: jobStatus }] })
      );
      return ws;
    }

    it("deletes consumed old reports in known workspaces only", () => {
      const ws = workspaceWithReport("old1", "completed");
      age(path.join(ws, ".oc-report.md"), 10);
      const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: 7 * DAY });
      assert.deepEqual(res.removedReports, [path.join(ws, ".oc-report.md")]);
      assert.ok(!fs.existsSync(path.join(ws, ".oc-report.md")));
      assert.ok(fs.existsSync(ws), "the workspace itself is NEVER touched");
    });

    it("keeps fresh reports and workspaces with running jobs", () => {
      const freshWs = workspaceWithReport("fresh", "completed");
      const runningWs = workspaceWithReport("runningjob", "running");
      age(path.join(runningWs, ".oc-report.md"), 30);
      const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: 7 * DAY });
      assert.deepEqual(res.removedReports, []);
      assert.ok(fs.existsSync(path.join(freshWs, ".oc-report.md")));
      assert.ok(fs.existsSync(path.join(runningWs, ".oc-report.md")));
    });

    it("reportTtlMs:null disables report cleanup entirely", () => {
      const ws = workspaceWithReport("off", "completed");
      age(path.join(ws, ".oc-report.md"), 365);
      const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
      assert.deepEqual(res.removedReports, []);
      assert.ok(fs.existsSync(path.join(ws, ".oc-report.md")));
    });

    it("reaps per-job reports under .oc-reports/ and drops the empty dir", () => {
      const ws = path.join(wsRoot, "ws-fanout");
      fs.mkdirSync(path.join(ws, ".oc-reports"), { recursive: true });
      const oldReport = path.join(ws, ".oc-reports", "task-old.md");
      const freshReport = path.join(ws, ".oc-reports", "task-new.md");
      fs.writeFileSync(oldReport, "STATUS: COMPLETED\nold job");
      fs.writeFileSync(freshReport, "STATUS: COMPLETED\nnew job");
      age(oldReport, 30);
      const dir = makeHashDir("hash-fanout");
      fs.writeFileSync(
        path.join(dir, "state.json"),
        JSON.stringify({
          jobs: [
            { id: "task-old", directory: ws, status: "completed" },
            { id: "task-new", directory: ws, status: "completed" },
          ],
        })
      );

      const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: 7 * DAY });
      assert.ok(res.removedReports.includes(oldReport));
      assert.ok(!fs.existsSync(oldReport), "stale per-job report reaped");
      assert.ok(fs.existsSync(freshReport), "fresh per-job report survives");
      assert.ok(fs.existsSync(path.join(ws, ".oc-reports")), "non-empty dir kept");

      // Once everything inside is gone the dir itself is removed.
      fs.rmSync(freshReport);
      sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: 7 * DAY });
      assert.ok(!fs.existsSync(path.join(ws, ".oc-reports")), "empty .oc-reports dir removed");
    });

    it("ignores unknown workspaces (only plugin-known paths are swept)", () => {
      const stranger = path.join(wsRoot, "stranger-ws");
      fs.mkdirSync(stranger);
      fs.writeFileSync(path.join(stranger, ".oc-report.md"), "not ours");
      age(path.join(stranger, ".oc-report.md"), 400);
      const res = sweepStateDirs({ baseDir: base, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: 7 * DAY });
      assert.deepEqual(res.removedReports, []);
      assert.ok(fs.existsSync(path.join(stranger, ".oc-report.md")));
    });
  });

  it("dryRun counts everything and deletes nothing", () => {
    const dir = makeHashDir("aaaa8888");
    fs.writeFileSync(path.join(dir, "state.json"), '{"jobs":[]}');
    age(path.join(dir, "state.json"), 40);
    const res = sweepStateDirs({
      baseDir: base,
      now: new Date(),
      stateTtlMs: 14 * DAY,
      reportTtlMs: null,
      dryRun: true,
    });
    assert.equal(res.removedDirs.length, 1);
    assert.ok(fs.existsSync(dir), "dry run must not delete");
  });

  it("refuses to sweep / or the home directory root itself", async () => {
    const os = await import("node:os");
    for (const dangerous of [os.homedir()]) {
      const res = sweepStateDirs({ baseDir: dangerous, now: new Date(), stateTtlMs: 14 * DAY, reportTtlMs: null });
      assert.match(res.errors[0], /refusing to sweep unsafe root/);
      assert.equal(res.scanned, 0);
    }
  });

  it("env knobs parse: defaults, overrides and disable-by-zero", () => {
    delete process.env.OPENCODE_STATE_TTL_DAYS;
    delete process.env.OPENCODE_REPORT_TTL_DAYS;
    assert.equal(stateTtlMsFromEnv(), DEFAULT_STATE_TTL_MS);
    assert.equal(reportTtlMsFromEnv(), DEFAULT_REPORT_TTL_MS);
    process.env.OPENCODE_STATE_TTL_DAYS = "3";
    process.env.OPENCODE_REPORT_TTL_DAYS = "0";
    assert.equal(stateTtlMsFromEnv(), 3 * DAY);
    assert.equal(reportTtlMsFromEnv(), null);
    process.env.OPENCODE_STATE_TTL_DAYS = "0";
    assert.equal(stateTtlMsFromEnv(), null, "0 disables the whole sweep");
    delete process.env.OPENCODE_STATE_TTL_DAYS;
    delete process.env.OPENCODE_REPORT_TTL_DAYS;
  });

  it("reaps abandoned oc-e2e/oc-demo/oc-bench temp workspaces in tmpdir", async () => {
    const os = await import("node:os");
    const tmpRoot = createTmpDir("hygiene-tmp");
    const stale = path.join(tmpRoot, "oc-e2e-abcd");
    const fresh = path.join(tmpRoot, "oc-demo-efgh");
    const foreign = path.join(tmpRoot, "not-ours-e2e-");
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    fs.mkdirSync(foreign);
    age(path.join(stale), 30);
    const res = sweepStateDirs({
      baseDir: base,
      now: new Date(),
      stateTtlMs: 14 * DAY,
      reportTtlMs: null,
      tmpDir: tmpRoot,
    });
    assert.ok(res.removedDirs.includes("oc-e2e-abcd"), "stale dev workspace reaped");
    assert.ok(!fs.existsSync(stale));
    assert.ok(fs.existsSync(fresh), "fresh dev workspace survives");
    assert.ok(fs.existsSync(foreign), "non-plugin dirs never touched");

    // dryRun leaves everything in place
    const dry = sweepStateDirs({
      baseDir: base,
      now: new Date(),
      stateTtlMs: 14 * DAY,
      reportTtlMs: null,
      tmpDir: tmpRoot,
      dryRun: true,
    });
    cleanupTmpDir(tmpRoot);
    assert.ok(Array.isArray(dry.removedDirs));
  });
});

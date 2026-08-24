import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "plugins", "opencode", "mcp", "server.mjs");
// Windows ESM loader rejects plain absolute paths ("D:\...") — import via URL.
const { readReportSnapshot } = await import(pathToFileURL(SERVER).href);

describe("report snapshot delivery", () => {
  it("first read returns content; later reads only confirm delivery", () => {
    const ws = createTmpDir("report-ws");
    try {
      fs.writeFileSync(path.join(ws, ".oc-report.md"), "STATUS: COMPLETED\ndid the thing\nverified: npm test");
      const first = readReportSnapshot(ws, "task-1");
      assert.equal(first.status, "STATUS: COMPLETED");
      assert.match(first.content, /did the thing/);
      assert.equal(first.truncated, false);
      assert.equal(first.deliveredBefore, undefined);

      const second = readReportSnapshot(ws, "task-1");
      assert.equal(second.deliveredBefore, true);
      assert.equal(second.content, undefined, "content delivered exactly once per job");

      assert.equal(readReportSnapshot(ws, null).status, "STATUS: COMPLETED");
      assert.equal(readReportSnapshot(path.join(ws, "missing"), "x"), null);
    } finally {
      cleanupTmpDir(ws);
    }
  });

  it("prefers the per-job .oc-reports/<jobId>.md over the legacy root file", () => {
    const ws = createTmpDir("report-precedence");
    try {
      fs.mkdirSync(path.join(ws, ".oc-reports"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".oc-report.md"), "STATUS: STALE\nlegacy root");
      const jobFile = path.join(ws, ".oc-reports", "task-7.md");
      fs.writeFileSync(jobFile, "STATUS: COMPLETED\nper-job wins");

      const snap = readReportSnapshot(ws, "task-7");
      assert.equal(snap.path, jobFile, "job-specific report must win over root");
      assert.equal(snap.status, "STATUS: COMPLETED");
      assert.match(snap.content, /per-job wins/);

      // No per-job file → falls back to the legacy root report.
      assert.equal(readReportSnapshot(ws, "task-missing").content.includes("legacy root"), true);
    } finally {
      cleanupTmpDir(ws);
    }
  });

  it("oversized reports are capped and flagged truncated", () => {
    const ws = createTmpDir("report-big");
    try {
      fs.writeFileSync(path.join(ws, ".oc-report.md"), "X".repeat(20_000));
      const snap = readReportSnapshot(ws, "task-big");
      assert.equal(snap.truncated, true);
      assert.equal(snap.content.length <= 8000, true);
      assert.equal(snap.chars, 20_000);
    } finally {
      cleanupTmpDir(ws);
    }
  });

  it("missing workspace without report returns null (never throws)", () => {
    assert.equal(readReportSnapshot("/definitely/not/a/real/dir-oc-test", "task-none"), null);
  });
});

describe("toolModels duplicate-key tripwire", () => {
  it("budget appears exactly once in the models result object", async () => {
    const src = fs.readFileSync(SERVER, "utf8");
    // The old bug had `budget:` twice in toolModels' return literal (last key
    // silently wins). Guard against it coming back.
    const matches = src.match(/^\s*budget: .*$/gm) ?? [];
    assert.equal(matches.length, 1, `expected a single budget key, found:\n${matches.join("\n")}`);
    assert.match(matches[0], /summarizeBudget/);
  });
});

// Validation tests for the fanOut tool argument handling (no server needed:
// all failure paths throw before any spawn).

import test from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv, createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { handleRpcMessage } from "../plugins/opencode/mcp/server.mjs";

let tmpDir;
test.beforeEach(() => {
  tmpDir = createTmpDir("fanout-test");
  setupTestEnv(tmpDir);
});
test.afterEach(() => {
  cleanupTmpDir(tmpDir);
});

async function call(args) {
  const res = await handleRpcMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "fanOut", arguments: args },
  });
  return { isError: res.result.isError, payload: JSON.parse(res.result.content[0].text) };
}

test("tasks missing / empty / non-array → TASKS_REQUIRED", async () => {
  for (const bad of [{}, { tasks: [] }, { tasks: "two" }, { tasks: null }]) {
    const r = await call(bad);
    assert.equal(r.isError, true);
    assert.equal(r.payload.code, "TASKS_REQUIRED");
  }
});

test("more than 12 tasks → TASKS_TOO_MANY", async () => {
  const tasks = Array.from({ length: 13 }, (_, i) => `task ${i}`);
  const r = await call({ tasks });
  assert.equal(r.isError, true);
  assert.equal(r.payload.code, "TASKS_TOO_MANY");
});

test("non-string or blank task entries → TASKS_INVALID with index", async () => {
  for (const [tasks, index] of [
    [["ok", 42], 1],
    [["ok", ""], 1],
    [["ok", "   "], 1],
    [[null], 0],
  ]) {
    const r = await call({ tasks });
    assert.equal(r.isError, true, JSON.stringify(tasks));
    assert.equal(r.payload.code, "TASKS_INVALID");
    assert.match(r.payload.error, new RegExp(`tasks\\[${index}\\]`));
  }
});

test("blank titlePrefix → TITLE_PREFIX_INVALID", async () => {
  const r = await call({ tasks: ["ok"], titlePrefix: "  " });
  assert.equal(r.isError, true);
  assert.equal(r.payload.code, "TITLE_PREFIX_INVALID");
});

test("12 tasks pass validation (fails later at cap/catalog, not on shape)", async () => {
  const tasks = Array.from({ length: 12 }, (_, i) => `task ${i}`);
  const r = await call({ tasks });
  // With default config (cap 8) this trips DELEGATE_LIMIT_EXCEEDED — which
  // proves the batch-size validation itself passed.
  assert.equal(r.isError, true);
  assert.equal(r.payload.code, "DELEGATE_LIMIT_EXCEEDED");
});

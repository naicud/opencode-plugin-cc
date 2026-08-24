// Tests for persona selection (builder/reviewer) and waitAll waitFor
// early-exit validation — all at the JSON-RPC validation layer, no live
// server contact required.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

import {
  PERSONAS,
  buildAgentConfigContent,
  validateAgentConfigContent,
} from "../plugins/opencode/mcp/lib/agent.mjs";
import { handleRpcMessage } from "../plugins/opencode/mcp/server.mjs";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

let tmpDir;
test.beforeEach(() => {
  tmpDir = createTmpDir("personas-test");
});
test.afterEach(() => {
  cleanupTmpDir(tmpDir);
});

function ws() {
  const dir = path.join(tmpDir, "ws");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function call(name, args, id = 1) {
  return handleRpcMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

test("PERSONAS maps builder/reviewer to server-side agent names", () => {
  assert.deepEqual(PERSONAS, { builder: "oc-delegate", reviewer: "oc-reviewer" });
});

test("buildAgentConfigContent defines BOTH agents with correct modes", () => {
  const content = buildAgentConfigContent("CONTRACT-TEXT");
  assert.equal(typeof content.agent["oc-delegate"].prompt, "string");
  assert.ok(content.agent["oc-delegate"].prompt.includes("CONTRACT-TEXT"));
  assert.equal(content.agent["oc-delegate"].mode, "subagent");
  assert.equal(content.agent["oc-delegate"].permission.edit, "allow");

  assert.equal(content.agent["oc-reviewer"].mode, "subagent");
  assert.ok(content.agent["oc-reviewer"].prompt.includes("CONTRACT-TEXT"));
  // reviewer is read-only except for the mandatory report:
  // edits must surface through the pending-permission flow.
  assert.equal(content.agent["oc-reviewer"].permission.edit, "ask");
});

test("validator accepts the built fragment and rejects broken ones", () => {
  validateAgentConfigContent(buildAgentConfigContent("X")); // must not throw

  assert.throws(
    () => validateAgentConfigContent({ agent: { "oc-delegate": { mode: "subagent", prompt: "x" } } }),
    /oc-reviewer/
  );
  assert.throws(
    () =>
      validateAgentConfigContent({
        agent: {
          "oc-delegate": { mode: "subagent", prompt: "x" },
          "oc-reviewer": { mode: "subagent", prompt: "" },
        },
      }),
    /prompt/
  );
  assert.throws(
    () =>
      validateAgentConfigContent({
        agent: {
          "oc-delegate": { mode: "subagent", prompt: "x" },
          "oc-reviewer": { mode: "wizard", prompt: "y" },
        },
      }),
    /mode/
  );
});

test("delegate rejects an unknown persona before any server work", async () => {
  const res = await call("delegate", { task: "do something", cwd: ws(), persona: "ninja" });
  assert.equal(res.result.isError, true);
  assert.equal(JSON.parse(res.result.content[0].text).code, "PERSONA_INVALID");
});

test("fanOut rejects an unknown persona", async () => {
  const res = await call("fanOut", { tasks: ["a"], cwd: ws(), persona: "ghost" });
  assert.equal(res.result.isError, true);
  assert.equal(JSON.parse(res.result.content[0].text).code, "PERSONA_INVALID");
});

const FAKE_IDS = ["ses_fake_aaaaaaaaaaaa", "ses_fake_bbbbbbbbbbbb"];

test("waitAll waitFor=0 is invalid", async () => {
  const res = await call("waitAll", { sessionIDs: FAKE_IDS, cwd: ws(), waitFor: 0 });
  assert.equal(res.result.isError, true);
  assert.equal(JSON.parse(res.result.content[0].text).code, "WAIT_FOR_INVALID");
});

test("waitAll waitFor greater than ids length is invalid", async () => {
  const res = await call("waitAll", { sessionIDs: FAKE_IDS, cwd: ws(), waitFor: 3 });
  assert.equal(res.result.isError, true);
  assert.equal(JSON.parse(res.result.content[0].text).code, "WAIT_FOR_INVALID");
});

test("waitAll waitFor non-integer is invalid", async () => {
  const res = await call("waitAll", { sessionIDs: FAKE_IDS, cwd: ws(), waitFor: "2" });
  assert.equal(res.result.isError, true);
  assert.equal(JSON.parse(res.result.content[0].text).code, "WAIT_FOR_INVALID");
});
// NOTE: no positive-path unit test here — a valid waitFor proceeds to real
// waits (server spawn). Live coverage lives in e2e/stress suites by design.

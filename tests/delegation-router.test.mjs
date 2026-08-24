// Tests for the autonomous delegation-routing classifier + PreToolUse hook.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyDelegation } from "../plugins/opencode/mcp/lib/delegation-router.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "opencode", "scripts", "delegation-router-hook.mjs");

test("build/test/refactor prompts route to delegation", () => {
  const v = classifyDelegation({ description: "Run the full build and tests", prompt: "npm run build && npm test" });
  assert.equal(v.route, true);
  assert.match(v.reason, /heavy-workload signals/);
});

test("review/audit prompts route to delegation", () => {
  const v = classifyDelegation({ description: "Adversarial review of the auth module", prompt: "audit every guard" });
  assert.equal(v.route, true);
});

test("explore/find quick tasks do NOT route", () => {
  const v = classifyDelegation({ description: "Find where the config is read", prompt: "quick lookup" });
  assert.equal(v.route, false);
});

test("empty input never routes", () => {
  assert.equal(classifyDelegation({}).route, false);
  assert.equal(classifyDelegation({ description: "", prompt: "" }).route, false);
});

test("long prompt adds a point toward routing", () => {
  const base = { description: "Implement the feature", prompt: "x".repeat(1300) };
  const withLength = classifyDelegation(base);
  const withoutLength = classifyDelegation({ ...base, prompt: "implement" });
  assert.ok(withLength.score > withoutLength.score);
});

test("generalist subagent_type adds a point", () => {
  const v = classifyDelegation({ description: "Run lint", prompt: "fix warnings", subagent_type: "general" });
  assert.ok(v.score >= 3);
});

function runHook(payload) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    timeout: 15000,
  });
}

test("hook emits allow decision with delegation advice for heavy tasks", () => {
  const res = runHook({
    tool_name: "Task",
    tool_input: { description: "Run the build and tests", prompt: "npm run build; npm test" },
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /mcp__plugin_opencode_oc__delegate/);
});

test("hook stays silent for light tasks", () => {
  const res = runHook({
    tool_name: "Task",
    tool_input: { description: "Find the entry file", prompt: "quick search" },
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "");
});

test("hook ignores non-Task tools", () => {
  const res = runHook({
    tool_name: "Bash",
    tool_input: { command: "npm run build && npm test" },
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "");
});

test("hook survives garbage stdin", () => {
  for (const payload of ["", "not json", "{broken"]) {
    const res = runHook(payload);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  }
});

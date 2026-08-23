// Tests for the server-side oc-delegate agent definition.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentConfigContent,
  validateAgentConfigContent,
  AGENT_NAME,
} from "../plugins/opencode/mcp/lib/agent.mjs";

test("AGENT_NAME is stable", () => {
  assert.equal(AGENT_NAME, "oc-delegate");
});

test("buildAgentConfigContent embeds the contract in the prompt", () => {
  const content = buildAgentConfigContent("Workspace: ${cwd}\nWrite .oc-report.md");
  const agent = content.agent[AGENT_NAME];
  assert.ok(agent);
  assert.equal(agent.mode, "subagent");
  assert.match(agent.prompt, /oc-report\.md/);
  assert.match(agent.prompt, /Never push, commit/);
  assert.equal(agent.permission.edit, "allow");
});

test("validateAgentConfigContent accepts a well-formed payload", () => {
  const content = buildAgentConfigContent("contract text");
  assert.doesNotThrow(() => validateAgentConfigContent(content));
});

test("validateAgentConfigContent rejects non-objects", () => {
  assert.throws(() => validateAgentConfigContent(null), /must be an object/);
  assert.throws(() => validateAgentConfigContent([1]), /must be an object/);
  assert.throws(() => validateAgentConfigContent("x"), /must be an object/);
});

test("validateAgentConfigContent rejects missing or malformed agent entry", () => {
  assert.throws(() => validateAgentConfigContent({}), /missing "oc-delegate"/);
  assert.throws(
    () => validateAgentConfigContent({ agent: { [AGENT_NAME]: { mode: "subagent" } } }),
    /prompt must be a non-empty string/
  );
  assert.throws(
    () => validateAgentConfigContent({ agent: { [AGENT_NAME]: { prompt: "p", mode: "bogus" } } }),
    /mode must be subagent\|primary\|all/
  );
});

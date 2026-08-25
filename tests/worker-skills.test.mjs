// Tests for worker-side skill injection: digest loader, per-call validation,
// and spawn-time baking into the injected oc-delegate/oc-reviewer agents.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SKILL_NAMES,
  SKILLS_DIR,
  DEFAULT_BUILDER_SKILLS,
  DEFAULT_REVIEWER_SKILLS,
  MAX_SKILLS_PER_CALL,
  loadSkillBody,
  resolveSkillNames,
  renderSkillDigest,
} from "../plugins/opencode/mcp/lib/skills.mjs";

import {
  buildAgentConfigContent,
  validateAgentConfigContent,
  AGENT_NAME,
} from "../plugins/opencode/mcp/lib/agent.mjs";
import fs from "node:fs";
import path from "node:path";

test("every declared skill exists on disk", () => {
  for (const name of SKILL_NAMES) {
    const file = path.join(SKILLS_DIR, name, "SKILL.md");
    assert.ok(fs.existsSync(file), `missing ${file}`);
  }
});

test("loadSkillBody strips frontmatter and keeps the body", () => {
  const body = loadSkillBody("opencode-prompting");
  assert.ok(!body.startsWith("---"), "frontmatter must be stripped");
  assert.match(body, /Prompt Structure|prompt/i);
  assert.ok(body.length > 100);
});

test("loadSkillBody rejects unknown skills", () => {
  assert.throws(() => loadSkillBody("nope"), /SKILL_INVALID|unknown skill/);
});

test("resolveSkillNames validates, dedupes and caps", () => {
  assert.deepEqual(resolveSkillNames(null), []);
  assert.deepEqual(resolveSkillNames(undefined), []);
  assert.deepEqual(resolveSkillNames(["opencode-prompting", "opencode-prompting"]), [
    "opencode-prompting",
  ]);
  assert.throws(() => resolveSkillNames("opencode-prompting"), /must be an array/);
  assert.throws(() => resolveSkillNames([42]), /must be an array/);
  assert.throws(() => resolveSkillNames(["bogus"]), /unknown skill "bogus"/);
  assert.throws(
    () =>
      resolveSkillNames([
        "opencode-prompting",
        "opencode-routing",
        "opencode-runtime",
        "opencode-delegation",
      ]),
    /at most 3/
  );
  assert.equal(MAX_SKILLS_PER_CALL, 3);
});

test("renderSkillDigest returns empty string for empty input", () => {
  assert.equal(renderSkillDigest([]), "");
  assert.equal(renderSkillDigest(null), "");
});

test("renderSkillDigest embeds skill bodies under a marker", () => {
  const text = renderSkillDigest(["opencode-prompting"]);
  assert.match(text, /^\[PLUGIN SKILLS\]/);
  assert.match(text, /# opencode-prompting\n/);
  assert.doesNotMatch(text, /^---/m);
});

const contract = "Workspace: ${cwd}\nWrite .oc-report.md with a STATUS line.";

test("builder agent bakes default skills into its prompt", () => {
  const content = buildAgentConfigContent(contract);
  const agent = content.agent[AGENT_NAME];
  assert.match(agent.prompt, /\[PLUGIN SKILLS\]/);
  assert.match(agent.prompt, /# opencode-prompting/);
  validateAgentConfigContent(content); // still well-formed
});

test("reviewer agent has no baked skills by default", () => {
  const content = buildAgentConfigContent(contract);
  assert.doesNotMatch(content.agent["oc-reviewer"].prompt, /\[PLUGIN SKILLS\]/);
});

test("skill options are honored and can be disabled", () => {
  const custom = buildAgentConfigContent(contract, {
    builderSkills: ["opencode-result-handling"],
    reviewerSkills: ["opencode-prompting"],
  });
  assert.match(custom.agent[AGENT_NAME].prompt, /# opencode-result-handling/);
  assert.doesNotMatch(custom.agent[AGENT_NAME].prompt, /# opencode-prompting/);
  assert.match(custom.agent["oc-reviewer"].prompt, /\[PLUGIN SKILLS\]\n\n# opencode-prompting|PLUGIN SKILLS/);

  const none = buildAgentConfigContent(contract, { builderSkills: [], reviewerSkills: [] });
  assert.doesNotMatch(none.agent[AGENT_NAME].prompt, /\[PLUGIN SKILLS\]/);
  assert.doesNotMatch(none.agent["oc-reviewer"].prompt, /\[PLUGIN SKILLS\]/);
  validateAgentConfigContent(none);
});

test("defaults are exported as expected", () => {
  assert.deepEqual(DEFAULT_BUILDER_SKILLS, ["opencode-prompting"]);
  assert.deepEqual(DEFAULT_REVIEWER_SKILLS, []);
});

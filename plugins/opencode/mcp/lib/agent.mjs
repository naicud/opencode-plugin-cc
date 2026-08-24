// Server-side delegation agent definitions.
// The plugin injects TWO agents into every spawned OpenCode server via
// OPENCODE_CONFIG_CONTENT (verified upstream behavior: env config content
// MERGES over the user's config — our agent keys are added, existing keys are
// kept). This moves work contracts from prompt-only enforcement to
// server-side agent definitions:
//   - oc-delegate  ("builder"): full task executor, may edit files
//   - oc-reviewer  ("reviewer"): read-only reviewer, may ONLY write .oc-report.md

const AGENT_NAME = "oc-delegate";
const REVIEWER_AGENT_NAME = "oc-reviewer";

/** persona argument value -> injected OpenCode agent name */
export const PERSONAS = {
  builder: AGENT_NAME,
  reviewer: REVIEWER_AGENT_NAME,
};

function header(kind, contractText) {
  return [
    `You are executing a delegated ${kind} inside Claude Code's opencode delegation runtime.`,
    "Follow the operating contract below EXACTLY. It overrides your defaults.",
    "",
    contractText,
  ].join("\n");
}

/**
 * Build the config fragment defining the plugin's agents.
 * @param {string} contractText - rendered work contract (config.models.json `contract`, ${cwd} resolved)
 * @returns {{ agent: Record<string, object> }} config fragment for OPENCODE_CONFIG_CONTENT
 */
export function buildAgentConfigContent(contractText) {
  const builderPrompt = [
    header("task", contractText),
    "",
    "Additional hard rules:",
    "- Never push, commit, or modify anything outside the stated workspace.",
    "- Finish only after the verification command in the task succeeds.",
  ].join("\n");

  const reviewerPrompt = [
    header("code review", contractText),
    "",
    "Additional hard rules:",
    "- READ-ONLY review: do NOT modify, create, or delete any project file.",
    "- The ONLY file you may write is .oc-report.md (findings + STATUS line).",
    "- Never push or commit.",
  ].join("\n");

  return {
    agent: {
      [PERSONAS.builder]: {
        description: "Delegated task executor for the opencode-plugin-cc MCP runtime",
        mode: "subagent",
        prompt: builderPrompt,
        permission: {
          edit: "allow",
          webfetch: "allow",
          bash: "allow",
        },
      },
      [PERSONAS.reviewer]: {
        description: "Read-only reviewer for the opencode-plugin-cc MCP runtime",
        mode: "subagent",
        prompt: reviewerPrompt,
        permission: {
          edit: "ask",
          webfetch: "allow",
          bash: "allow",
        },
      },
    },
  };
}

/**
 * Validate a parsed OPENCODE_CONFIG_CONTENT payload that carries our agents
 * (P8-class guard: malformed config content yields healthy-but-degraded servers).
 * @param {object} content
 */
export function validateAgentConfigContent(content) {
  if (content == null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("agent config content must be an object");
  }
  for (const name of Object.values(PERSONAS)) {
    const agent = content.agent?.[name];
    if (!agent || typeof agent !== "object") {
      throw new Error(`agent config content missing "${name}" entry`);
    }
    if (typeof agent.prompt !== "string" || agent.prompt.length === 0) {
      throw new Error(`agent "${name}" prompt must be a non-empty string`);
    }
    if (!["subagent", "primary", "all"].includes(agent.mode)) {
      throw new Error(`agent "${name}" mode must be subagent|primary|all`);
    }
  }
}

export { AGENT_NAME };

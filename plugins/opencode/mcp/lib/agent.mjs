// Server-side delegation agent definition.
// The plugin injects an "oc-delegate" agent into every spawned OpenCode
// server via OPENCODE_CONFIG_CONTENT (verified upstream behavior: env config
// content MERGES over the user's config — our agent key is added, existing
// keys are kept). This moves the work contract (.oc-report.md obligation,
// workspace restriction) from prompt-only enforcement to server-side agent
// definition: every delegated session starts with it baked in.

const AGENT_NAME = "oc-delegate";

/**
 * Build the config fragment defining the oc-delegate agent.
 * @param {string} contractText - rendered work contract (config.models.json `contract`, ${cwd} resolved)
 * @returns {{ agent: Record<string, object> }} config fragment for OPENCODE_CONFIG_CONTENT
 */
export function buildAgentConfigContent(contractText) {
  const prompt = [
    "You are executing a delegated task inside Claude Code's opencode delegation runtime.",
    "Follow the operating contract below EXACTLY. It overrides your defaults.",
    "",
    contractText,
    "",
    "Additional hard rules:",
    "- Never push, commit, or modify anything outside the stated workspace.",
    "- Finish only after the verification command in the task succeeds.",
  ].join("\n");

  return {
    agent: {
      [AGENT_NAME]: {
        description: "Delegated task executor for the opencode-plugin-cc MCP runtime",
        mode: "subagent",
        prompt,
        permission: {
          edit: "allow",
          webfetch: "allow",
          bash: "allow",
        },
      },
    },
  };
}

/**
 * Validate a parsed OPENCODE_CONFIG_CONTENT payload that carries our agent
 * (P8-class guard: malformed config content yields healthy-but-degraded servers).
 * @param {object} content
 */
export function validateAgentConfigContent(content) {
  if (content == null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("agent config content must be an object");
  }
  const agent = content.agent?.[AGENT_NAME];
  if (!agent || typeof agent !== "object") {
    throw new Error(`agent config content missing "${AGENT_NAME}" entry`);
  }
  if (typeof agent.prompt !== "string" || agent.prompt.length === 0) {
    throw new Error(`agent "${AGENT_NAME}" prompt must be a non-empty string`);
  }
  if (!["subagent", "primary", "all"].includes(agent.mode)) {
    throw new Error(`agent "${AGENT_NAME}" mode must be subagent|primary|all`);
  }
}

export { AGENT_NAME };

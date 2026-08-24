// Autonomous delegation-routing classifier.
// Pure heuristics over a Claude Code Task-tool input; used by the PreToolUse
// delegation-router hook to decide whether a subagent request is a strong
// candidate for OpenCode delegation. Zero dependencies, fully deterministic.

const HEAVY = /\b(build|builds|test|tests|testing|lint|typecheck|tsc|compile|bundle|minify|refactor|migrate|migration|benchmark|regression)\b/i;
const REVIEW = /\b(review|audit|adversarial|verify|qa)\b/i;
const LIGHT = /\b(explore|find|locate|search|lookup|read|summar(y|ize)|quick|list files)\b/i;

/**
 * Decide whether a Task-tool invocation should be routed to OpenCode.
 * @param {{description?: string, prompt?: string, subagent_type?: string}} toolInput
 * @returns {{route: boolean, score: number, reason: string}}
 */
export function classifyDelegation(toolInput = {}) {
  const text = `${toolInput.description ?? ""} ${toolInput.prompt ?? ""}`;
  if (!text.trim()) {
    return { route: false, score: 0, reason: "empty task description" };
  }

  let score = 0;
  const signals = [];
  for (const match of text.matchAll(new RegExp(HEAVY.source, "gi"))) {
    score += 2;
    signals.push(match[0].toLowerCase());
  }
  for (const match of text.matchAll(new RegExp(REVIEW.source, "gi"))) {
    score += 2;
    signals.push(match[0].toLowerCase());
  }
  for (const match of text.matchAll(new RegExp(LIGHT.source, "gi"))) {
    score -= 1;
  }
  if (text.length > 1200) {
    score += 1;
    signals.push("long-prompt");
  }
  if (typeof toolInput.subagent_type === "string" && /implement|general|worker/i.test(toolInput.subagent_type)) {
    score += 1;
    signals.push("generalist-agent");
  }

  const route = score >= 3;
  return {
    route,
    score,
    reason: route
      ? `heavy-workload signals: ${[...new Set(signals)].join(", ") || "scope"} (score ${score})`
      : "not clearly delegation-worthy",
  };
}

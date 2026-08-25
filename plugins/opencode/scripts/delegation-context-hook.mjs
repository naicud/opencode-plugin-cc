// PostToolUse hook: after an opencode-delegation MCP tool call, surface the
// outcome as additionalContext so the main thread sees completion / permission
// requests without re-reading raw tool output.
//
// stdin: { tool_name, tool_response }
// stdout (only when relevant): { hookSpecificOutput: { hookEventName:
//   "PostToolUse", additionalContext } } — exit 0 always, silent otherwise.

import fs from "node:fs";

const RELEVANT = /^(mcp__plugin_opencode_oc__(wait|waitAll|status)|mcp__opencode_oc__(wait|waitAll|status))$/;

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function extractPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const response = parsed?.tool_response ?? {};
  // MCP result shape: { content: [{ type: "text", text }], isError? }
  const text = response?.result?.content?.[0]?.text ?? response?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function contextFor(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.status === "idle") {
    const esc = payload.escalation;
    if (payload.error && esc?.retryable) {
      return [
        "Delegated OpenCode session FAILED.",
        `Error: ${JSON.stringify(payload.error)}`,
        esc.suggestModel
          ? `Re-delegate with model "${esc.suggestModel}"${esc.suggestVariant ? ` and effort "${esc.suggestVariant}"` : ""} (reason: ${esc.reason}).`
          : "No higher tier is configured — fix the account/quota or pick another provider.",
      ].join(" ");
    }
    if (payload.error) {
      return [
        "Delegated OpenCode session finished with an error (not auto-retryable).",
        `Error: ${JSON.stringify(payload.error)}`,
        payload.response ? `Final message: ${String(payload.response).slice(0, 400)}` : null,
      ].filter(Boolean).join(" ");
    }
    const parts = [
      "Delegated OpenCode session finished (idle).",
      payload.response ? `Final message: ${String(payload.response).slice(0, 400)}` : null,
      "Before trusting success: read .oc-report.md in the workspace, check the files it lists exist, and re-run any read-only verification command yourself.",
    ].filter(Boolean);
    return parts.join(" ");
  }
  if (payload.status === "needsInput" && Array.isArray(payload.permissions)) {
    const list = payload.permissions
      .map((p) => `- ${p.permission}: ${p.command ?? p.patterns?.join(" ") ?? p.id} (id ${p.id})`)
      .join("\n");
    return [
      "Delegated OpenCode session is BLOCKED waiting on a permission decision.",
      list,
      'Decide each one with mcp__plugin_opencode_oc__respond: approve read-only/test commands with response:"once"; reject anything matching git push/commit, rm -rf, sudo, or curl piped to a shell.',
    ].join("\n");
  }
  if (payload.status === "timeout") {
    const parts = [
      "Delegated OpenCode session did not reach idle within the wait timeout. The session is STILL RUNNING server-side — nothing was lost. Call wait again and keep chaining until idle; abort ONLY if the user explicitly asks to kill it.",
    ];
    const progress = payload.progress;
    if (progress?.tail) {
      parts.push(`Latest assistant output tail:\n${progress.tail}`);
    }
    if (progress?.reasoningTail) {
      parts.push(`Reasoning tail:\n${progress.reasoningTail}`);
    }
    if (Array.isArray(progress?.tools) && progress.tools.length > 0) {
      parts.push(`Recent tool calls:\n${progress.tools.join("\n")}`);
    }
    if (progress?.todos) {
      parts.push(`Todo progress: ${JSON.stringify(progress.todos.counts)}${progress.todos.current ? ` — current: ${progress.todos.current}` : ""}.`);
    }
    return parts.join("\n\n");
  }
  return null;
}

const raw = readStdin();
let parsedInput = null;
try {
  parsedInput = JSON.parse(raw);
} catch {}

if (parsedInput && RELEVANT.test(parsedInput.tool_name ?? "")) {
  const payload = extractPayload(raw);
  const context = contextFor(payload);
  if (context) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
      })
    );
  }
}
process.exit(0);

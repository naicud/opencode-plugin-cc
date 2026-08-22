import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, "..", "plugins", "opencode", "scripts", "delegation-context-hook.mjs");

function runHook(stdinPayload) {
  const input = typeof stdinPayload === "string" ? stdinPayload : JSON.stringify(stdinPayload);
  return spawnSync("node", [HOOK], {
    input,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function mcpResult(obj) {
  return { tool_response: { result: { content: [{ type: "text", text: JSON.stringify(obj) }] } } };
}

describe("delegation-context-hook", () => {
  it("emits additionalContext on idle wait result", () => {
    const res = runHook({
      tool_name: "mcp__plugin_opencode_oc__wait",
      ...mcpResult({ status: "idle", response: "COMPLETED. Done work.", cost: 0 }),
    });
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /idle/);
    assert.match(out.hookSpecificOutput.additionalContext, /\.oc-report\.md/);
    assert.match(out.hookSpecificOutput.additionalContext, /COMPLETED\. Done work\./);
  });

  it("emits permission decision prompt on needsInput", () => {
    const res = runHook({
      tool_name: "mcp__plugin_opencode_oc__wait",
      ...mcpResult({
        status: "needsInput",
        permissions: [{ id: "per_1", permission: "bash", command: "./weird.sh" }],
      }),
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /BLOCKED/);
    assert.match(out.hookSpecificOutput.additionalContext, /per_1/);
    assert.match(out.hookSpecificOutput.additionalContext, /respond/);
  });

  it("warns on timeout status", () => {
    const res = runHook({
      tool_name: "mcp__plugin_opencode_oc__wait",
      ...mcpResult({ status: "timeout" }),
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /timeout/);
  });

  it("silent for unrelated tools", () => {
    const res = runHook({
      tool_name: "mcp__plugin_opencode_oc__models",
      ...mcpResult({ models: [] }),
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  });

  it("silent for garbage stdin and empty payloads without crashing", () => {
    for (const raw of ["not json", "", JSON.stringify({ tool_name: "x" }), "{}"]) {
      const res = runHook(raw);
      assert.equal(res.status, 0);
      assert.equal(res.stdout.trim(), "");
    }
  });

  it("silent when MCP result is isError or unparseable text", () => {
    const res = runHook({
      tool_name: "mcp__plugin_opencode_oc__wait",
      tool_response: { result: { content: [{ type: "text", text: "{{{bad json" }], isError: true } },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "");
  });

  it("handles direct content shape without result wrapper", () => {
    const res = runHook({
      tool_name: "mcp__plugin_opencode_oc__status",
      tool_response: { content: [{ type: "text", text: JSON.stringify({ status: "idle", response: "ok" }) }] },
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /idle/);
  });

  it("surfaces retryable failure with escalation suggestion", () => {
    const res = runHook({
      tool_name: "mcp__plugin_opencode_oc__wait",
      ...mcpResult({
        status: "idle",
        error: { name: "CreditsError", data: { message: "no balance", statusCode: 401 } },
        escalation: { kind: "auth", retryable: true, suggestModel: "deepseek-v4-flash", suggestVariant: "max", reason: "auth failure on x-preview-f-free" },
      }),
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /FAILED/);
    assert.match(out.hookSpecificOutput.additionalContext, /deepseek-v4-flash/);
    assert.match(out.hookSpecificOutput.additionalContext, /"max"/);
    assert.match(out.hookSpecificOutput.additionalContext, /auth failure/);
  });

  it("non-retryable error gets plain error context without suggestion", () => {
    const res = runHook({
      tool_name: "mcp__plugin_opencode_oc__wait",
      ...mcpResult({
        status: "idle",
        error: { name: "MessageAbortedError" },
        escalation: { kind: "abort", retryable: false },
        response: "partial text",
      }),
    });
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /not auto-retryable/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /Re-delegate/);
  });
});

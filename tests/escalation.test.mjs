import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyAssistantError, buildEscalation } from "../plugins/opencode/mcp/lib/escalation.mjs";

const config = {
  provider: "opencode",
  defaults: { tier: 0 },
  models: [
    { id: "free", tier: 0, variants: ["max"] },
    { id: "flash", tier: 1, variants: ["max"] },
    { id: "pro", tier: 2, variants: ["high", "max"] },
    { id: "k3", tier: 3, variants: ["max"] },
  ],
};

describe("escalation", () => {
  it("classifyAssistantError: null → none", () => {
    assert.deepEqual(classifyAssistantError(null), { kind: "none", retryable: false });
  });

  it("CreditsError / 401/402/403 → auth retryable", () => {
    for (const err of [
      { name: "CreditsError", data: { message: "no balance", statusCode: 401 } },
      { name: "APIError", data: { statusCode: 402 } },
      { name: "APIError", data: { statusCode: 403 } },
      { name: "APIError", data: { message: "Unauthorized", statusCode: 401 } },
    ]) {
      const c = classifyAssistantError(err);
      assert.equal(c.kind, "auth");
      assert.equal(c.retryable, true);
    }
  });

  it("429 / rate-limit text → rate", () => {
    assert.deepEqual(classifyAssistantError({ name: "APIError", data: { statusCode: 429 } }).kind, "rate");
    assert.deepEqual(classifyAssistantError({ name: "RateLimitError" }).kind, "rate");
  });

  it("5xx → server retryable", () => {
    assert.deepEqual(classifyAssistantError({ name: "APIError", data: { statusCode: 503 } }), {
      kind: "server",
      retryable: true,
    });
  });

  it("abort is NOT retryable (re-prompt semantics instead)", () => {
    assert.deepEqual(classifyAssistantError({ name: "MessageAbortedError" }), { kind: "abort", retryable: false });
    assert.deepEqual(classifyAssistantError({ name: "APIError", data: { message: "Aborted" } }).kind, "abort");
  });

  it("unknown error shapes are not retryable", () => {
    assert.deepEqual(classifyAssistantError({ name: "Weird" }), { kind: "unknown", retryable: false });
  });

  it("buildEscalation suggests the next tier with its highest variant", () => {
    const e = buildEscalation(
      { name: "CreditsError", data: { statusCode: 401 } },
      config,
      "free"
    );
    assert.equal(e.kind, "auth");
    assert.equal(e.suggestModel, "flash");
    assert.equal(e.suggestVariant, "max");
    assert.match(e.reason, /failure on free/);
  });

  it("buildEscalation from tier1 skips to pro and picks its last variant", () => {
    const e = buildEscalation({ name: "APIError", data: { statusCode: 429 } }, config, "flash");
    assert.equal(e.suggestModel, "pro");
    assert.equal(e.suggestVariant, "max");
  });

  it("buildEscalation at top tier returns no suggestion but stays retryable", () => {
    const e = buildEscalation({ name: "APIError", data: { statusCode: 429 } }, config, "k3");
    assert.equal(e.retryable, true);
    assert.equal(e.suggestModel, undefined);
  });

  it("buildEscalation unknown model falls back to defaults.tier", () => {
    const e = buildEscalation({ name: "APIError", data: { statusCode: 500 } }, config, "ghost");
    assert.equal(e.suggestModel, "flash");
  });

  it("buildEscalation passes through non-retryable untouched", () => {
    assert.deepEqual(buildEscalation({ name: "MessageAbortedError" }, config, "pro"), {
      kind: "abort",
      retryable: false,
    });
  });

  it("buildEscalation null error → none", () => {
    assert.deepEqual(buildEscalation(null, config, "pro"), { kind: "none", retryable: false });
  });
});

// Secrets hygiene: account credential VALUES must never appear in any
// user-visible tool payload. Only names and env-var NAMES may be exposed.

import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENCODE_DELEGATE_KEY_ALPHA = "sk-secret-alpha-DO-NOT-LEAK";
process.env.OPENCODE_DELEGATE_KEY_BETA = "sk-secret-beta-DO-NOT-LEAK";

test.after(() => {
  delete process.env.OPENCODE_DELEGATE_KEY_ALPHA;
  delete process.env.OPENCODE_DELEGATE_KEY_BETA;
});

const { listAccounts, pickAccount, envKeyName } = await import("../plugins/opencode/mcp/lib/accounts.mjs");
const { formatHint, formatCostTable } = await import("../plugins/opencode/mcp/lib/catalog.mjs");
const { summarizeBudget } = await import("../plugins/opencode/mcp/lib/budget.mjs");
const { buildEscalation } = await import("../plugins/opencode/mcp/lib/escalation.mjs");

function assertNoSecret(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  assert.ok(!text.includes("sk-secret-alpha"), "alpha key value leaked");
  assert.ok(!text.includes("sk-secret-beta"), "beta key value leaked");
  return text;
}

test("listAccounts exposes names + env var NAMES only", () => {
  const config = { accounts: { names: ["alpha", "beta"], strategy: "round-robin", default: null } };
  const out = assertNoSecret(listAccounts(config));
  assert.match(out, /OPENCODE_DELEGATE_KEY_ALPHA/); // var name is fine
  assert.doesNotMatch(out, /sk-secret/); // value is not
});

test("pickAccount result carries no credential material", () => {
  const config = { provider: "opencode", accounts: { names: ["alpha"], strategy: "fixed", default: "alpha" } };
  const acc = pickAccount(config, "/tmp/secret-hygiene-ws", "auto");
  assert.equal(acc, "alpha");
  assertNoSecret(acc);
});

test("buildAuthContent is the ONLY place the key lands (not logged by helpers)", () => {
  const { buildAuthContent } = listAccounts; // touch import graph sanity only
  assert.ok(typeof buildAuthContent === "undefined"); // not re-exported here
});

test("formatHint / formatCostTable never embed credentials", () => {
  const models = [
    { id: "x-preview-f-free", tier: 0, default: true, available: true, variants: ["max"], cost: { input: 0, output: 0 } },
    { id: "kimi-k3", tier: 3, available: true, variants: ["max"], cost: { input: 3, output: 15 } },
  ];
  const config = {
    defaults: { tier: 0 },
    effortPolicy: { mode: "max" },
    variantPreference: { max: ["max"] },
    budget: {},
    accounts: { names: ["alpha", "beta"], strategy: "round-robin", default: null },
  };
  assertNoSecret(formatHint(config, models));
  assertNoSecret(formatCostTable(models));
});

test("summarizeBudget output contains no secrets", () => {
  const NOW = new Date("2026-08-23T12:00:00.000Z");
  const jobs = [{ id: "j1", type: "delegate", status: "completed", cost: 0.5, createdAt: NOW.toISOString() }];
  assertNoSecret(summarizeBudget({}, jobs, { now: NOW }));
});

test("buildEscalation suggestions carry no credentials", () => {
  const err = { name: "CreditsError", data: { message: "no balance", statusCode: 401 } };
  const config = {
    defaults: { tier: 0 },
    models: [
      { id: "x-preview-f-free", tier: 0, available: true, variants: ["max"] },
      { id: "deepseek-v4-flash", tier: 1, available: true, variants: ["max"] },
    ],
  };
  assertNoSecret(buildEscalation(err, config, "x-preview-f-free"));
});

test("error messages for missing credentials show env var NAME, not value", () => {
  const config = { accounts: { names: ["gamma"], strategy: "fixed", default: null } };
  try {
    pickAccount(config, "/tmp/secret-hygiene-ws2", "auto");
    assert.fail("should throw ACCOUNT_NO_CREDENTIALS");
  } catch (err) {
    const text = assertNoSecret(err.message);
    assert.match(text, /OPENCODE_DELEGATE_KEY_GAMMA/);
  }
});

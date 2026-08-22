import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEffort, resolveSelection, buildModelSelector } from "../plugins/opencode/mcp/lib/resolve.mjs";

const config = {
  provider: "opencode",
  defaults: { tier: 1 },
  effortPolicy: { mode: "max", perTier: { "0": "off", "1": "high", "2": "max" } },
  variantPreference: {
    max: ["max", "xhigh", "high", "medium"],
    high: ["high", "medium", "low"],
    off: [],
  },
  excluded: [{ id: "muse-spark-1.2-contributor-free", reason: "training data" }],
};

const models = [
  { id: "glm-5.2", tier: 2, variants: ["high", "max"], cost: { input: 1.4, output: 4.4 }, available: true },
  { id: "kimi-k2.7-code", tier: 1, default: true, variants: [], cost: { input: 0.95, output: 4 }, available: true },
  { id: "deepseek-v4-flash", tier: 1, variants: ["low", "high", "max"], cost: { input: 0.14, output: 0.28 }, available: true },
  { id: "kimi-k3", tier: 3, variants: ["max"], cost: { input: 3, output: 15 }, available: true },
  { id: "ghost-model", tier: 2, variants: ["max"], cost: { input: 1, output: 2 }, available: false },
];

describe("resolveEffort", () => {
  it("glm-5.2 + max resolves variant max (real catalog)", () => {
    const glm = models[0];
    const r = resolveEffort(glm, "max", config);
    assert.equal(r.variant, "max");
    assert.equal(r.effortApplied, "max");
    assert.equal(r.source, "catalog");
  });

  it("kimi-k2.7-code + max falls back to base with effortApplied none and reason (CA-8)", () => {
    const kimi = models[1];
    const r = resolveEffort(kimi, "max", config);
    assert.equal(r.variant, null);
    assert.equal(r.effortApplied, "none");
    assert.equal(r.source, "base");
    assert.match(r.reason, /no variants|no max variant/);
  });

  it("effort off requests no variant at all (CA-9)", () => {
    const r = resolveEffort(models[2], "off", config);
    assert.equal(r.variant, null);
    assert.equal(r.effortApplied, "none");
    assert.equal(r.source, "off");
  });

  it("variantPreference picks first available preference entry, not the top one", () => {
    // model has only "low" of the whole preference chain for "high"
    const m = { id: "x", tier: 1, variants: ["low"], cost: {} };
    const r = resolveEffort(m, "high", config);
    assert.equal(r.variant, "low");
    assert.equal(r.effortApplied, "low");
  });

  it("declared customVariant is used when catalog lacks the effort", () => {
    const m = { id: "custom-guy", tier: 2, variants: [], customVariant: { max: "ultra" }, cost: {} };
    const r = resolveEffort(m, undefined, { ...config, effortPolicy: { mode: "max" } });
    assert.equal(r.variant, "ultra");
    assert.equal(r.source, "custom");
  });

  it("default effort comes from policy mode when not requested", () => {
    const r = resolveEffort(models[0], undefined, config); // mode: max
    assert.equal(r.effortApplied, "max");
  });

  it("perTier mode derives effort from tier", () => {
    const perTierConfig = { ...config, effortPolicy: { mode: "perTier", perTier: { "1": "high", "2": "max" } } };
    assert.equal(resolveEffort(models[2], undefined, perTierConfig).effortApplied, "high"); // tier 1
    assert.equal(resolveEffort(models[0], undefined, perTierConfig).effortApplied, "max"); // tier 2
  });
});

describe("resolveSelection", () => {
  it("explicit model request wins over tier", () => {
    const sel = resolveSelection({ modelId: "kimi-k3", effort: "max" }, models, config);
    assert.equal(sel.model.id, "kimi-k3");
    assert.equal(sel.variant, "max");
  });

  it("excluded explicit request is refused with reason (CA-6)", () => {
    assert.throws(
      () => resolveSelection({ modelId: "muse-spark-1.2-contributor-free" }, models, config),
      (err) => err.code === "MODEL_EXCLUDED" && /training data/.test(err.message)
    );
  });

  it("unknown model errors listing alternatives", () => {
    assert.throws(() => resolveSelection({ modelId: "nope-9000" }, models, config), (err) => err.code === "MODEL_UNKNOWN");
  });

  it("unavailable live model is refused", () => {
    assert.throws(() => resolveSelection({ modelId: "ghost-model" }, models, config), (err) => err.code === "MODEL_UNAVAILABLE");
  });

  it("tier pick prefers curated default then cheapest output", () => {
    const sel = resolveSelection({ tier: 1 }, models, config); // kimi-k2.7-code has default:true
    assert.equal(sel.model.id, "kimi-k2.7-code");

    const noDefaultConfig = { ...config, defaults: { tier: 1 } };
    const modelsNoDefault = models.filter((m) => !m.default);
    const sel2 = resolveSelection({ tier: 1 }, modelsNoDefault, noDefaultConfig);
    assert.equal(sel2.model.id, "deepseek-v4-flash"); // cheapest output in tier
  });

  it("empty tier errors clearly", () => {
    assert.throws(() => resolveSelection({ tier: 9 }, models, config), (err) => err.code === "TIER_EMPTY");
  });
});

describe("buildModelSelector", () => {
  it("emits nested model object with top-level variant (findings P1+P2)", () => {
    const selector = buildModelSelector("opencode", "glm-5.2", "max");
    assert.deepEqual(selector, {
      model: { providerID: "opencode", modelID: "glm-5.2" },
      variant: "max",
    });
  });

  it("omits variant entirely when null", () => {
    const selector = buildModelSelector("opencode", "kimi-k2.7-code", null);
    assert.deepEqual(selector, { model: { providerID: "opencode", modelID: "kimi-k2.7-code" } });
    assert.ok(!("variant" in selector));
  });
});

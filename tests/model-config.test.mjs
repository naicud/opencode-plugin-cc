// Tests for mcp/lib/model-config.mjs against the REAL config/models.json v2
// schema: models = ARRAY of {id, tier, variants, cost?, default?}, default
// flag on the entry, defaults.tier must match, excluded = [{id, reason}].

import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  validateModelConfig,
  listSelectableModels,
  addModel,
  setModel,
  setEffort,
  describeChanges,
} = await import("../plugins/opencode/mcp/lib/model-config.mjs");

/** Real-schema fixture factory (fresh object per test — no cross-test bleed). */
function makeConfig(overrides = {}) {
  return {
    version: 2,
    provider: "opencode",
    defaults: { tier: 0 },
    effortPolicy: { mode: "max", perTier: {} },
    variantPreference: { max: ["max"], high: ["high"], off: [] },
    excluded: [{ id: "muse-spark-1.2-contributor-free", reason: "training data" }],
    models: [
      {
        id: "x-preview-f-free",
        tier: 0,
        variants: ["high", "low", "max"],
        cost: { input: 0, output: 0 },
        default: true,
        use: "everyday",
      },
      {
        id: "deepseek-v4-flash",
        tier: 1,
        variants: ["high", "low", "max"],
        cost: { input: 0.14, output: 0.28 },
      },
      { id: "kimi-k3", tier: 3, variants: ["max"], cost: { input: 3, output: 15 } },
    ],
    ...overrides,
  };
}

function deepFreeze(o) {
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") deepFreeze(o[k]);
  return Object.freeze(o);
}

/* ------------------------------ validateModelConfig ----------------------------- */

test("valid real-shape config produces no problems", () => {
  assert.deepEqual(validateModelConfig(makeConfig()), []);
});

test("models must be an array of entries with sane ids/tiers/variants/costs", () => {
  const problems = validateModelConfig(
    makeConfig({
      models: [
        { id: "bad id!", tier: -1, variants: "max" },
        { id: "", tier: null, variants: [42], cost: { input: "x" } },
        "not-an-object",
      ],
    })
  );
  const joined = problems.join("\n");
  assert.match(joined, /id/);
  assert.match(joined, /tier/);
  assert.match(joined, /variants/);
  assert.match(joined, /cost/);
});

test("more than one default entry is rejected", () => {
  const cfg = makeConfig();
  cfg.models[1].default = true;
  assert.ok(validateModelConfig(cfg).some((p) => /default/i.test(p)));
});

test("defaults.tier mismatching the default entry's tier is rejected", () => {
  const cfg = makeConfig({ defaults: { tier: 2 } });
  assert.ok(validateModelConfig(cfg).some((p) => /defaults\.tier/i.test(p)));
});

test("effortPolicy and variantPreference shapes are validated", () => {
  const bad = makeConfig({
    effortPolicy: { mode: "turbo", perTier: { x: "max" } },
    variantPreference: { turbo: ["t"] },
  });
  const joined = validateModelConfig(bad).join("\n");
  assert.match(joined, /effortPolicy\.mode/i);
  assert.match(joined, /perTier/i);
  assert.match(joined, /variantPreference/i);
});

/* ----------------------------- listSelectableModels ---------------------------- */

test("rows merge curated entries with live catalog (curated wins)", () => {
  const rows = listSelectableModels(makeConfig(), {
    "x-preview-f-free": { variants: ["low", "max"], cost: { input: 0.01, output: 0.02 } },
    "live-only-model": { variants: [], cost: { input: 0, output: 0 } },
  });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  // curated wins: file variants + costs kept
  assert.deepEqual(byId["x-preview-f-free"].variants, ["high", "low", "max"]);
  assert.equal(byId["x-preview-f-free"].costIn, 0);
  assert.equal(byId["x-preview-f-free"].isDefault, true);
  assert.equal(byId["deepseek-v4-flash"].tier, 1);
  // live fills gaps
  assert.equal(byId["live-only-model"].inCatalog, true);
  assert.equal(byId["live-only-model"].tier, null);
  // excluded flagged
  assert.equal(byId["kimi-k3"].isExcluded, false);
});

test("ordering: tier ascending, null-tier last, ids alphabetical within group", () => {
  const cfg = makeConfig();
  cfg.models.push({ id: "aaa-null", tier: null, variants: [] });
  cfg.models.push({ id: "zzz-t0", tier: 0, variants: [] });
  const rows = listSelectableModels(cfg, {});
  const tiers = rows.map((r) => (r.tier === null ? Infinity : r.tier));
  assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
  const t0 = rows.filter((r) => r.tier === 0).map((r) => r.id);
  assert.deepEqual(t0, [...t0].sort());
});

/* ---------------------------------- addModel ----------------------------------- */

test("addModel appends a curated entry; makeDefault flips flags + defaults.tier", () => {
  const before = makeConfig();
  const frozen = JSON.parse(JSON.stringify(before));
  const res = addModel(before, {
    id: "glm-5",
    tier: 2,
    variants: ["high", "max"],
    cost: { input: 1.4, output: 4.4 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.config.models.length, before.models.length + 1);
  const added = res.config.models.find((m) => m.id === "glm-5");
  assert.equal(added.tier, 2);
  assert.equal(res.config.models.find((m) => m.default)?.id, "x-preview-f-free");
  // input untouched
  assert.deepEqual(before, frozen);

  const res2 = addModel(res.config, { id: "gpt-x", tier: 0, makeDefault: true });
  assert.equal(res2.ok, true);
  assert.equal(res2.config.models.find((m) => m.id === "gpt-x").default, true);
  assert.equal(res2.config.models.find((m) => m.id === "x-preview-f-free").default, undefined);
  assert.equal(res2.config.defaults.tier, 0);
});

test("addModel structured error codes", () => {
  const base = makeConfig();
  assert.equal(addModel(base, { id: "bad id", tier: 1 }).code, "MODEL_ID_INVALID");
  assert.equal(addModel(base, { id: "new-one", tier: "free" }).code, "TIER_INVALID");
  assert.equal(addModel(base, { id: "kimi-k3", tier: 3 }).code, "DUPLICATE_MODEL");
  assert.equal(addModel(base, { id: "new-one", tier: 1, variants: "max" }).code, "VARIANTS_INVALID");
  assert.equal(
    addModel(base, { id: "new-one", tier: 1, cost: { input: -1, output: 0 } }).code,
    "COST_INVALID"
  );
  assert.equal(addModel(base, {}).code, "MODEL_ID_INVALID");
});

/* ---------------------------------- setModel ----------------------------------- */

test("setModel mutates tier/variants/default; remove deletes entry", () => {
  const base = makeConfig();
  let res = setModel(base, { id: "deepseek-v4-flash", tier: 2, variants: ["high", "max"] });
  assert.equal(res.ok, true);
  let m = res.config.models.find((x) => x.id === "deepseek-v4-flash");
  assert.equal(m.tier, 2);
  assert.deepEqual(m.variants, ["high", "max"]);

  res = setModel(res.config, { id: "deepseek-v4-flash", makeDefault: true });
  assert.equal(res.config.defaults.tier, 2);
  assert.equal(res.config.models.find((x) => x.id === "x-preview-f-free").default, undefined);

  res = setModel(res.config, { id: "deepseek-v4-flash", remove: true });
  assert.equal(res.code, "DEFAULT_TIER_EMPTY");
});

test("setModel errors: not found, bad tier, cannot remove sole default", () => {
  const base = makeConfig();
  assert.equal(setModel(base, { id: "ghost" }).code, "MODEL_NOT_FOUND");
  assert.equal(setModel(base, { id: "kimi-k3", tier: -5 }).code, "TIER_INVALID");
  assert.equal(setModel(base, { id: "x-preview-f-free", remove: true }).code, "DEFAULT_TIER_EMPTY");
});

/* ---------------------------------- setEffort ---------------------------------- */

test("global effort high rewrites the max chain without lying about policy mode", () => {
  const res = setEffort(makeConfig(), { scope: { kind: "global" }, mode: "high" });
  assert.equal(res.ok, true);
  assert.equal(res.config.effortPolicy.mode, "max"); // chain stays strict-max shaped
  assert.deepEqual(res.config.variantPreference.max, ["high"]);
  // no stale preferredVariant stamps on entries from a global change
  assert.ok(res.config.models.every((m) => !m.preferredVariant));
});

test("global effort off switches policy mode to off", () => {
  const res = setEffort(makeConfig(), { scope: { kind: "global" }, mode: "off" });
  assert.equal(res.config.effortPolicy.mode, "off");
});

test("tier effort stamps perTier + preferredVariant on that tier only; max clears", () => {
  let res = setEffort(makeConfig(), { scope: { kind: "tier", tier: 1 }, mode: "high" });
  assert.equal(res.config.effortPolicy.perTier["1"], "high");
  assert.equal(res.config.models.find((m) => m.id === "deepseek-v4-flash").preferredVariant, "high");
  assert.ok(!res.config.models.find((m) => m.id === "kimi-k3").preferredVariant);

  res = setEffort(res.config, { scope: { kind: "tier", tier: 1 }, mode: "max" });
  assert.equal(res.config.effortPolicy.perTier["1"], undefined);
  assert.ok(!res.config.models.find((m) => m.id === "deepseek-v4-flash").preferredVariant);
});

test("model effort stamps one entry; invalid scopes/modes rejected", () => {
  let res = setEffort(makeConfig(), { scope: { kind: "model", id: "kimi-k3" }, mode: "low" });
  assert.equal(res.config.models.find((m) => m.id === "kimi-k3").preferredVariant, "low");

  assert.equal(
    setEffort(makeConfig(), { scope: { kind: "model", id: "ghost" }, mode: "low" }).code,
    "MODEL_NOT_FOUND"
  );
  assert.equal(
    setEffort(makeConfig(), { scope: { kind: "tier", tier: 9 }, mode: "low" }).code,
    "TIER_NOT_FOUND"
  );
  assert.equal(setEffort(makeConfig(), { scope: { kind: "weird" }, mode: "low" }).code, "EFFORT_SCOPE_INVALID");
  assert.equal(
    setEffort(makeConfig(), { scope: { kind: "global" }, mode: "ultra" }).code,
    "EFFORT_MODE_INVALID"
  );
});

/* ------------------------------- describeChanges ------------------------------- */

test("describeChanges emits deterministic human lines", () => {
  const before = makeConfig();
  let after = addModel(before, { id: "glm-5", tier: 2 }).config;
  after = setEffort(after, { scope: { kind: "tier", tier: 2 }, mode: "high" }).config;
  const lines = describeChanges(before, after);
  const joined = lines.join("\n");
  assert.match(joined, /glm-5 \(tier 2\)/);
  assert.match(joined, /perTier\["2"\]/);
  // the stamp itself lives on the entry
  assert.equal(after.models.find((m) => m.id === "glm-5").preferredVariant, "high");
});

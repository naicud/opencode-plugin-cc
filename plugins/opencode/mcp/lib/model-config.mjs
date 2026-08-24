// Pure editing operations over the curated model configuration (models.json).
// REAL v2 shape (see config/models.json):
//   version: 2, provider: string,
//   defaults: { tier: number, ... },
//   effortPolicy: { mode: "max"|"perTier"|"off", perTier?: {<tier>: mode} },
//   variantPreference: { max: [...], high: [...], off: [] },
//   models: ARRAY of { id, tier: number|null, variants: string[], cost?, use?,
//                      default?: boolean, provider?, preferredVariant? },
//   excluded: [{ id, reason }]
// Zero runtime deps. Every mutator deep-clones via structuredClone and returns
// the edited clone; failures never touch the input. Built for the guided
// model wizard (/opencode:model) with validation-first error codes.

const MODEL_ID_PATTERN = /^[\w.-]+$/;
const VALID_EFFORT_MODES = ["max", "high", "low", "off"];
const VALID_POLICY_MODES = ["max", "perTier", "off"];
const VALID_VARIANT_PREFERENCE_KEYS = ["max", "high", "off"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validCost(cost) {
  const finiteNonNegative = (v) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
  return (
    cost === undefined ||
    cost === null ||
    (isPlainObject(cost) && finiteNonNegative(cost.input) && finiteNonNegative(cost.output))
  );
}

function modelList(config) {
  return Array.isArray(config.models) ? config.models : [];
}

function findModelIndex(config, id) {
  return modelList(config).findIndex((m) => m && m.id === id);
}

/* ------------------------------ validation -------------------------------- */

/**
 * Validate a full config object.
 * @param {object} config
 * @returns {string[]} human-readable problems; empty array = valid
 */
export function validateModelConfig(config) {
  const problems = [];
  if (!isPlainObject(config)) {
    problems.push("config must be an object");
    return problems;
  }
  if (config.version !== 2) problems.push("version must be 2");
  if (typeof config.provider !== "string" || !config.provider) {
    problems.push("provider must be a non-empty string");
  }

  let models;
  if (Array.isArray(config.models)) {
    models = config.models;
  } else {
    problems.push("models must be an array of model entries");
    models = [];
  }
  let defaultCount = 0;
  models.forEach((m, i) => {
    const label = `models[${i}]`;
    if (!isPlainObject(m)) {
      problems.push(`${label} must be an object`);
      return;
    }
    if (typeof m.id !== "string" || !MODEL_ID_PATTERN.test(m.id)) {
      problems.push(`${label}.id must match ${MODEL_ID_PATTERN}`);
    }
    if (!(m.tier === null || (Number.isInteger(m.tier) && m.tier >= 0))) {
      problems.push(`${label}.tier must be null or an integer >= 0`);
    }
    if (!Array.isArray(m.variants) || m.variants.some((v) => typeof v !== "string")) {
      problems.push(`${label}.variants must be an array of strings`);
    }
    if (!validCost(m.cost)) {
      problems.push(`${label}.cost must be {input:number,output:number}`);
    }
    if (m.default === true) defaultCount += 1;
  });
  if (defaultCount > 1) {
    problems.push("at most one model entry may carry default:true");
  }

  const defaults = config.defaults ?? {};
  if (!Number.isInteger(defaults.tier) || defaults.tier < 0) {
    problems.push("defaults.tier must be an integer >= 0");
  } else if (defaultCount === 1) {
    const def = models.find((m) => isPlainObject(m) && m.default === true);
    if (def && def.tier !== defaults.tier) {
      problems.push(
        `defaults.tier (${defaults.tier}) does not match the default model's tier (${def.tier})`
      );
    }
  }

  const policy = config.effortPolicy ?? {};
  if (!VALID_POLICY_MODES.includes(policy.mode)) {
    problems.push(`effortPolicy.mode must be one of ${VALID_POLICY_MODES.join("|")}`);
  }
  if (policy.perTier !== undefined) {
    if (!isPlainObject(policy.perTier)) {
      problems.push("effortPolicy.perTier must be an object keyed by tier");
    } else {
      for (const [k, v] of Object.entries(policy.perTier)) {
        if (!/^\d+$/.test(k) || !VALID_EFFORT_MODES.includes(v)) {
          problems.push(`effortPolicy.perTier["${k}"] must be one of ${VALID_EFFORT_MODES.join("|")}`);
        }
      }
    }
  }

  if (config.variantPreference !== undefined) {
    if (!isPlainObject(config.variantPreference)) {
      problems.push("variantPreference must be an object");
    } else {
      for (const [k, arr] of Object.entries(config.variantPreference)) {
        if (!VALID_VARIANT_PREFERENCE_KEYS.includes(k) || !Array.isArray(arr)) {
          problems.push(
            `variantPreference.${k} must be a string array under {${VALID_VARIANT_PREFERENCE_KEYS.join(",")}}`
          );
        }
      }
    }
  }

  if (config.excluded !== undefined) {
    if (!Array.isArray(config.excluded)) {
      problems.push("excluded must be an array");
    } else {
      config.excluded.forEach((e, i) => {
        const id = typeof e === "string" ? e : e?.id;
        if (typeof id !== "string" || !id) {
          problems.push(`excluded[${i}] must have a string id`);
        }
        if (e && typeof e === "object" && e !== null && typeof e.reason !== "string") {
          problems.push(`excluded[${i}].reason must be a string when present`);
        }
      });
    }
  }

  return problems;
}

/* ------------------------------- listing ---------------------------------- */

/**
 * Merge curated entries with the live provider catalog for display.
 * Curated fields win; live fills gaps (variants/cost) and appends ids that are
 * not curated yet — those are the wizard's candidates.
 */
export function listSelectableModels(config, liveModels = {}) {
  const live = isPlainObject(liveModels) ? liveModels : {};
  const excludedIds = new Set(
    (Array.isArray(config.excluded) ? config.excluded : [])
      .map((e) => (typeof e === "string" ? e : e?.id))
      .filter(Boolean)
  );
  const rows = [];
  const seen = new Set();
  for (const m of modelList(config)) {
    if (!isPlainObject(m) || typeof m.id !== "string") continue;
    seen.add(m.id);
    const lv = live[m.id] ?? {};
    rows.push({
      id: m.id,
      tier: m.tier ?? null,
      variants: Array.isArray(m.variants) ? m.variants : (lv.variants ?? []),
      costIn: m.cost?.input ?? lv.cost?.input ?? null,
      costOut: m.cost?.output ?? lv.cost?.output ?? null,
      isDefault: m.default === true,
      isExcluded: excludedIds.has(m.id),
      inCatalog: Boolean(live[m.id]),
    });
  }
  for (const [id, lv] of Object.entries(live)) {
    if (seen.has(id)) continue;
    rows.push({
      id,
      tier: null,
      variants: lv.variants ?? [],
      costIn: lv.cost?.input ?? null,
      costOut: lv.cost?.output ?? null,
      isDefault: false,
      isExcluded: excludedIds.has(id),
      inCatalog: true,
    });
  }
  rows.sort((a, b) => {
    if (a.tier !== b.tier) {
      if (a.tier === null) return 1;
      if (b.tier === null) return -1;
      return a.tier - b.tier;
    }
    return String(a.id).localeCompare(String(b.id));
  });
  return rows;
}

/* -------------------------------- add ------------------------------------- */

/**
 * Add a model entry.
 * @returns {ConfigResult|ConfigError}
 */
export function addModel(config, op = {}) {
  if (typeof op.id !== "string" || !MODEL_ID_PATTERN.test(op.id)) {
    return { ok: false, code: "MODEL_ID_INVALID", reason: `id must match ${MODEL_ID_PATTERN}` };
  }
  if (!Number.isInteger(op.tier) || op.tier < 0) {
    return { ok: false, code: "TIER_INVALID", reason: "--tier N (integer >= 0) is required to add a model" };
  }
  if (findModelIndex(config, op.id) !== -1) {
    return { ok: false, code: "DUPLICATE_MODEL", reason: `${op.id} already exists in config` };
  }
  if (
    op.variants !== undefined &&
    (!Array.isArray(op.variants) || op.variants.length === 0 || op.variants.some((v) => typeof v !== "string"))
  ) {
    return { ok: false, code: "VARIANTS_INVALID", reason: "variants must be a non-empty string array" };
  }
  if (op.cost !== undefined && !validCost(op.cost)) {
    return { ok: false, code: "COST_INVALID", reason: "cost must be {input?: number, output?: number}" };
  }

  const next = structuredClone(config);
  next.models = Array.isArray(next.models) ? next.models : [];
  const entry = {
    id: op.id,
    tier: op.tier,
    variants: op.variants ?? [],
    ...(op.cost !== undefined ? { cost: op.cost } : {}),
  };
  if (op.makeDefault === true) {
    for (const m of next.models) delete m.default;
    entry.default = true;
    next.defaults = { ...(next.defaults ?? {}), tier: op.tier };
  }
  next.models.push(entry);
  return { ok: true, config: next };
}

/* -------------------------------- set ------------------------------------- */

/**
 * Edit or remove a model entry.
 * @returns {ConfigResult|ConfigError}
 */
export function setModel(config, op = {}) {
  if (typeof op.id !== "string") {
    return { ok: false, code: "MODEL_ID_INVALID", reason: "id must be a string" };
  }
  const idx = findModelIndex(config, op.id);
  if (idx === -1) {
    return { ok: false, code: "MODEL_NOT_FOUND", reason: `${op.id} not found in config` };
  }
  if (op.tier !== undefined && !(Number.isInteger(op.tier) && op.tier >= 0)) {
    return { ok: false, code: "TIER_INVALID", reason: "tier must be an integer >= 0" };
  }
  if (
    op.variants !== undefined &&
    (!Array.isArray(op.variants) || op.variants.length === 0 || op.variants.some((v) => typeof v !== "string"))
  ) {
    return { ok: false, code: "VARIANTS_INVALID", reason: "variants must be a non-empty string array" };
  }

  const next = structuredClone(config);

  if (op.remove === true) {
    if (next.models[idx].default === true && !next.models.some((m, i) => i !== idx && m.default === true)) {
      return {
        ok: false,
        code: "DEFAULT_TIER_EMPTY",
        reason: `${op.id} is the default model; promote another with --default first`,
      };
    }
    next.models.splice(idx, 1);
    return { ok: true, config: next };
  }

  const entry = next.models[idx];
  if (op.tier !== undefined) entry.tier = op.tier;
  if (op.variants !== undefined) {
    entry.variants = op.variants;
    if (!op.variants.includes(entry.preferredVariant)) delete entry.preferredVariant;
  }
  if (op.makeDefault === true) {
    for (const m of next.models) delete m.default;
    entry.default = true;
    next.defaults = { ...(next.defaults ?? {}), tier: entry.tier };
  }
  return { ok: true, config: next };
}

/* ------------------------------- effort ----------------------------------- */

/**
 * Configure reasoning effort.
 * scope: {kind:"global"} | {kind:"tier", tier:N} | {kind:"model", id}
 * mode:  "max" | "high" | "low" | "off"
 *
 * Global: "max"/"perTier"-style intent stays mode:"max" (strict max chains);
 * only "off" changes the policy mode. Tier/model scopes stamp
 * models[id].preferredVariant for non-max modes (the resolve chain honors it);
 * "max" clears stale preferredVariant entries.
 * @returns {ConfigResult|ConfigError}
 */
export function setEffort(config, op = {}) {
  const { scope, mode } = op;
  if (!VALID_EFFORT_MODES.includes(mode)) {
    return { ok: false, code: "EFFORT_MODE_INVALID", reason: `mode must be one of ${VALID_EFFORT_MODES.join("|")}` };
  }
  if (!isPlainObject(scope)) {
    return { ok: false, code: "EFFORT_SCOPE_INVALID", reason: "scope must be {kind} object" };
  }

  const next = structuredClone(config);

  if (scope.kind === "global") {
    next.effortPolicy = { ...(next.effortPolicy ?? {}), mode: mode === "off" ? "off" : "max" };
    if (mode !== "max" && mode !== "off") {
      // carry global intent through the strict chains
      next.variantPreference = {
        max: [mode],
        high: ["high"],
        off: [],
      };
    }
    return { ok: true, config: next };
  }

  if (scope.kind === "tier") {
    if (!Number.isInteger(scope.tier) || scope.tier < 0) {
      return { ok: false, code: "EFFORT_SCOPE_INVALID", reason: "tier scope needs integer tier" };
    }
    const targets = modelList(next).filter((m) => m && m.tier === scope.tier);
    if (targets.length === 0) {
      return { ok: false, code: "TIER_NOT_FOUND", reason: `no models in tier ${scope.tier}` };
    }
    next.effortPolicy = { ...(next.effortPolicy ?? {}) };
    next.effortPolicy.perTier = { ...(next.effortPolicy.perTier ?? {}) };
    if (mode === "max") delete next.effortPolicy.perTier[String(scope.tier)];
    else next.effortPolicy.perTier[String(scope.tier)] = mode;
    for (const m of targets) {
      if (mode === "max") delete m.preferredVariant;
      else m.preferredVariant = mode;
    }
    return { ok: true, config: next };
  }

  if (scope.kind === "model") {
    if (typeof scope.id !== "string") {
      return { ok: false, code: "EFFORT_SCOPE_INVALID", reason: "model scope needs id string" };
    }
    const idx = findModelIndex(next, scope.id);
    if (idx === -1) {
      return { ok: false, code: "MODEL_NOT_FOUND", reason: `${scope.id} not found in config` };
    }
    const entry = next.models[idx];
    if (mode === "max") delete entry.preferredVariant;
    else entry.preferredVariant = mode;
    return { ok: true, config: next };
  }

  return { ok: false, code: "EFFORT_SCOPE_INVALID", reason: `unknown scope kind: ${scope?.kind}` };
}

/* ------------------------------- diff ------------------------------------- */

/**
 * Deterministic human-readable change list between two configs.
 * @param {object} before
 * @param {object} after
 * @returns {string[]}
 */
export function describeChanges(before, after) {
  const lines = [];
  const bMap = new Map(modelList(before).map((m) => [m.id, m]));
  const aList = modelList(after);

  for (const m of aList) {
    const b = bMap.get(m.id);
    if (!b) lines.push(`models += ${m.id} (tier ${m.tier})`);
    else {
      if (b.tier !== m.tier) lines.push(`${m.id}: tier ${b.tier} -> ${m.tier}`);
      if (JSON.stringify(b.variants) !== JSON.stringify(m.variants)) {
        lines.push(`${m.id}: variants [${(b.variants ?? []).join(",")}] -> [${(m.variants ?? []).join(",")}]`);
      }
      if (!!b.default !== !!m.default && m.default === true) lines.push(`default model -> ${m.id}`);
      if (b.cost?.input !== m.cost?.input || b.cost?.output !== m.cost?.output) {
        lines.push(
          `${m.id}: cost $${b.cost?.input ?? "?"}/$${b.cost?.output ?? "?"} -> $${m.cost?.input ?? "?"}/$${m.cost?.output ?? "?"}`
        );
      }
      if (b.preferredVariant !== m.preferredVariant) {
        lines.push(`${m.id}: preferredVariant ${b.preferredVariant ?? "(none)"} -> ${m.preferredVariant ?? "(none)"}`);
      }
    }
  }
  for (const m of modelList(before)) {
    if (!aList.some((x) => x.id === m.id)) lines.push(`models -= ${m.id}`);
  }

  const bp = before.effortPolicy ?? {};
  const ap = after.effortPolicy ?? {};
  if (bp.mode !== ap.mode) lines.push(`effortPolicy.mode ${bp.mode} -> ${ap.mode}`);
  const bt = bp.perTier ?? {};
  const at = ap.perTier ?? {};
  for (const k of Object.keys(at)) {
    if (bt[k] !== at[k]) lines.push(`effortPolicy.perTier["${k}"] ${bt[k] ?? "(unset)"} -> ${at[k]}`);
  }
  for (const k of Object.keys(bt)) {
    if (!(k in at)) lines.push(`effortPolicy.perTier["${k}"] removed`);
  }
  if ((before.defaults?.tier) !== (after.defaults?.tier)) {
    lines.push(`defaults.tier ${before.defaults?.tier} -> ${after.defaults?.tier}`);
  }

  return lines;
}

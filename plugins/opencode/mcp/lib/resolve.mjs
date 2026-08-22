// Effort/variant resolution (plan §5.3).
// The server accepts ANY variant string without validation (findings P2:
// bogus variant → 204 + silent fallback), so validation against the live
// catalog MUST happen here.

/**
 * Resolve the requested effort to a concrete variant for a model.
 * @param {object} model - merged catalog entry (needs id, variants, customVariant?)
 * @param {string|undefined} effortRequest - explicit effort from the caller
 * @param {object} config - models.json content (effortPolicy, variantPreference)
 * @returns {{ variant: string|null, effortApplied: string, source: string, reason?: string }}
 *   source: "catalog" | "custom" | "off" | "base"
 */
export function resolveEffort(model, effortRequest, config) {
  const policy = config.effortPolicy ?? {};
  const preference = config.variantPreference ?? {};

  // Effective requested effort: explicit > perTier (when mode=perTier) > mode default
  let effort = effortRequest;
  if (effort == null && policy.mode === "perTier") {
    effort = policy.perTier?.[String(model.tier ?? "")];
  }
  if (effort == null) effort = policy.mode === "off" ? "off" : "max";

  if (effort === "off") {
    return { variant: null, effortApplied: "none", source: "off" }; // CA-9
  }

  const available = model.variants ?? [];
  const wanted = preference[effort] ?? [effort];

  // 3. first preference entry present in the live catalog wins
  for (const candidate of wanted) {
    if (available.includes(candidate)) {
      return { variant: candidate, effortApplied: candidate, source: "catalog" };
    }
  }

  // 4. declared customVariant (runtime-injected; server does not validate, P2)
  const custom = model.customVariant;
  if (custom) {
    const name = typeof custom === "string" ? custom : custom[effort];
    if (name) {
      return { variant: name, effortApplied: effort, source: "custom" };
    }
  }

  // 5. base model with a reason (RF-6, RF-7, CA-8)
  return {
    variant: null,
    effortApplied: "none",
    source: "base",
    reason: available.length
      ? `model "${model.id}" has no ${effort} variant (available: ${available.join(", ")})`
      : `model "${model.id}" exposes no variants; running base`,
  };
}

/**
 * Single point where the prompt body's model selector is shaped.
 * Findings P1+P2: nested model object, variant as top-level sibling.
 * @param {string} providerId
 * @param {string} modelId
 * @param {string|null} variant - omitted from the payload when null
 * @returns {{ model: { providerID: string, modelID: string }, variant?: string }}
 */
export function buildModelSelector(providerId, modelId, variant) {
  const selector = { model: { providerID: providerId, modelID: modelId } };
  if (variant) selector.variant = variant;
  return selector;
}

/**
 * Pick and resolve a model for delegation.
 * @param {object} opts
 * @param {string} [opts.modelId]
 * @param {number} [opts.tier]
 * @param {string} [opts.effort]
 * @param {object[]} opts.models - merged catalog entries
 * @param {object} opts.config - models.json content
 * @returns {{ model: object, variant: string|null, effortApplied: string, source: string, reason?: string }}
 */
export function resolveSelection({ modelId, tier, effort }, models, config) {
  let model;

  if (modelId != null) {
    const excluded = (config.excluded ?? []).find((e) => e.id === modelId);
    if (excluded) {
      throw Object.assign(
        new Error(`Model "${modelId}" is excluded from delegation: ${excluded.reason}`),
        { code: "MODEL_EXCLUDED" }
      );
    }
    model = models.find((m) => m.id === modelId);
    if (!model) {
      const known = models.filter((m) => m.available !== false).map((m) => m.id);
      throw Object.assign(
        new Error(`Unknown model "${modelId}". Available: ${known.slice(0, 12).join(", ")}...`),
        { code: "MODEL_UNKNOWN" }
      );
    }
  } else {
    const wantTier = tier ?? config.defaults?.tier ?? 1;
    const inTier = models.filter((m) => m.tier === wantTier && m.available !== false);
    if (inTier.length === 0) {
      throw Object.assign(new Error(`No available models in tier ${wantTier}`), {
        code: "TIER_EMPTY",
      });
    }
    // Curated default first, then cheapest output cost
    model =
      inTier.find((m) => m.default) ??
      inTier.slice().sort((a, b) => (a.cost?.output ?? 0) - (b.cost?.output ?? 0))[0];
  }

  if (model.available === false) {
    throw Object.assign(
      new Error(`Model "${model.id}" is not in the live catalog anymore`),
      { code: "MODEL_UNAVAILABLE" }
    );
  }

  const resolved = resolveEffort(model, effort, config);
  return { model, ...resolved };
}

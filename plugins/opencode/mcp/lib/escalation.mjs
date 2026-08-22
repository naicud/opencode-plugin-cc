// Assistant-error classification and escalation suggestions.
//
// When a delegated task ends with an assistant-level error (quota exhausted,
// rate limited, provider outage), `wait` attaches an `escalation` object so
// the supervisor can immediately re-delegate on a higher tier instead of
// guessing. Pure functions over data — no I/O.

/**
 * Classify an assistant message error into a retryable kind.
 * @param {{ name?: string, data?: { message?: string, statusCode?: number } }|null|undefined} error
 * @returns {{ kind: "none"|"auth"|"rate"|"server"|"abort"|"unknown", retryable: boolean }}
 */
export function classifyAssistantError(error) {
  if (!error) return { kind: "none", retryable: false };
  const name = error.name ?? "";
  const msg = String(error.data?.message ?? error.message ?? "");
  const status = Number(error.data?.statusCode ?? NaN);
  if (/aborted/i.test(name) || /^Aborted$/i.test(msg)) return { kind: "abort", retryable: false };
  if (name === "CreditsError" || status === 401 || status === 403 || status === 402) {
    return { kind: "auth", retryable: true };
  }
  if (status === 429 || /rate.?limit|quota/i.test(`${name} ${msg}`)) {
    return { kind: "rate", retryable: true };
  }
  if (Number.isInteger(status) && status >= 500) {
    return { kind: "server", retryable: true };
  }
  return { kind: "unknown", retryable: false };
}

/**
 * Build the escalation suggestion attached to a failed `wait` result.
 * @param {object|null|undefined} error - assistant info.error
 * @param {object} config - parsed models.json
 * @param {string|null|undefined} modelID - model that failed
 * @returns {{ kind: string, retryable: boolean, suggestModel?: string, suggestVariant?: string, reason?: string }}
 */
export function buildEscalation(error, config, modelID) {
  const base = classifyAssistantError(error);
  if (!base.retryable) return base;
  const models = (config.models ?? []).slice().sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
  const currentTier = models.find((m) => m.id === modelID)?.tier ?? config.defaults?.tier ?? 0;
  const next = models.find((m) => (m.tier ?? -Infinity) > currentTier);
  return {
    ...base,
    ...(next ? { suggestModel: next.id, suggestVariant: Array.isArray(next.variants) ? next.variants.at(-1) : undefined } : {}),
    reason: `${base.kind} failure on ${modelID ?? "unknown model"}`,
  };
}

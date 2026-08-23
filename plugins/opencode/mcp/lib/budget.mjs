// Budget accounting and enforcement for the OpenCode companion.
//
// Job cost is derived from OpenCode assistant messages (`info.cost`, USD per
// message). Spend aggregates completed jobs per UTC day so a configurable
// daily cap can gate delegation before it starts. Pure functions over data —
// no I/O.

/**
 * Sum the USD cost of assistant messages.
 * Tolerates missing/null/garbage cost values (non-finite entries are skipped).
 * @param {Array<{ info?: { role?: string, cost?: unknown } }>|null|undefined} messages
 * @returns {number} total rounded to 6 decimals
 */
export function extractAssistantCost(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    if (msg?.info?.role !== "assistant") continue;
    const cost = Number(msg.info.cost);
    if (Number.isFinite(cost)) total += cost;
  }
  return round6(total);
}

/**
 * Aggregate spend over completed jobs, bucketed by UTC day of `createdAt`.
 * Each job's recorded `cost` (USD, captured from assistant messages at
 * completion) counts toward the total; missing/garbage costs count as 0.
 * @param {Array<{ status?: string, createdAt?: string, cost?: unknown }>|null|undefined} jobs
 * @param {{ now?: Date }} [opts] - injectable clock for tests
 * @returns {{ total: number, today: number, byDay: Record<string, number> }}
 */
export function computeSpend(jobs, opts = {}) {
  const byDay = {};
  let total = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job?.status !== "completed") continue;
    const key = utcDay(job.createdAt);
    if (!key) continue;
    const cost = finiteOrUndefined(job.cost) ?? 0;
    byDay[key] = round6((byDay[key] ?? 0) + cost);
    total += cost;
  }
  const now = opts.now instanceof Date ? opts.now : new Date();
  const today = byDay[utcDay(now.toISOString())] ?? 0;
  return { total: round6(total), today: round6(today), byDay };
}

/**
 * Check proposed spend against configured budget limits.
 * @param {object|null|undefined} config - parsed models.json (may be absent)
 * @param {object[]} jobs - persisted job records
 * @param {{ pendingCost?: number, now?: Date }} [opts]
 * @returns {{ ok: true } | { ok: false, code: "BUDGET_JOB_MAX"|"BUDGET_DAILY_MAX", reason: string }}
 */
export function checkBudget(config, jobs, opts = {}) {
  const budget = config?.budget;
  if (!budget || typeof budget !== "object") return { ok: true };
  const pendingCost = Number(opts.pendingCost ?? 0) || 0;
  const maxJobCostUsd = finiteOrUndefined(budget.maxJobCostUsd);
  const maxDailyCostUsd = finiteOrUndefined(budget.maxDailyCostUsd);
  if (maxJobCostUsd !== undefined && pendingCost > maxJobCostUsd) {
    return {
      ok: false,
      code: "BUDGET_JOB_MAX",
      reason: `estimated job cost $${round6(pendingCost)} exceeds maxJobCostUsd $${maxJobCostUsd}`,
    };
  }
  if (maxDailyCostUsd !== undefined) {
    const { today } = computeSpend(jobs, { now: opts.now });
    if (round6(today + pendingCost) > maxDailyCostUsd) {
      return {
        ok: false,
        code: "BUDGET_DAILY_MAX",
        reason: `today's spend $${round6(today)} + estimated $${round6(pendingCost)} would exceed maxDailyCostUsd $${maxDailyCostUsd}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Build a display-ready snapshot of spend vs limits for models/status responses.
 * @param {object|null|undefined} config - parsed models.json (may be absent)
 * @param {object[]} jobs - persisted job records
 * @param {{ now?: Date }} [opts]
 * @returns {{ spend: { total: number, today: number, byDay: Record<string, number> }, limits: { maxJobCostUsd: number|null, maxDailyCostUsd: number|null }, remaining: { daily: number|null } }}
 */
export function summarizeBudget(config, jobs, opts = {}) {
  const budget = config?.budget && typeof config.budget === "object" ? config.budget : {};
  const maxJobCostUsd = finiteOrUndefined(budget.maxJobCostUsd) ?? null;
  const maxDailyCostUsd = finiteOrUndefined(budget.maxDailyCostUsd) ?? null;
  const spend = computeSpend(jobs, { now: opts.now });
  return {
    spend,
    limits: { maxJobCostUsd, maxDailyCostUsd },
    remaining: {
      daily: maxDailyCostUsd === null ? null : Math.max(0, round6(maxDailyCostUsd - spend.today)),
    },
  };
}

function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6;
}

function utcDay(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

function finiteOrUndefined(v) {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

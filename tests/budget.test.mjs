import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractAssistantCost,
  computeSpend,
  checkBudget,
  summarizeBudget,
} from "../plugins/opencode/mcp/lib/budget.mjs";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const YESTERDAY = "2026-08-22T23:30:00.000Z";

function job(status, createdAt, cost) {
  return { id: `j-${Math.random().toString(36).slice(2, 8)}`, status, createdAt, cost };
}

describe("extractAssistantCost", () => {
  it("sums assistant message costs", () => {
    const messages = [
      { info: { role: "assistant", cost: 0.0123 } },
      { info: { role: "assistant", cost: 0.0007 } },
      { info: { role: "assistant", cost: 1 } },
    ];
    assert.equal(extractAssistantCost(messages), 1.013);
  });

  it("ignores non-assistant messages and parts-only entries", () => {
    const messages = [
      { info: { role: "user", cost: 99 } },
      { parts: [{ type: "text" }] },
      { info: { role: "assistant", cost: 0.5 } },
    ];
    assert.equal(extractAssistantCost(messages), 0.5);
  });

  it("tolerates missing/null/garbage costs", () => {
    const messages = [
      { info: { role: "assistant" } },
      { info: { role: "assistant", cost: null } },
      { info: { role: "assistant", cost: "banana" } },
      { info: { role: "assistant", cost: NaN } },
      {},
      { info: { role: "assistant", cost: 2 } },
    ];
    assert.equal(extractAssistantCost(messages), 2);
  });

  it("empty/invalid input → 0", () => {
    assert.equal(extractAssistantCost([]), 0);
    assert.equal(extractAssistantCost(null), 0);
    assert.equal(extractAssistantCost(undefined), 0);
    assert.equal(extractAssistantCost("nope"), 0);
  });
});

describe("computeSpend", () => {
  it("counts only completed jobs", () => {
    const jobs = [
      job("completed", NOW.toISOString(), 0.5),
      job("failed", NOW.toISOString(), 10),
      job("cancelled", NOW.toISOString(), 20),
      job("running", NOW.toISOString(), 40),
    ];
    const s = computeSpend(jobs, { now: NOW });
    assert.equal(s.total, 0.5);
    assert.equal(s.today, 0.5);
  });

  it("buckets by UTC day across midnight boundary", () => {
    const jobs = [
      job("completed", "2026-08-22T23:59:59.999Z", 1),
      job("completed", YESTERDAY, 2),
      job("completed", "2026-08-23T00:00:00.000Z", 4),
    ];
    const s = computeSpend(jobs, { now: NOW });
    assert.deepEqual(s.byDay, { "2026-08-22": 3, "2026-08-23": 4 });
    assert.equal(s.total, 7);
    assert.equal(s.today, 4);
  });

  it("today reflects injected now, defaults to real clock", () => {
    const jobs = [job("completed", YESTERDAY, 3), job("completed", NOW.toISOString(), 1)];
    assert.equal(computeSpend(jobs, { now: new Date("2026-08-22T10:00:00.000Z") }).today, 3);
    assert.equal(computeSpend(jobs, { now: NOW }).today, 1);
    assert.equal(computeSpend(jobs).total, 4);
  });

  it("missing/garbage createdAt or cost skipped or zeroed", () => {
    const jobs = [
      job("completed", undefined, 1),
      job("completed", "not-a-date", 2),
      job("completed", NOW.toISOString(), "garbage"),
      job("completed", NOW.toISOString()),
    ];
    const s = computeSpend(jobs, { now: NOW });
    assert.deepEqual(s.byDay, { "2026-08-23": 0 });
    assert.equal(s.total, 0);
  });

  it("empty jobs → zeros with empty byDay", () => {
    assert.deepEqual(computeSpend([], { now: NOW }), { total: 0, today: 0, byDay: {}, byAccountToday: {} });
    assert.deepEqual(computeSpend(null, { now: NOW }), { total: 0, today: 0, byDay: {}, byAccountToday: {} });
  });
});

describe("checkBudget", () => {
  it("no config / no budget block → ok", () => {
    assert.deepEqual(checkBudget(null, [], {}), { ok: true });
    assert.deepEqual(checkBudget(undefined, [], { pendingCost: 999 }), { ok: true });
    assert.deepEqual(checkBudget({ models: [] }, [], { pendingCost: 999 }), { ok: true });
    assert.deepEqual(checkBudget({ budget: {} }, [], { pendingCost: 999 }), { ok: true });
  });

  it("null/undefined limit values are ignored", () => {
    const config = { budget: { maxJobCostUsd: null, maxDailyCostUsd: undefined } };
    assert.deepEqual(checkBudget(config, [], { pendingCost: 1000 }), { ok: true });
  });

  it("job-max trips when pendingCost strictly exceeds limit", () => {
    const config = { budget: { maxJobCostUsd: 0.5 } };
    const r = checkBudget(config, [], { pendingCost: 0.51 });
    assert.deepEqual(r.code, "BUDGET_JOB_MAX");
    assert.match(r.reason, /exceeds/);
    assert.equal(r.ok, false);
  });

  it("job-max exactly at limit passes (strictly greater trips)", () => {
    assert.deepEqual(checkBudget({ budget: { maxJobCostUsd: 0.5 } }, [], { pendingCost: 0.5 }), { ok: true });
    assert.deepEqual(checkBudget({ budget: { maxJobCostUsd: 0.5 } }, [], { pendingCost: 0 }), { ok: true });
  });

  it("daily-max trips when today + pending exceeds limit", () => {
    const config = { budget: { maxDailyCostUsd: 1 } };
    const jobs = [job("completed", NOW.toISOString(), 0.75)];
    const r = checkBudget(config, jobs, { pendingCost: 0.26, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.code, "BUDGET_DAILY_MAX");
    assert.match(r.reason, /daily/i);
  });

  it("daily-max exactly at limit passes; yesterday's spend excluded", () => {
    const config = { budget: { maxDailyCostUsd: 1 } };
    const jobs = [job("completed", YESTERDAY, 0.75)];
    assert.deepEqual(checkBudget(config, jobs, { pendingCost: 0.25, now: NOW }), { ok: true });
    const todayJob = [job("completed", NOW.toISOString(), 0.75)];
    assert.deepEqual(checkBudget(config, todayJob, { pendingCost: 0.25, now: NOW }), { ok: true });
  });

  it("pendingCost defaults to 0: unknown-cost delegates pass unless daily sum alone exceeds", () => {
    const config = { budget: { maxDailyCostUsd: 1 } };
    const underJobs = [job("completed", NOW.toISOString(), 0.99)];
    assert.deepEqual(checkBudget(config, underJobs, { now: NOW }), { ok: true });
    const overJobs = [job("completed", NOW.toISOString(), 1.01)];
    const r = checkBudget(config, overJobs, { now: NOW });
    assert.equal(r.code, "BUDGET_DAILY_MAX");
    assert.equal(checkBudget(config, overJobs, { now: NOW }).code, "BUDGET_DAILY_MAX");
  });

  it("both limits set: job-max checked before daily-max", () => {
    const config = { budget: { maxJobCostUsd: 0.5, maxDailyCostUsd: 1 } };
    const jobs = [job("completed", NOW.toISOString(), 0.9)];
    const r = checkBudget(config, jobs, { pendingCost: 0.6, now: NOW });
    assert.equal(r.code, "BUDGET_JOB_MAX");
  });

  it("garbage limit values are ignored like unset", () => {
    assert.deepEqual(checkBudget({ budget: { maxJobCostUsd: "lots" } }, [], { pendingCost: 5 }), { ok: true });
    assert.deepEqual(checkBudget({ budget: { maxDailyCostUsd: NaN } }, [], { pendingCost: 5 }), { ok: true });
  });
});

describe("summarizeBudget", () => {
  it("shapes spend/limits/remaining with limits set", () => {
    const config = { budget: { maxJobCostUsd: 2, maxDailyCostUsd: 5 } };
    const jobs = [job("completed", NOW.toISOString(), 1.25), job("failed", NOW.toISOString(), 9)];
    const s = summarizeBudget(config, jobs, { now: NOW });
    assert.deepEqual(s.limits, { maxJobCostUsd: 2, maxDailyCostUsd: 5 });
    assert.equal(s.spend.today, 1.25);
    assert.equal(s.spend.total, 1.25);
    assert.equal(s.remaining.daily, 3.75);
  });

  it("no budget block → null limits and null remaining.daily", () => {
    const s = summarizeBudget(null, []);
    assert.deepEqual(s.limits, { maxJobCostUsd: null, maxDailyCostUsd: null });
    assert.deepEqual(s.remaining, { daily: null });
    assert.deepEqual(s.spend, { total: 0, today: 0, byDay: {}, byAccountToday: {} });
  });

  it("remaining.daily floors at 0 when overspent", () => {
    const config = { budget: { maxDailyCostUsd: 1 } };
    const jobs = [job("completed", NOW.toISOString(), 1.5)];
    const s = summarizeBudget(config, jobs, { now: NOW });
    assert.equal(s.remaining.daily, 0);
  });

  it("only maxJobCostUsd set → daily remaining stays null", () => {
    const s = summarizeBudget({ budget: { maxJobCostUsd: 1 } }, [], { now: NOW });
    assert.deepEqual(s.remaining, { daily: null });
  });
});

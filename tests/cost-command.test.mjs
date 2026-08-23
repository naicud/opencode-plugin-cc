// Tests for the /opencode:cost pipeline: buildCostSnapshot aggregation +
// renderCost formatting (pure functions, no server needed).

import test from "node:test";
import assert from "node:assert/strict";
import { buildCostSnapshot } from "../plugins/opencode/scripts/lib/job-control.mjs";
import { renderCost } from "../plugins/opencode/scripts/lib/render.mjs";

const NOW = new Date("2026-08-23T12:00:00.000Z");

function job(over = {}) {
  return {
    type: "delegate",
    status: "completed",
    cost: 0.5,
    model: "x-preview-f-free",
    account: null,
    createdAt: "2026-08-23T10:00:00.000Z",
    ...over,
  };
}

test("buildCostSnapshot aggregates totals, byModel, byAccount", () => {
  const snap = buildCostSnapshot(
    [
      job({ cost: 0.25, model: "kimi-k3", account: "work" }),
      job({ cost: 0.75, model: "kimi-k3", account: "personal" }),
      job({ cost: 1, model: "x-preview-f-free" }),
      // ignored shapes:
      job({ status: "running", cost: 99 }),
      job({ type: "rescue", status: "completed", cost: 42 }),
      // counted in total (garbage cost = 0) but skipped by byModel/byAccount:
      job({ status: "completed", cost: "banana" }),
    ],
    null,
    { now: NOW }
  );
  assert.equal(snap.count, 4);
  assert.equal(snap.total, 2);
  assert.equal(snap.today, 2);
  assert.equal(snap.byModel["kimi-k3"], 1);
  assert.equal(snap.byModel["x-preview-f-free"], 1);
  assert.equal(snap.byAccount.work, 0.25);
  assert.equal(snap.byAccount.personal, 0.75);
  assert.equal(snap.byAccount.default, 1);
});

test("yesterday's spend lands in byDay but not today", () => {
  const snap = buildCostSnapshot(
    [
      job({ cost: 2, createdAt: "2026-08-22T23:59:59.999Z" }),
      job({ cost: 3, createdAt: "2026-08-22T00:00:00.000Z" }),
      job(),
    ],
    null,
    { now: NOW }
  );
  assert.equal(snap.total, 5.5);
  assert.equal(snap.today, 0.5);
  assert.equal(snap.byDay["2026-08-22"], 5);
});

test("empty jobs → zeroed snapshot + empty-state render", () => {
  const snap = buildCostSnapshot([], null, { now: NOW });
  assert.equal(snap.count, 0);
  assert.equal(snap.total, 0);
  const text = renderCost(snap);
  assert.match(text, /No completed delegation jobs/);
});

test("renderCost shows budget limits and remaining when configured", () => {
  const config = { budget: { maxJobCostUsd: 5, maxDailyCostUsd: 4 } };
  const snap = buildCostSnapshot([job(), job(), job()], config, { now: NOW });
  assert.deepEqual(snap.limits, { maxJobCostUsd: 5, maxDailyCostUsd: 4 });
  const text = renderCost(snap);
  assert.match(text, /\$1\.500000 across 3 completed job/);
  assert.match(text, /daily \$4\.000000/);
  assert.match(text, /Remaining today\*\*: \$2\.500000/);
  assert.match(text, /### By day/);
  assert.match(text, /2026-08-23: \$1\.500000/);
});

test("unset limits render as unset without remaining line", () => {
  const text = renderCost(buildCostSnapshot([job()], null, { now: NOW }));
  assert.match(text, /per-job unset, daily unset/);
  assert.doesNotMatch(text, /Remaining today/);
});

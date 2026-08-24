// Tests for the zero-dependency HTML cost dashboard (renderCostHtml).

import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { renderCostHtml } from "../plugins/opencode/scripts/lib/render.mjs";
import { buildCostSnapshot } from "../plugins/opencode/scripts/lib/job-control.mjs";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function job(over = {}) {
  return {
    id: "delegate-t1",
    type: "delegate",
    status: "completed",
    sessionID: "ses_x",
    createdAt: new Date("2026-08-24T10:00:00.000Z").toISOString(),
    completedAt: new Date("2026-08-24T11:00:00.000Z").toISOString(),
    cost: 0.25,
    model: "x-preview-f-free",
    account: null,
    ...over,
  };
}

function snap(jobs, config = {}) {
  return buildCostSnapshot(jobs, config, { now: NOW });
}

test("empty snapshot renders the empty-state document", () => {
  const html = renderCostHtml(snap([]));
  assert.match(html, /No completed delegation jobs/);
  assert.match(html, /<!doctype html>/i);
});

test("full snapshot contains totals, counts and today", () => {
  const html = renderCostHtml(
    snap([job(), job({ id: "d2", cost: 1.5 }), job({ id: "d3", cost: 0.25 })])
  );
  assert.match(html, /\$2\.00/); // total
  assert.match(html, /Completed jobs/);
  assert.match(html, />3</);
  assert.match(html, /2026-08-24/); // by-day label present
});

test("bar heights scale to the max value", () => {
  const html = renderCostHtml(
    snap([
      job({ cost: 4, createdAt: new Date("2026-08-24T10:00:00.000Z").toISOString() }),
      job({ cost: 1, createdAt: new Date("2026-08-23T10:00:00.000Z").toISOString() }),
    ])
  );
  // max day bar is 90px tall; smaller value must be strictly shorter
  const heights = [...html.matchAll(/<rect y="\d+"[^>]*height="(\d+)"/g)]
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  assert.ok(heights[0] === 90, `tallest bar should cap at 90, got ${heights[0]}`);
  assert.ok(heights.length >= 2 && heights[1] < 90, "second bar shorter than max");
});

test("model keys are HTML-escaped", () => {
  const html = renderCostHtml(
    snap([job({ model: '<script>alert("x")</script>', cost: 1 })])
  );
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("by-day chart keeps only last 14 days sorted ascending", () => {
  const jobs = [];
  for (let i = 20; i >= 1; i--) {
    jobs.push(job({ id: `d${i}`, createdAt: new Date(Date.UTC(2026, 7, i)).toISOString() }));
  }
  const html = renderCostHtml(snap(jobs));
  assert.ok(!html.includes("2026-08-06"), "day 6 outside the 14-day window");
  const firstIdx = html.indexOf("2026-08-11");
  const secondIdx = html.indexOf("2026-08-12");
  assert.ok(firstIdx !== -1 && secondIdx > firstIdx, "days ascending in output");
});

test("account section appears only with more than one account", () => {
  const one = renderCostHtml(snap([job()]));
  assert.ok(!one.includes("By account"), "single/default account hidden");
  const two = renderCostHtml(
    snap([job({ account: "a" }), job({ id: "d2", account: "b", cost: 2 })])
  );
  assert.match(two, /By account/);
});

test("daily budget gauge renders fraction and remaining", () => {
  const html = renderCostHtml(
    snap([job({ cost: 2 })], { budget: { maxDailyCostUsd: 10, maxJobCostUsd: 5 } })
  );
  assert.match(html, /width:20%/); // 2 of 10
  assert.match(html, /remaining \$8\.00/);
  assert.match(html, /Per-job limit:\s*<\/span> <span class="val">\$5\.00/);
});

test("unset limits render as unset without gauge fill", () => {
  const html = renderCostHtml(snap([job()]), {});
  assert.match(html, /Daily budget:<\/span> <span class="val">unset<\/span>/);
  assert.match(html, /Per-job limit:\s*<\/span> <span class="val">unset/);
});

test("generated timestamp is embedded", () => {
  const html = renderCostHtml(snap([job()]), { now: NOW });
  assert.match(html, new RegExp(NOW.toISOString().slice(0, 13)));
});

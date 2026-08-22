import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichJob,
  resolveResultJob,
  resolveCancelableJob,
  matchJobReference,
} from "../plugins/opencode/scripts/lib/job-control.mjs";
import { renderResult } from "../plugins/opencode/scripts/lib/render.mjs";

const mcpJob = {
  id: "delegate-mt4xg3ji-uu14kr",
  type: "delegate",
  status: "failed",
  sessionID: "ses_abc123",
  model: "x-preview-f-free",
  variant: "max",
  account: "accA",
  retryOf: "delegate-mt4xg3ji-old",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  completedAt: new Date().toISOString(),
  errorMessage: "CreditsError 401",
};

const legacyJob = {
  id: "review-legacy-01",
  type: "review",
  status: "completed",
  opencodeSessionId: "ses_legacy",
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  completedAt: new Date(Date.now() - 90_000).toISOString(),
};

describe("job-control with MCP delegate jobs", () => {
  it("enrichJob normalizes MCP sessionID into opencodeSessionId", () => {
    const e = enrichJob(mcpJob, "/tmp");
    assert.equal(e.opencodeSessionId, "ses_abc123");
  });

  it("enrichJob keeps legacy opencodeSessionId untouched", () => {
    const e = enrichJob(legacyJob, "/tmp");
    assert.equal(e.opencodeSessionId, "ses_legacy");
  });

  it("renderResult surfaces session, model and retry chain for MCP jobs", () => {
    const out = renderResult(enrichJob(mcpJob, "/tmp"), null);
    assert.match(out, /OpenCode Session\*\*: ses_abc123/);
    assert.match(out, /Model\*\*: x-preview-f-free · variant=max · account=accA/);
    assert.match(out, /Retry of\*\*: delegate-mt4xg3ji-old/);
    assert.match(out, /CreditsError 401/);
  });

  it("resolveResultJob finds failed MCP delegate jobs by prefix", () => {
    const { job, ambiguous } = resolveResultJob([mcpJob, legacyJob], "delegate-mt4xg3ji-uu");
    assert.equal(ambiguous, false);
    assert.equal(job.id, mcpJob.id);
  });

  it("matchJobReference reports ambiguity on shared prefixes", () => {
    const a = { ...mcpJob };
    const b = { ...mcpJob, id: mcpJob.id + "-2" };
    const { ambiguous } = matchJobReference([a, b], a.id.slice(0, 10));
    assert.equal(ambiguous, true);
  });

  it("resolveCancelableJob resolves running MCP jobs", () => {
    const running = { ...mcpJob, status: "running", completedAt: undefined };
    const { job } = resolveCancelableJob([running], running.id.slice(0, 12));
    assert.equal(job.id, running.id);
  });
});

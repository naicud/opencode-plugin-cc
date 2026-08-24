---
name: opencode-delegation
description: Criteria for choosing the model tier and structuring tasks when delegating work to OpenCode models
user-invocable: false
---

# OpenCode Delegation Guide

Use this skill when handing a task to an OpenCode model through the `delegate` MCP tool.

## Tier Selection

| Tier | Models | Use | Cost |
|---|---|---|---|
| 0 | x-preview-f-free (**default**), ox-alpha-free | Everyday implementation, tests, features | free |
| 1-3 | empty — all paid models are `excluded` | n/a until billing returns | — |

Free-only mode is ACTIVE: all paid models are in `excluded` (config/models.json) — billing
exhausted. Only free models are selectable: x-preview-f-free, ox-alpha-free, big-pickle,
hy3-free, mimo-v2.5-free, nemotron-3-ultra-free, nemotron-3.5-lightning-free. Do not request
paid models; requests fail with `MODEL_EXCLUDED`.

Rules:

- Effort is ALWAYS `max` (policy mode "max", strict chains — no silent downgrade).
- When unsure between two tiers, take the LOWER one. Retry at most once and only one tier higher — but with tiers 1-3 empty, a failed free run should be reported BLOCKED rather than escalated to an excluded model.
- Never request excluded models (see `excluded` in config/models.json).

## Effort

- `max` is mandatory for every delegation; the resolver sends it explicitly and fails loudly (`effortApplied: "none"` + reason) rather than silently downgrading.
- Do not pass `effort: "off"` or `effort: "high"` unless the caller explicitly demands it.

## Task Structure

A delegable task contains, in order:

1. **Goal** — one sentence, outcome-focused.
2. **Scope** — files in scope as explicit paths; call out out-of-scope areas.
3. **Acceptance criteria** — verifiable statements ("`npm test` passes", "endpoint returns 200").
4. **Verification command** — a concrete command that proves completion.

The delegation contract (config/models.json) is prepended automatically: it restricts work to the workspace and requires a `.oc-report.md` with STATUS + files list.

## Supervision Loop

- `delegate` → save sessionID/jobId
- `wait` until idle / needsInput / timeout (600s per call); for parallel fan-outs use
  `waitAll` with up to 12 sessionIDs (shared deadline, one result + summary each)
- `logs {sessionID}` tails the job's activity log — streamed reasoning, assistant output,
  permission asks, lifecycle transitions — to see what the agent is doing right now
- `needsInput`: approve only safe read/test commands (`respond once`); reject git push/commit, rm -rf, sudo, curl-to-shell
- two consecutive timeouts → `abort`
- blast-radius check → `diff {sessionID}` (tracked diff + untracked files since the job's `gitBase` snapshot)
- done supervising → `shutdown` stops the spawned servers cleanly (sessions aborted gracefully,
  only identity-verified pids killed, jobs marked cancelled; `all: true` sweeps every workspace)
- failed with retryable error → follow the `escalation` object: re-delegate at `suggestModel` + `suggestVariant`, passing `retryOf: <failed jobId>`
- crashed/interrupted session → re-delegate with `resumeSessionID: <sessionID>` to continue in place
- verify `.oc-report.md` AND listed files yourself before trusting success

## Anti-patterns

- Delegating vague asks without acceptance criteria
- Trusting the model report without checking files/tests
- Retrying repeatedly at the same tier instead of escalating once or aborting
- Spending tier 3 budget on work tier 1 can finish

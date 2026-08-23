---
name: opencode-delegation
description: Criteria for choosing the model tier and structuring tasks when delegating work to OpenCode models
user-invocable: false
---

# OpenCode Delegation Guide

Use this skill when handing a task to an OpenCode model through the `delegate` MCP tool.

## Tier Selection

| Tier | Model | Use | Cost |
|---|---|---|---|
| 0 | x-preview-f-free (**default**) | Everyday implementation, tests, features | free |
| 1 | deepseek-v4-flash | Fast paid fallback when tier 0 unavailable | low |
| 2 | deepseek-v4-pro | Hard refactors, debugging, multi-file changes | medium |
| 3 | kimi-k3 | Architecture rewrites, hardest problems only | high |

Rules:

- Effort is ALWAYS `max` (policy mode "max", strict chains — no silent downgrade).
- When unsure between two tiers, take the LOWER one. Retry at most once and only one tier higher.
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
- `needsInput`: approve only safe read/test commands (`respond once`); reject git push/commit, rm -rf, sudo, curl-to-shell
- two consecutive timeouts → `abort`
- failed with retryable error → follow the `escalation` object: re-delegate at `suggestModel` + `suggestVariant`, passing `retryOf: <failed jobId>`
- crashed/interrupted session → re-delegate with `resumeSessionID: <sessionID>` to continue in place
- verify `.oc-report.md` AND listed files yourself before trusting success

## Anti-patterns

- Delegating vague asks without acceptance criteria
- Trusting the model report without checking files/tests
- Retrying repeatedly at the same tier instead of escalating once or aborting
- Spending tier 3 budget on work tier 1 can finish

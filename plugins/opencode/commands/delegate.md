---
description: Delegate a task to an OpenCode model with tier/effort control and supervise it
argument-hint: '[--model <id>] [--tier N] [--effort max|high|off] [--account <name|auto>] [--auto-retry] <task>'
allowed-tools: Bash(node:*), mcp__plugin_opencode_oc__models, mcp__plugin_opencode_oc__delegate, mcp__plugin_opencode_oc__wait, mcp__plugin_opencode_oc__waitAll, mcp__plugin_opencode_oc__status, mcp__plugin_opencode_oc__logs, mcp__plugin_opencode_oc__respond, mcp__plugin_opencode_oc__abort, mcp__plugin_opencode_oc__shutdown, mcp__plugin_opencode_oc__doctor, mcp__plugin_opencode_oc__diff
---

Delegate the following task through the OpenCode MCP tools.

Parse routing flags from $ARGUMENTS and strip them from the task text:

- `--model <id>` → explicit model id for the `delegate` call
- `--tier N` → tier selection (0–3) when no explicit model
- `--effort max|high|off` → effort request
- `--account <name|auto>` → OpenCode account for quota routing (default `auto`: round-robin/fixed per config; only meaningful when accounts are configured)
- `--retry <job-id-prefix>` → link this run to a previously failed/cancelled job (`retryOf`)
- `--resume <sessionID>` → continue an existing delegated session instead of creating a new one
- `--auto-retry` → on retryable failure (quota/rate/5xx) re-delegate once at the escalation-suggested model+variant (`wait` returns `status:"retried"`)

Procedure:

1. Call `models` with `{cwd}` to see tiers and budget. If no flag picked a model: default tier 0 (x-preview-f-free, free); hard refactor = tier 2 (deepseek-v4-pro); hardest problems = tier 3 (kimi-k3). Effort is ALWAYS max.
2. Call `delegate` with `{task: <stripped task text>, cwd, ...flags}`. If `--retry` or `--resume` given, map them to `retryOf` / `resumeSessionID`. If `--auto-retry` given, map it to `autoRetry: true`.
3. Call `wait` with `{sessionID, cwd, timeoutSec: 600}` in a loop until it returns idle or needsInput.
4. On `needsInput`, decide each permission: approve read-only/test commands with `respond {response:"once"}`; reject anything matching git push/commit, rm -rf, sudo, or curl piped to shell, then report blocked.
5. Verify per the delegation contract: read `.oc-report.md`, check the listed files exist, re-run read-only verification commands if given.
6. Report STATUS (your judgment), changed files, verification performed, model used and effortApplied.

If two consecutive `wait` calls time out, call `abort`. If the final `wait` carried an `escalation` object (retryable failure), re-delegate once with `suggestModel` + `suggestVariant` and `--retry <failed jobId>`.

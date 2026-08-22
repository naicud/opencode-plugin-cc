---
description: Delegate a task to an OpenCode model with tier/effort control and supervise it
argument-hint: '[--model <id>] [--tier N] [--effort max|high|off] <task>'
allowed-tools: Bash(node:*), mcp__plugin_opencode_oc__models, mcp__plugin_opencode_oc__delegate, mcp__plugin_opencode_oc__wait, mcp__plugin_opencode_oc__status, mcp__plugin_opencode_oc__respond, mcp__plugin_opencode_oc__abort
---

Delegate the following task through the OpenCode MCP tools.

Parse routing flags from $ARGUMENTS and strip them from the task text:

- `--model <id>` → explicit model id for the `delegate` call
- `--tier N` → tier selection (0–3) when no explicit model
- `--effort max|high|off` → effort request

Procedure:

1. Call `models` with `{cwd}` to see tiers and budget. If no flag picked a model: default tier 0 (x-preview-f-free, free); hard refactor = tier 2 (deepseek-v4-pro); hardest problems = tier 3 (kimi-k3). Effort is ALWAYS max.
2. Call `delegate` with `{task: <stripped task text>, cwd, ...flags}`.
3. Call `wait` with `{sessionID, cwd, timeoutSec: 600}` in a loop until it returns idle or needsInput.
4. On `needsInput`, decide each permission: approve read-only/test commands with `respond {response:"once"}`; reject anything matching git push/commit, rm -rf, sudo, or curl piped to shell, then report blocked.
5. Verify per the delegation contract: read `.oc-report.md`, check the listed files exist, re-run read-only verification commands if given.
6. Report STATUS (your judgment), changed files, verification performed, model used and effortApplied.

If two consecutive `wait` calls time out, call `abort` and report failure.

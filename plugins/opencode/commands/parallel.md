---
description: Fan out MULTIPLE tasks in parallel to OpenCode and supervise the batch
argument-hint: '[--race] [--tier N] [--model <id>] [--effort max|high|off] [--account <name|auto>] <task1> ;; <task2> ;; <task3>'
allowed-tools: Bash(node:*), mcp__plugin_opencode_oc__models, mcp__plugin_opencode_oc__fanOut, mcp__plugin_opencode_oc__waitAll, mcp__plugin_opencode_oc__status, mcp__plugin_opencode_oc__respond, mcp__plugin_opencode_oc__abort, mcp__plugin_opencode_oc__shutdown, mcp__plugin_opencode_oc__doctor, mcp__plugin_opencode_oc__diff
---

Fan out multiple tasks to OpenCode in parallel through the MCP tools.

Split $ARGUMENTS into individual tasks: separate them with `;;` (or one per list item).
Parse and strip routing flags (same meaning as `/opencode:delegate`):

- `--tier N` → tier for the whole batch (0–3)
- `--model <id>` → explicit model id for every task
- `--effort max|high|off` → effort level (default max)
- `--account auto|<name>` → "auto" rotates accounts round-robin per task
- `--race` → RACE MODE: all tasks should be variants of the SAME goal; `fanOut` runs them with
  `mode:"race"` and the first clean completion wins — losers are aborted automatically. Use for
  quality-at-speed (same task twice) or cross-model comparison (different `--model` per task is
  not supported in one call; run two fanOuts instead). Report the winner's response + cost.

## Procedure

1. **fanOut** with `tasks: [...]`, the parsed flags, and a short `titlePrefix`.
2. **waitAll** on the returned sessionIDs (timeoutSec 300). On `needsInput`,
   review each pending permission with `respond` — approve only safe read/test
   commands, reject git push/commit, rm -rf, sudo, curl-to-shell.
3. For any session ending in a retryable error, re-delegate it individually via
   `delegate` with the escalation's `suggestModel`/`suggestVariant` and
   `retryOf: <failed jobId>`.
4. Two consecutive timeouts on one session → `abort` it.
5. **Verify**: read each task's expected artifacts yourself; do not trust the
   report alone. Cross-check each session's blast radius with
   `diff {sessionID}` (changes since job spawn).
6. Report one line per task: artifact verdict + cost + account used.

If more than 12 tasks are given, run fanOut in batches of ≤12 sequentially.

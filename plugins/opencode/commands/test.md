---
description: Delegate a quick smoke-test of the current workspace changes to OpenCode (preset: fast tier, auto-retry, diff-verified)
argument-hint: '[extra instructions for the test task]'
allowed-tools: Bash(node:*), mcp__plugin_opencode_oc__delegate, mcp__plugin_opencode_oc__wait, mcp__plugin_opencode_oc__diff, mcp__plugin_opencode_oc__status
---

Delegate a smoke-test of this workspace to OpenCode and verify it end-to-end.

1. Snapshot state: run `git status --short` (via your normal tools) so you know the starting point.
2. Delegate ONE task via `mcp__plugin_opencode_oc__delegate` with:
   - `cwd`: current workspace
   - `tier`: 1 (fast paid fallback — a smoke test should be quick; use 0 only if tier1 has no credentials)
   - `effort`: "max" (always)
   - `autoRetry`: true
   - `title`: "Smoke test <short description>"
   - Task text: "Esegui uno smoke test di questo workspace: esegui i comandi di build/test disponibili (package.json scripts, Makefile, ecc.), verifica che passino, poi scrivi .oc-report.md con STATUS (COMPLETED se tutto passa, PARTIAL se alcuni falliscono, FAILED altrimenti) e la lista dei file verificati. $ARGUMENTS"
3. Wait with `mcp__plugin_opencode_oc__wait` (timeoutSec 600). On needsInput respond sensibly; on retried follow the new sessionID.
4. Verify with `mcp__plugin_opencode_oc__diff {sessionID}` — report what the agent touched.
5. Report one line: verdict + failing checks (if any) + artifact/report paths. Never commit anything the agent produced.

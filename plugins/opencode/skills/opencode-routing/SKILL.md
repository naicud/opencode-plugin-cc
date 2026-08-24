---
name: opencode-routing
description: Use PROACTIVELY when the user asks for subagents, delegation, parallel workers, background tasks or fan-out work — routes heavy work to OpenCode via the opencode-delegate agent or the mcp__plugin_opencode_oc__delegate/fanOut tools. Do NOT route routine single-file edits, quick questions, exploration or anything you can finish in a couple of steps.
user-invocable: true
---

# OpenCode Routing Guide

Decide WHEN work should leave this thread, then hand it off correctly.

## Route to OpenCode (proactively)

- User explicitly asks for subagents, delegates, parallel/background workers, fan-out.
- Heavy implementation: multi-file refactors, migrations, large test suites, builds with long verification loops.
- Reviews/audits that benefit from an isolated reviewer persona (`persona: "reviewer"`).
- Several independent chunks of work at once → `fanOut` (up to 12) + `waitAll`.
- The task needs its own workspace blast-radius isolation → use the `opencode-delegate` agent (isolation: worktree).

## Keep on the main thread (do NOT delegate)

- Single-file edits, typo fixes, one-function changes.
- Exploration, lookups, quick questions, reading code.
- Anything where shaping a full task contract costs more than doing the work.

When unsure, do it yourself. Delegation pays only when the task is self-contained and verifiable.

## How to hand off

1. Prefer spawning the **opencode-delegate** subagent for substantial single tasks; it runs the full supervise+verify loop itself.
2. Or call the MCP tools directly:
   - `mcp__plugin_opencode_oc__delegate {task}` — omit tier/model; the resolver applies the default free tier and max effort.
   - `wait {sessionID}` until idle / needsInput / timeout.
   - `logs {sessionID}` to see the agent's streamed reasoning, output and permission asks live.
   - `diff {sessionID}` for blast radius; verify `.oc-report.md` yourself before trusting success.
3. Parallel batches: `fanOut` once per batch, then `waitAll`.

## Task quality bar

A delegable task states goal (one sentence), in-scope files, verifiable acceptance criteria, and a verification command. Vague asks must be tightened BEFORE delegating (see opencode-prompting).

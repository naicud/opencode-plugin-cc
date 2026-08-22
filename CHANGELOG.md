# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0] - 2026-08-23

### Added
- **Retry chains**: `delegate` accepts `retryOf` (job id or prefix of a failed/cancelled
  delegate job); validated against job history (`RETRY_TARGET_NOT_FOUND`, `RETRY_OF_AMBIGUOUS`),
  stored in the job record and echoed in the response.
- **Session resume**: `delegate` accepts `resumeSessionID` to continue an existing persisted
  OpenCode session (crash recovery, multi-step delegation) instead of creating a new one;
  fails fast with `RESUME_SESSION_NOT_FOUND`; E2E-verified by resuming an aborted session.
- `/opencode:result` and `/opencode:cancel` now understand MCP delegate jobs (session id
  normalization, model/variant/account and retry-chain rendering).
- **Live wait progress**: when `wait` hits its deadline the response carries a `progress`
  object (latest assistant text tail + todo counts), and the delegation hook surfaces it
  so Claude sees movement without extra `status` calls.

### Changed
- Version bumps and docs propagation of retry/resume/escalation flows into the skill,
  agent and command guidance.

## [1.1.0] - 2026-08-23

### Added
- **Multi-account quota routing**: configure multiple OpenCode accounts in `config/models.json`
  (`accounts.names`, `strategy: fixed|round-robin`, `default`); credentials via
  `OPENCODE_DELEGATE_KEY_<ACCOUNT>` env vars; per-account servers injected with
  `OPENCODE_AUTH_CONTENT`; distinct derived port per workspace+account; account persisted in job
  records and resolved automatically by `wait`/`status`/`respond`/`abort`.
- **Error escalation hints**: when a delegated task fails with a retryable error (quota, rate
  limit, provider 5xx), `wait` returns an `escalation` object suggesting the next configured tier;
  the PostToolUse hook turns it into concrete re-delegate guidance.
- **PostToolUse delegation hook** (`scripts/delegation-context-hook.mjs`): injects completion,
  permission-blocked, timeout, and escalation context into Claude's session after every
  `wait`/`status` call.
- **GitHub Actions CI** (`.github/workflows/test.yml`): unit suite + full syntax check on Node 20
  and 22.
- **Multi-account E2E stress** (`npm run test:multiaccount`): round-robin rotation across two named
  credentials, per-account server isolation, explicit picks, unknown-account rejection, state
  persistence.
- MCP tool descriptors now carry `title` and standard annotations (`readOnlyHint`,
  `destructiveHint`, …).
- Permission rules hot-reload: the watcher re-reads config on every event (no MCP restart needed).
- `.mcp.json` passes `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` through for
  authenticated opencode serve instances.
- `delegate` creates titled sessions (task-derived) visible in the OpenCode UI; `wait` responses
  include `jobId` tie-back, `account`, and a todo progress summary.

### Fixed
- `wait` race right after `prompt_async`: no longer reports idle before the assistant reply exists.
- README install/uninstall URLs point at this fork (`naicud/opencode-plugin-cc`).
- License metadata corrected to Apache-2.0 (matches LICENSE file).
- `formatHint` uses the merged live catalog and never recommends unavailable models.

### Changed
- Curated catalog reduced to four models used at max effort by default:
  x-preview-f-free (tier 0), deepseek-v4-flash (1), deepseek-v4-pro (2), kimi-k3 (3);
  strict variant chains — no silent downgrade.

## [1.0.0] - initial release

- `/opencode:*` commands, rescue/delegate agents, skills, hooks, and the six-tool delegation MCP
  server over stdio with zero npm dependencies.

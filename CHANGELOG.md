# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.10.0] - 2026-08-24

### Added
- **`/opencode:model` wizard + `model-config` lib**: list the catalog with tiers/variants/costs,
  add models (`model add <id> --tier N [--variants] [--cost-in/out] [--default]`), re-tier/promote/
  remove (`model set`), set reasoning effort per global/tier/model (`model effort`), validate
  (`model check`). Every mutation is schema-validated and written atomically with structured
  error codes — no hand-editing `config/models.json`.

### Fixed
- Negative model costs now rejected (`COST_INVALID`) by the config validator.
- CI time-bombs: two tests used the real clock for UTC day bucketing (budget, secrets-hygiene);
  both now inject a fixed `{now}`.

## [1.9.0] - 2026-08-23

### Added
- **`diff` tool (workspace supervision)**: every delegate/fanOut job now snapshots the git HEAD
  (`gitBase`) before starting; the new `diff` tool returns `git diff --stat` + changed/untracked
  files since that snapshot — see exactly what the agent touched without leaving Claude.
- **fanOut multi-workspace**: tasks may be objects `{task, cwd}` to delegate across DIFFERENT
  repositories in parallel; each task gets its own server connection and job record in its
  workspace state.
- **cwd validation everywhere**: all tools validate `cwd` (absolute, exists, is a directory) with
  structured errors `CWD_INVALID` / `CWD_NOT_ABSOLUTE` / `CWD_NOT_FOUND` / `CWD_NOT_DIRECTORY`.

## [1.8.0] - 2026-08-23

### Added
- **Animated demo** in README (`docs/demo.svg`): real captured run of the delegation runtime,
  regenerated via `npm run demo`.

### Fixed
- **wait no longer treats server-side retries as completion**: a transient provider failure puts
  the session in `state.type:"retry"` (absent from the busy map); the supervisor now keeps
  polling until it actually resumes instead of returning an empty success.

### Added
- **Live progress streaming**: `wait`, `waitAll` and `fanOut` (race mode) emit MCP
  `notifications/progress` frames when the caller supplies `_meta.progressToken`. Frames carry the
  latest assistant output captured from live `message.part.updated` SSE events via a new rolling
  part tracker (`mcp/lib/part-tracker.mjs`). Interval configurable with
  `OPENCODE_PROGRESS_INTERVAL_MS` (default 15000 ms).

## [1.7.1] - 2026-08-23

### Fixed
- **Windows support end-to-end**: MCP server now starts correctly on win32
  (direct-invocation guard compares `fileURLToPath`-resolved paths instead of the
  POSIX-only `pathname`); test runner (`scripts/test-all.mjs`) enumerates test files
  explicitly — Node 20 on Windows does not expand globs and npm always uses cmd.exe;
  all stdio/hook/e2e scripts spawn `process.execPath` instead of bare `node` (ENOENT-prone).
- CI matrix fully green on ubuntu-latest + windows-latest, Node 20 and 22.

## [1.7.0] - 2026-08-23

### Added
- **Server-side `oc-delegate` agent**: every spawned server now receives an injected subagent via
  `OPENCODE_CONFIG_CONTENT` carrying the delegation contract plus hard rules (never push/commit,
  finish only after verification succeeds, `.oc-report.md` mandatory). Delegations run under it
  automatically, with graceful fallback to stock `build` + explicit `agentNote`. Root-cause fix for
  intermittent report-skips.
- **fanOut race mode** (`mode:"race"`): run the same goal across multiple sessions — the first
  clean completion wins, all losers are aborted and marked `race-loser`; response carries the
  winner's response + cost. `/opencode:parallel --race` exposes it.
- **fanOut batch mode is now explicit** (`mode:"batch"` default; invalid values rejected with
  `MODE_INVALID`).
- **needsInput progress**: when `wait` returns a pending permission and assistant text already
  exists, the response includes the latest text tail + todo counts.
- **`retryPolicy.maxAutoRetries`** config (default 2) caps auto-retry escalation chains.
- **`/opencode:cost`**: spend report from job history — total/today, by model/account/day,
  budget limits and remaining allowance.
- **Windows CI**: test matrix now runs ubuntu + windows on Node 20/22.

## [1.6.0] - 2026-08-23

### Added
- **`fanOut` tool (batch parallelism)**: delegate up to 12 tasks with ONE call —
  same resolved model+variant for every task, round-robin account rotation per task,
  a shared `fanOutId` tying all job records together, and ready-made `waitAll`
  guidance in the response. Mid-loop failures keep already-started tasks running
  and are reported (`started` / `failed`) instead of discarding work. Honors the
  same concurrency cap (`DELEGATE_LIMIT_EXCEEDED`) and budget guards as `delegate`.
- **`/opencode:parallel` command**: split arguments by `;;`, fan out, supervise with
  `waitAll`, answer pending permissions, escalate retryable failures, verify
  artifacts, report per-task.

## [1.5.0] - 2026-08-23

### Added
- **`doctor` tool**: environment diagnostics in one call — opencode binary, node version,
  legacy/per-account auth env vars, derived-port health, registry state (stale entries
  auto-cleaned), state-dir writability; structured checks + rendered report.
- **Budget enforcement**: `config.budget` (`maxJobCostUsd`, `maxDailyCostUsd`) — `delegate`
  refuses work that would exceed limits; completed jobs record their real cost (summed from
  assistant messages); `models` returns a live budget summary.
- **Concurrency cap**: `config.concurrency.maxDelegates` guards against runaway fan-outs
  (`DELEGATE_LIMIT_EXCEEDED`).
- **Auto-retry**: `delegate autoRetry:true` — on a retryable failure the task is re-delegated
  once at the escalation-suggested model+variant (`wait` returns `status:"retried"` with the
  new sessionID).
- **SSE instant idle wake**: `wait` no longer rides out the full 5s poll — the permission
  watcher now dispatches all event types and wakes waiters on `session.idle`
  (also fixes `permission.v2.replied` never being consumed live).
- **Cross-platform clean kill**: identity checks moved to `process-identity.mjs` — Windows
  supported via PowerShell CIM command-line lookup; stricter `opencode … serve … --port`
  matcher.
- **Session GC**: `shutdown deleteSessions:true` deletes terminal delegate sessions from
  OpenCode storage (opt-in, never touches running or unknown sessions).
- **Debt fixed**: `/opencode:rescue --model` now reaches the request as a normalized
  `{providerID, modelID}` object (`normalizeModelSpec`); `handleSetup`/`handleCancel` use the
  derived per-workspace port instead of hardcoded 4096.

## [1.4.0] - 2026-08-23

### Added
- **`shutdown` tool (clean teardown)**: stops OpenCode servers the plugin spawned —
  gracefully aborts busy sessions first (resumable via `resumeSessionID`), then SIGTERM→SIGKILL
  on **only** the exact recorded pids. Every spawn is now recorded in a per-workspace registry
  (`$CLAUDE_PLUGIN_DATA/state/<hash>/servers/serve-<port>.json`: pid, port, account); before any
  kill the pid's command line is verified via `ps` to really be an `opencode serve` process, so
  foreign or recycled pids are refused and left untouched. Running delegate jobs of stopped
  servers are marked cancelled (`cancelledBy: "shutdown"`). Scopes: current workspace (default),
  per-account filter, or `all:true` across every workspace.

## [1.3.0] - 2026-08-23

### Added
- **`waitAll` parallel supervision**: wait on up to 12 delegated sessions with one call
  (shared deadline, per-session results, aggregate summary `{total, idle, needsInput,
  timeout, error}`) — fan-out delegations no longer need sequential polling.
- **`status` batch mode**: called without `sessionID`, returns the 20 most recent delegate
  jobs (model, variant, account, tier, retry/resume lineage, error message, timestamps).
- **Cost table in `models`**: USD per Mtok input/output for every classified tier, free models
  marked as `free`.
- **`delegate` title override**: optional `title` argument names the OpenCode session
  explicitly instead of deriving it from the task.

### Changed
- PostToolUse hook now also reacts to `waitAll`; README restructured (architecture diagrams,
  upstream comparison, ownership statement).

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
- `.mcp.json` no longer references `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`.
  The MCP server process and every spawned `opencode serve` inherit the user's shell
  environment, so standard OpenCode auth env vars work without any plugin-side config
  (and unset vars no longer break Claude's strict `${VAR}` validation on install).
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

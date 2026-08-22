# OpenCode plugin for Claude Code

[![tests](https://github.com/naicud/opencode-plugin-cc/actions/workflows/test.yml/badge.svg)](https://github.com/naicud/opencode-plugin-cc/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-18.18%2B-brightgreen)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)
![npm deps](https://img.shields.io/badge/npm%20deps-0-success)

> **Tribute**: This project is inspired by and pays homage to
> [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) by OpenAI.
> The plugin architecture, command structure, and design patterns are derived from
> the original codex-plugin-cc project, adapted to work with
> [OpenCode](https://github.com/anomalyco/opencode) instead of Codex.

Use OpenCode from inside Claude Code for code reviews or to delegate tasks.

This plugin is for Claude Code users who want an easy way to start using OpenCode from the workflow
they already have.

## What You Get

- `/opencode:review` for a normal read-only OpenCode review
- `/opencode:adversarial-review` for a steerable challenge review
- `/opencode:rescue`, `/opencode:status`, `/opencode:result`, and `/opencode:cancel` to delegate work and manage background jobs
- `/opencode:delegate` plus the `mcp__plugin_opencode_oc__*` MCP tools (`models`, `delegate`, `wait`, `status`, `respond`, `abort`) for tiered, budget-aware delegation to OpenCode Zen models

## Requirements

- [Claude Code](https://claude.com/claude-code) (CLI, desktop app, or IDE extension)
- [OpenCode](https://github.com/anomalyco/opencode) installed (`npm i -g opencode-ai` or `brew install opencode`)
- A configured AI provider in OpenCode (Claude, OpenAI, Google, etc.)
- Node.js 18.18 or later

## Install

Inside Claude Code, run:

```
! curl -fsSL https://raw.githubusercontent.com/naicud/opencode-plugin-cc/main/install.sh | bash
```

Then reload the plugin:

```
/reload-plugins
```

You should see:

```
Reloaded: 1 plugin · 4 skills · 2 agents · 3 hooks ...
```

Finally, verify your setup:

```
/opencode:setup
```

> **What the installer does**: Clones the repo to `~/.claude/plugins/marketplaces/`,
> caches the plugin files, and registers it in Claude Code's plugin config.
> It tries SSH first and falls back to HTTPS automatically.

### Set up an AI Provider

If OpenCode is installed but no AI provider is configured, set one up:

```
! opencode providers login
```

To check your configured providers:

```
! opencode providers list
```

### Uninstall

```
/plugin uninstall opencode@naicud-opencode-plugin-cc
/reload-plugins
```

## Command Mapping (codex-plugin-cc -> opencode-plugin-cc)

| codex-plugin-cc | opencode-plugin-cc | Description |
|---|---|---|
| `/codex:review` | `/opencode:review` | Read-only code review |
| `/codex:adversarial-review` | `/opencode:adversarial-review` | Adversarial challenge review |
| `/codex:rescue` | `/opencode:rescue` | Delegate tasks to external agent |
| `/codex:status` | `/opencode:status` | Show running/recent jobs |
| `/codex:result` | `/opencode:result` | Show finished job output |
| `/codex:cancel` | `/opencode:cancel` | Cancel active background job |
| `/codex:setup` | `/opencode:setup` | Check install/auth, toggle review gate |

## Slash Commands

- `/opencode:review` -- Normal OpenCode code review (read-only). Supports `--base <ref>`, `--wait`, `--background`.
- `/opencode:adversarial-review` -- Steerable review that challenges implementation and design decisions. Accepts custom focus text.
- `/opencode:rescue` -- Delegates a task to OpenCode via the `opencode:opencode-rescue` subagent. Supports `--model`, `--agent`, `--resume`, `--fresh`, `--background`.
- `/opencode:status` -- Shows running/recent OpenCode jobs for the current repo.
- `/opencode:result` -- Shows final output for a finished job, including OpenCode session ID for resuming.
- `/opencode:cancel` -- Cancels an active background OpenCode job.
- `/opencode:setup` -- Checks OpenCode install/auth, can enable/disable the review gate hook.
- `/opencode:delegate` -- Delegates a task through the MCP delegation runtime with `--model <id>`, `--tier N` (0–3), `--effort max|high|off`, `--account <name|auto>`. The subagent `opencode-delegate` runs the delegate/wait/verify loop for you.

## Model Delegation (MCP)

The plugin ships an MCP server (`plugins/opencode/mcp/server.mjs`, JSON-RPC over stdio, zero npm deps) exposing six tools, reachable as `mcp__plugin_opencode_oc__models|delegate|wait|status|respond|abort`:

- **models** — merged catalog (file + live `/config/providers`) with tiers, variants, real costs, effort policy and budget hint.
- **delegate** — resolves model+variant client-side (the server accepts any variant string and silently falls back to base — see `docs/opencode-api-findings.md` P2), creates the session, fires `prompt_async` with the work contract from `config/models.json`, records a job visible to `/opencode:status`. Extras: `retryOf` links a re-run to a failed/cancelled job (validated against job history), and `resumeSessionID` continues an existing persisted session (crash recovery / multi-step) instead of creating a new one.
- **wait** — polls every 5s; returns on idle, on pending permission (`needsInput`), or timeout.
- **status** — non-blocking snapshot; failing sub-endpoints become `null`, never errors.
- **respond** — answers a pending permission (`once` / `always` / `reject`). Auto-approve/auto-reject regexes live in `config/models.json`.
- **abort** — kills a runaway session.

Tiers (curated in `plugins/opencode/config/models.json`; everything else enters unclassified after `npm run models:sync`):

| Tier | Model | Use |
|---|---|---|
| 0 | x-preview-f-free (**default**, free) | everyday work |
| 1 | deepseek-v4-flash | fast paid fallback |
| 2 | deepseek-v4-pro | hard refactors, debugging |
| 3 | kimi-k3 | hardest problems only |

Effort is always `max` (strict chains in `variantPreference` — no silent downgrade; if a model lacks the variant the resolver reports `effortApplied: "none"` with a reason instead).

`muse-spark-1.2-contributor-free` is excluded by design (training-data clause).

### Cost note

Reasoning-effort variants (`high`/`max`) bill reasoning tokens as **output** tokens: a tier-3 run at `max` can cost 10× its base price. The `max`-always policy is deliberate (quality over cost); to make effort tier-dependent instead, set `effortPolicy.mode: "perTier"` in `config/models.json`.

### Testing

```bash
npm test            # unit suite (125 tests): catalog merge, resolve, JSON-RPC, permissions/SSE, delegation hook, accounts, job control
npm run test:e2e    # full delegation round-trip against a real opencode server (needs auth)
npm run test:stress # permission ask/deny, concurrency, server kill+restart recovery (needs auth)
npm run test:multiaccount # round-robin rotation across two named credentials, per-account isolation, state persistence (needs auth)
npm run test:escalation  # doomed-credential run proves wait surfaces retryable errors with next-tier escalation (needs auth)
npm run models:sync [-- --live]   # refresh config/models.json from the live catalog
```

### Delegation notifications hook

A PostToolUse hook (`scripts/delegation-context-hook.mjs`) watches `wait`/`status` MCP calls and injects an `additionalContext` note into Claude's context when a delegated task finishes, blocks on a pending permission (`needsInput`), or times out — so the supervisor notices without polling manually.

When a task ends with a retryable assistant error (quota exhausted, rate limit, provider 5xx), `wait` attaches an `escalation` object (`kind`, `suggestModel`, `suggestVariant`) pointing at the next configured tier, and the hook tells Claude exactly how to re-delegate — no guessing, no silent failure.

### Multi-account quota routing

Multiple OpenCode accounts can be pooled to amplify quotas. Accounts are declared in `config/models.json` (names only — never secrets):

```jsonc
"accounts": { "names": ["work", "personal"], "strategy": "round-robin", "default": "work" }
```

Credentials come from the environment, one variable per account: `OPENCODE_DELEGATE_KEY_WORK`, `OPENCODE_DELEGATE_KEY_PERSONAL` (`OPENCODE_DELEGATE_KEY_<ACCOUNT>` uppercased, non-alphanumerics → `_`). At delegate time the plugin spawns one server per account, injecting the key via `OPENCODE_AUTH_CONTENT` (verified against upstream `auth/index.ts`: env content wins over `~/.local/share/opencode/auth.json`), and derives a distinct port per workspace+account so servers coexist.

Routing: `delegate` accepts `account: "auto"` (default) or an explicit name. `"auto"` follows `strategy` — `fixed` pins to `default`; `round-robin` least-recently-used across credentialed accounts (rotation state persisted per workspace). The chosen account is stored in the job record; `wait`/`status`/`respond`/`abort` resolve it automatically from the session ID. With no `accounts` block the legacy single-account path is used untouched.

### Cleanup

Delegate servers persist between calls. To kill them all:

```bash
pkill -f "opencode serve"
```

### Known debt

- `/opencode:rescue --model` is currently ignored (`opencode-companion.mjs` does not forward it).
- `handleSetup`/`handleCancel` still hardcode `127.0.0.1:4096` instead of the derived per-workspace port.

## Review Gate

When enabled via `/opencode:setup --enable-review-gate`, a Stop hook runs a targeted OpenCode review on Claude's response. If issues are found, the stop is blocked so Claude can address them first. Warning: can create long-running loops and drain usage limits.

## Troubleshooting

<details>
<summary><strong>Plugin not loading after install (0 plugins)</strong></summary>

1. Re-run the installer: `! curl -fsSL https://raw.githubusercontent.com/naicud/opencode-plugin-cc/main/install.sh | bash`
2. Run `/reload-plugins` again.
3. If still failing, restart Claude Code.
</details>

<details>
<summary><strong>Install script fails to clone</strong></summary>

The script tries SSH first, then HTTPS. If both fail:

- Check your network connection
- For SSH: ensure `ssh -T git@github.com` works
- For HTTPS: run `gh auth login` to set up credentials
</details>

<details>
<summary><strong>OpenCode commands not working</strong></summary>

1. Verify OpenCode is installed: `! opencode --version`
2. Verify a provider is configured: `! opencode providers list`
3. Run `/opencode:setup` to check the full status.
</details>

## Architecture

Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout, this plugin communicates with
OpenCode via its HTTP REST API + Server-Sent Events (SSE) for streaming. The server is automatically
started and managed by the companion scripts.

```
codex-plugin-cc                          opencode-plugin-cc
+----------------------+                 +------------------------+
| JSON-RPC over stdio  |                 | HTTP REST + SSE        |
| codex app-server     |      vs.        | opencode serve         |
| Broker multiplexing  |                 | Native HTTP (no broker)|
| codex CLI binary     |                 | opencode CLI binary    |
+----------------------+                 +------------------------+
```

## Project Structure

```
opencode-plugin-cc/
├── .claude-plugin/marketplace.json       # Marketplace registration
├── install.sh                            # One-line installer
├── plugins/opencode/
│   ├── .claude-plugin/plugin.json        # Plugin metadata
│   ├── .mcp.json                         # MCP server registration (oc)
│   ├── config/models.json                # Curated model catalog + permissions + contract
│   ├── agents/opencode-rescue.md         # Rescue subagent definition
│   ├── agents/opencode-delegate.md       # Delegation supervisor subagent
│   ├── commands/                         # 8 slash commands
│   │   ├── review.md
│   │   ├── adversarial-review.md
│   │   ├── rescue.md
│   │   ├── delegate.md
│   │   ├── status.md
│   │   ├── result.md
│   │   ├── cancel.md
│   │   └── setup.md
│   ├── hooks/hooks.json                  # Lifecycle hooks
│   ├── mcp/                              # Delegation MCP server (zero deps)
│   │   ├── server.mjs                    # JSON-RPC 2.0 over stdio
│   │   └── lib/
│   │       ├── catalog.mjs               # models.json loader + live merge
│   │       ├── resolve.mjs               # effort/variant resolution
│   │       └── permissions.mjs           # SSE permission watcher
│   ├── prompts/                          # Prompt templates
│   ├── schemas/                          # Output schemas
│   ├── scripts/                          # Node.js runtime
│   │   ├── opencode-companion.mjs        # CLI entry point
│   │   ├── sync-models.mjs               # Catalog sync (CLI parse or --live)
│   │   ├── session-lifecycle-hook.mjs
│   │   ├── stop-review-gate-hook.mjs
│   │   └── lib/                          # Core modules
│   │       ├── opencode-server.mjs       # HTTP API client
│   │       ├── state.mjs                 # Persistent state
│   │       ├── job-control.mjs           # Job management
│   │       ├── tracked-jobs.mjs          # Job lifecycle tracking
│   │       ├── render.mjs               # Output rendering
│   │       ├── prompts.mjs              # Prompt construction
│   │       ├── git.mjs                  # Git utilities
│   │       ├── process.mjs             # Process utilities
│   │       ├── args.mjs                # Argument parsing
│   │       ├── fs.mjs                  # Filesystem utilities
│   │       └── workspace.mjs           # Workspace detection
│   └── skills/                          # Internal skills
├── tests/                               # Test suite
├── LICENSE                              # Apache License 2.0
├── NOTICE                               # Attribution notice
└── README.md
```

## OpenCode Integration

Wraps the OpenCode HTTP server API. Picks up config from:
- User-level: `~/.config/opencode/config.json`
- Project-level: `.opencode/opencode.jsonc`

## License

Copyright 2026 OpenCode Plugin Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

---
description: Guided wizard to list, add, retier, or remove delegation models and set reasoning effort
argument-hint: '[list|add|set|effort|check] [args]'
disable-model-invocation: false
allowed-tools: Bash(node:*), mcp__plugin_opencode_oc__models
---

Guide the user through model configuration. Never edit `config/models.json` by hand — every
mutation goes through the companion so the config stays valid.

## Step 1 — Show the current catalog

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" model list
```

Optionally call the MCP `models` tool for live costs and budget context. Present the rows to the
user: tier, id, variants (reasoning-effort chain), cost, default/excluded flags.

## Step 2 — Interview the user

Ask what they want:

1. **Which model** — an id from the live tail of `model list`, or any OpenCode Zen model id.
2. **What role** → tier mapping:
   - Tier 0 — everyday work, ideally free (this is also the default tier)
   - Tier 1 — fast paid fallback
   - Tier 2 — hard refactors / debugging
   - Tier 3 — hardest problems
3. **Reasoning effort** — this plugin's policy is ALWAYS MAX (`variantPreference` chains are
   strict, no silent downgrade). Warn the user before setting anything below max for a whole
   tier or globally; per-model overrides are possible via `model effort`.

## Step 3 — Apply ONE mutation

```bash
# add a new model to a tier
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" model add <id> --tier <N> \
  [--variants max,high] [--cost-in <USD/Mtok>] [--cost-out <USD/Mtok>] [--default]

# move / re-variant / promote / remove an existing model
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" model set <id> [--tier N] \
  [--variants a,b] [--default] [--remove]

# reasoning effort: global | one tier | one model
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" model effort global --mode max
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" model effort tier 2 --mode high
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" model effort model <id> --mode max
```

If the command exits non-zero it prints `ERROR <code>: reason`. Explain the code to the user and
retry with corrected arguments — do not fall back to hand-editing the file.

## Step 4 — Verify

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" model check && \
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" model list
```

Show the resulting row(s). If costs may be stale, suggest `npm run models:sync -- --live`.

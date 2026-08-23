---
description: Show delegation spend (total, today, by model/account/day) and budget headroom
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the cost command and return output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" cost $ARGUMENTS
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.

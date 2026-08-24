---
description: Live activity log of a delegated OpenCode job (reasoning, output, tool calls)
argument-hint: '[jobId|sessionID] [-n lines] [-f follow]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the log viewer and return output verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/oc-logs.mjs" $ARGUMENTS
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- If stdout contains "following…", tell the user the stream is live and they can
  re-run without `-f` for a static snapshot.

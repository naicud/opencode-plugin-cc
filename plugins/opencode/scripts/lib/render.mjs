// Output rendering for the OpenCode companion.

/**
 * Render a status snapshot as human-readable text.
 * @param {{ running: object[], latestFinished: object|null, recent: object[] }} snapshot
 * @returns {string}
 */
export function renderStatus(snapshot) {
  const lines = [];

  if (snapshot.running.length > 0) {
    lines.push("## Running Jobs\n");
    for (const job of snapshot.running) {
      lines.push(`- **${job.id}** (${job.type}) — ${job.phase ?? "running"} — ${job.elapsed ?? "just started"}`);
      if (job.progressPreview) {
        lines.push(`  > ${job.progressPreview.split("\n").join("\n  > ")}`);
      }
    }
    lines.push("");
  }

  if (snapshot.latestFinished) {
    lines.push("## Latest Finished\n");
    const j = snapshot.latestFinished;
    lines.push(`- **${j.id}** (${j.type}) — ${j.status} — ${j.elapsed}`);
    if (j.errorMessage) {
      lines.push(`  Error: ${j.errorMessage}`);
    }
    lines.push("");
  }

  if (snapshot.recent.length > 1) {
    lines.push("## Recent Jobs\n");
    for (const j of snapshot.recent.slice(1)) {
      lines.push(`- **${j.id}** (${j.type}) — ${j.status} — ${j.elapsed}`);
    }
    lines.push("");
  }

  if (lines.length === 0) {
    lines.push("No OpenCode jobs found for this workspace.");
  }

  return lines.join("\n");
}

/**
 * Render a job result as human-readable text.
 * @param {object} job
 * @param {object} [resultData]
 * @returns {string}
 */
export function renderResult(job, resultData) {
  const lines = [];

  lines.push(`## Job: ${job.id}\n`);
  lines.push(`- **Type**: ${job.type}`);
  lines.push(`- **Status**: ${job.status}`);
  lines.push(`- **Duration**: ${job.elapsed ?? "unknown"}`);

  if (job.opencodeSessionId) {
    lines.push(`- **OpenCode Session**: ${job.opencodeSessionId}`);
  }
  if (job.model) {
    const bits = [job.model];
    if (job.variant) bits.push(`variant=${job.variant}`);
    if (job.account) bits.push(`account=${job.account}`);
    lines.push(`- **Model**: ${bits.join(" · ")}`);
  }
  if (job.retryOf) {
    lines.push(`- **Retry of**: ${job.retryOf}`);
  }

  lines.push("");

  if (job.status === "failed") {
    lines.push(`### Error\n\n${job.errorMessage ?? "Unknown error"}`);
  } else if (resultData) {
    if (resultData.rendered) {
      lines.push(`### Output\n\n${resultData.rendered}`);
    } else if (resultData.messages) {
      // Extract the last assistant message
      const assistantMsgs = resultData.messages.filter((m) => m.role === "assistant");
      const last = assistantMsgs[assistantMsgs.length - 1];
      if (last) {
        const text = extractMessageText(last);
        lines.push(`### Output\n\n${text}`);
      }
    } else if (resultData.summary) {
      lines.push(`### Summary\n\n${resultData.summary}`);
    } else {
      lines.push("### Output\n\n(No output captured)");
    }

    if (resultData.changedFiles?.length > 0) {
      lines.push(`\n### Changed Files\n`);
      for (const f of resultData.changedFiles) {
        lines.push(`- ${f}`);
      }
    }
  } else if (job.result) {
    lines.push(`### Output\n\n${job.result}`);
  }

  return lines.join("\n");
}

/**
 * Render a review result (structured JSON output).
 * @param {object} review
 * @returns {string}
 */
export function renderReview(review) {
  const lines = [];

  if (review.verdict) {
    const emoji = review.verdict === "approve" ? "PASS" : "NEEDS ATTENTION";
    lines.push(`## Review Verdict: ${emoji}\n`);
  }

  if (review.summary) {
    lines.push(`${review.summary}\n`);
  }

  if (review.findings?.length > 0) {
    lines.push(`### Findings (${review.findings.length})\n`);
    for (const f of review.findings) {
      lines.push(`#### ${f.severity?.toUpperCase()}: ${f.title}`);
      lines.push(`- **File**: ${f.file}:${f.line_start}-${f.line_end}`);
      lines.push(`- **Confidence**: ${(f.confidence * 100).toFixed(0)}%`);
      lines.push(`- ${f.body}`);
      lines.push(`- **Recommendation**: ${f.recommendation}`);
      lines.push("");
    }
  } else {
    lines.push("No findings.");
  }

  return lines.join("\n");
}

/**
 * Extract text content from a message object.
 * @param {object} msg
 * @returns {string}
 */
function extractMessageText(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(msg);
}

/**
 * Render setup status.
 * @param {object} status
 * @returns {string}
 */
export function renderSetup(status) {
  const lines = [];
  lines.push("## OpenCode Setup Status\n");

  lines.push(`- **Installed**: ${status.installed ? "Yes" : "No"}`);
  if (status.version) {
    lines.push(`- **Version**: ${status.version}`);
  }
  if (status.serverRunning !== undefined) {
    lines.push(`- **Server Running**: ${status.serverRunning ? "Yes" : "No"}`);
  }
  if (status.providers?.length > 0) {
    lines.push(`- **Configured Providers**: ${status.providers.join(", ")}`);
  } else if (status.installed) {
    lines.push(`- **Providers**: None configured. Run \`!opencode providers\` to set up.`);
  }
  if (status.reviewGate !== undefined) {
    lines.push(`- **Review Gate**: ${status.reviewGate ? "Enabled" : "Disabled"}`);
  }

  return lines.join("\n");
}

/**
 * Render a cost snapshot as human-readable text.
 * @param {{ count: number, total: number, today: number, byDay: Record<string, number>, byModel: Record<string, number>, byAccount: Record<string, number>, limits: {maxJobCostUsd?: number, maxDailyCostUsd?: number}|null }} snapshot
 * @returns {string}
 */
export function renderCost(snapshot) {
  const lines = [];
  const fmt = (n) => `$${Number(n ?? 0).toFixed(6)}`;
  const mapLine = (map) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(" · ");

  lines.push("## Delegation Cost Report\n");
  if (!snapshot.count) {
    lines.push("No completed delegation jobs with recorded cost yet.");
    return lines.join("\n");
  }

  lines.push(`- **Total spend**: ${fmt(snapshot.total)} across ${snapshot.count} completed job(s)`);
  lines.push(`- **Today (UTC)**: ${fmt(snapshot.today)}`);
  if (snapshot.byModel && Object.keys(snapshot.byModel).length > 0) {
    lines.push(`- **By model**: ${mapLine(snapshot.byModel)}`);
  }
  if (snapshot.byAccount && Object.keys(snapshot.byAccount).length > 1) {
    lines.push(`- **By account**: ${mapLine(snapshot.byAccount)}`);
  }

  const limits = snapshot.limits ?? {};
  const limitBits = [];
  limitBits.push(
    limits.maxJobCostUsd != null ? `per-job ${fmt(limits.maxJobCostUsd)}` : "per-job unset"
  );
  limitBits.push(
    limits.maxDailyCostUsd != null ? `daily ${fmt(limits.maxDailyCostUsd)}` : "daily unset"
  );
  lines.push(`- **Budget limits**: ${limitBits.join(", ")}`);
  if (limits.maxDailyCostUsd != null) {
    const remaining = Math.max(0, limits.maxDailyCostUsd - snapshot.today);
    lines.push(`- **Remaining today**: ${fmt(remaining)}`);
  }

  const days = Object.entries(snapshot.byDay ?? {}).sort();
  if (days.length > 0) {
    lines.push("\n### By day (UTC)\n");
    for (const [day, cost] of days.slice(-14)) {
      lines.push(`- ${day}: ${fmt(cost)}`);
    }
  }
  return lines.join("\n");
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Standalone zero-dependency HTML dashboard for the cost snapshot:
 * inline SVG bar charts (spend per UTC day, per model, per account) plus
 * budget-limit gauges. Dark terminal-styled, no external assets.
 * @param {object} snapshot - buildCostSnapshot() output
 * @param {{now?: Date}} [opts]
 * @returns {string} complete HTML document
 */
export function renderCostHtml(snapshot, opts = {}) {
  const fmt6 = (n) => `$${Number(n ?? 0).toFixed(6)}`;
  const fmt2 = (n) => `$${Number(n ?? 0).toFixed(2)}`;

  if (!snapshot.count) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Delegation cost</title></head><body class="empty"><h1>Delegation Cost Report</h1><p>No completed delegation jobs with recorded cost yet.</p></body></html>`;
  }

  const maxOf = (entries) => Math.max(1e-9, ...entries.map(([, v]) => Number(v) || 0));
  const barChart = (entries, { vertical = true, maxRows = 12 } = {}) => {
    const rows = entries.slice(0, maxRows);
    if (rows.length === 0) return "";
    const max = maxOf(rows);
    const W = 60;
    return rows
      .map(([k, v]) => {
        const frac = Math.max(0.01, (Number(v) || 0) / max);
        if (vertical) {
          const h = Math.round(frac * 90);
          return `<div class="row"><span class="lbl">${esc(k)}</span><svg width="${W}" height="100" role="img" aria-label="${esc(k)} ${fmt6(v)}"><rect y="${100 - h}" width="${W}" height="${h}" rx="3"/></svg><span class="val">${fmt6(v)}</span></div>`;
        }
        return `<div class="hrow"><span class="lbl">${esc(k)}</span><span class="track"><span class="fill" style="width:${Math.round(frac * 100)}%"></span></span><span class="val">${fmt6(v)}</span></div>`;
      })
      .join("\n");
  };

  const dayEntries = Object.entries(snapshot.byDay ?? {}).sort().slice(-14);
  const modelEntries = Object.entries(snapshot.byModel ?? {}).sort((a, b) => b[1] - a[1]);
  const accountEntries = Object.entries(snapshot.byAccount ?? {}).sort((a, b) => b[1] - a[1]);

  const limits = snapshot.limits ?? {};
  const dailyLimit = limits.maxDailyCostUsd != null ? Number(limits.maxDailyCostUsd) : null;
  const jobLimit = limits.maxJobCostUsd != null ? Number(limits.maxJobCostUsd) : null;
  const remaining = dailyLimit != null ? Math.max(0, dailyLimit - (Number(snapshot.today) || 0)) : null;
  const todayFrac = dailyLimit != null ? Math.min(1, (Number(snapshot.today) || 0) / dailyLimit) : 0;
  const generatedAt = (opts.now ?? new Date()).toISOString();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode delegation cost — ${esc(fmt2(Number(snapshot.total) || 0))} total</title>
<style>
:root{--bg:#0f1117;--panel:#171a23;--fg:#e6e6eb;--dim:#8b8fa3;--acc:#50fa7b;--warn:#ffb86c;--bar:#bd93f9}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:32px;max-width:960px;margin:auto}
h1{font-size:20px;font-weight:600;letter-spacing:.5px}
h2{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin:28px 0 12px}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin-top:18px}
.card{background:var(--panel);border:1px solid #262b38;border-radius:10px;padding:14px 18px;min-width:150px}
.card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:1px}
.card .v{font-size:22px;margin-top:4px;color:var(--acc)}
.gauge{background:var(--panel);border:1px solid #262b38;border-radius:10px;padding:14px 18px;margin-top:14px}
.track{display:inline-block;width:260px;height:10px;background:#262b38;border-radius:5px;overflow:hidden;vertical-align:middle}
.fill{display:block;height:100%;background:linear-gradient(90deg,var(--acc),var(--bar))}
.row,.hrow{margin:8px 0}
.row{display:inline-block;text-align:center;margin-right:14px;vertical-align:bottom}
.row svg rect{fill:var(--bar)}
.hrow .track{width:220px;margin-left:10px;margin-right:10px}
.lbl{color:var(--dim);font-size:13px}
.val{font-size:13px}
footer{margin-top:36px;color:var(--dim);font-size:12px}
</style>
</head>
<body>
<h1>&gt;_ Delegation Cost Report</h1>
<div class="cards">
  <div class="card"><div class="k">Total spend</div><div class="v">${esc(fmt2(Number(snapshot.total) || 0))}</div></div>
  <div class="card"><div class="k">Completed jobs</div><div class="v">${Number(snapshot.count) || 0}</div></div>
  <div class="card"><div class="k">Today (UTC)</div><div class="v">${esc(fmt2(Number(snapshot.today) || 0))}</div></div>
</div>
<div class="gauge"><span class="lbl">Daily budget:</span> ${
    dailyLimit != null
      ? `<span class="track"><span class="fill" style="width:${Math.round(todayFrac * 100)}%"></span></span> <span class="val">${esc(fmt2(Number(snapshot.today) || 0))} / ${esc(fmt2(dailyLimit))}</span>${remaining != null ? ` · remaining ${esc(fmt2(remaining))}` : ""}`
      : `<span class="val">unset</span>`
  }</div>
<div class="gauge"><span class="lbl">Per-job limit:</span> <span class="val">${jobLimit != null ? esc(fmt2(jobLimit)) : "unset"}</span></div>

<h2>Spend by day (UTC, last 14)</h2>
${dayEntries.length ? barChart(dayEntries) : `<p class="lbl">No spend recorded yet.</p>`}

<h2>By model</h2>
${modelEntries.length ? barChart(modelEntries, { vertical: false }) : `<p class="lbl">No model costs recorded.</p>`}

${accountEntries.length > 1 ? `<h2>By account</h2>\n${barChart(accountEntries, { vertical: false })}` : ""}

<footer>Generated ${esc(generatedAt)} · opencode-plugin-cc companion · data source: local state.json (completed delegate jobs)</footer>
</body>
</html>`;
}

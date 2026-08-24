import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "mcp", "server.mjs");

const TASK_TEXT =
  "Create a file bench-result.txt containing exactly the line BENCH-OK and nothing else, then write .oc-report.md with STATUS COMPLETED and the Files section listing bench-result.txt";

const WAIT_TOTAL_BUDGET_MS = 600_000;

function parseArgs(argv) {
  const args = { tasks: 3, timeoutSec: 180, cwd: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tasks") args.tasks = Number(argv[++i]);
    else if (a === "--timeout-sec") args.timeoutSec = Number(argv[++i]);
    else if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--keep") args.keep = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: node plugins/opencode/scripts/benchmark-tiers.mjs [--tasks N] [--timeout-sec S] [--cwd DIR] [--keep]",
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.tasks) || args.tasks < 1) args.tasks = 3;
  if (!Number.isFinite(args.timeoutSec) || args.timeoutSec < 1) args.timeoutSec = 180;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let cwd = args.cwd;
  let ownsCwd = false;
  if (!cwd) {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bench-"));
    ownsCwd = true;
  }
  console.log(`workspace: ${cwd}${ownsCwd ? " (temporary)" : ""}`);

  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let nextId = 1;
  const pending = new Map();
  let stderrTail = "";

  let buffer = "";
  proc.stdout.on("data", (d) => {
    buffer += d.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) {
          continue;
        }
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // ignore malformed line
      }
    }
  });
  proc.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-800);
  });

  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`timeout on ${method}; stderr=${stderrTail.slice(-400)}`)),
        240_000,
      );
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function parseResult(res) {
    if (!res.result || res.result.isError) {
      throw new Error(`tool error: ${res.result?.content?.[0]?.text ?? JSON.stringify(res)}`);
    }
    return JSON.parse(res.result.content[0].text);
  }

  const rows = [];
  let hardFail = false;

  try {
    /* 1. Handshake */
    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bench-driver", version: "1.0.0" },
    });
    if (!init.result?.serverInfo) throw new Error("initialize returned no serverInfo");
    console.log(`handshake ok: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
    notify("notifications/initialized", {});

    /* 2. Merged catalog -> one curated model per tier (config-excluded models are skipped) */
    const catalog = parseResult(await rpc("tools/call", { name: "models", arguments: { cwd } }));
    const excludedIds = new Set((catalog.excluded ?? []).map((e) => e?.id).filter(Boolean));
    const perTier = new Map();
    for (const m of catalog.models ?? []) {
      if (!m || m.tier == null) continue;
      if (!perTier.has(m.tier)) perTier.set(m.tier, []);
      perTier.get(m.tier).push(m);
    }
    const selected = [...perTier.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([tier, entries]) => {
        const ranked = entries.slice().sort((x, y) => String(x.id).localeCompare(String(y.id)));
        const chosen =
          ranked.find((e) => e.default && !excludedIds.has(e.id)) ??
          ranked.find((e) => !excludedIds.has(e.id)) ??
          ranked.find((e) => e.default) ??
          ranked[0];
        return { tier, id: chosen.id, variants: chosen.variants ?? [], excluded: excludedIds.has(chosen.id) };
      })
      .slice(0, args.tasks);
    if (selected.length === 0) throw new Error("no tiered models found in merged catalog");
    console.log(
      `tiers: ${selected.map((s) => `t${s.tier}=${s.id}${s.excluded ? " (excluded)" : ""}`).join(", ")} (catalog has ${(catalog.models ?? []).length} entries)`,
    );

    /* 3+4+5. Sequential delegate/wait/verify per tier (quota-friendly) */
    for (const sel of selected) {
      const startedAt = Date.now();
      let variant = "-";
      let outcome = null;

      if (sel.excluded) {
        rows.push({
          tier: sel.tier,
          model: sel.id,
          variant: "-",
          wallS: 0,
          cost: null,
          verdict: "excluded",
        });
        continue;
      }

      try {
        const del = parseResult(
          await rpc("tools/call", {
            name: "delegate",
            arguments: {
              cwd,
              task: TASK_TEXT,
              model: sel.id,
              effort: "max",
              title: `Bench ${sel.id}`,
            },
          }),
        );
        variant = del.variant ?? "-";
        console.log(`delegate ok: t${sel.tier} ${sel.id} variant=${variant} session=${del.sessionID}`);

        const deadline = startedAt + WAIT_TOTAL_BUDGET_MS;
        for (;;) {
          outcome = parseResult(
            await rpc("tools/call", {
              name: "wait",
              arguments: { sessionID: del.sessionID, cwd, timeoutSec: args.timeoutSec },
            }),
          );
          console.log(`wait: t${sel.tier} ${sel.id} status=${outcome.status}`);
          if (outcome.status !== "timeout") break;
          if (Date.now() >= deadline) break;
        }
      } catch (err) {
        console.error(`${sel.id}: run error — ${err.message}`);
        rows.push({
          tier: sel.tier,
          model: sel.id,
          variant,
          wallS: (Date.now() - startedAt) / 1000,
          cost: null,
          verdict: "failed",
        });
        continue;
      }

      let verdict = "timeout";
      if (outcome && outcome.status === "idle") verdict = "ok";
      else if (outcome && outcome.status === "needsInput") verdict = "blocked";
      else if (outcome && (outcome.status === "error" || outcome.error)) verdict = "failed";

      const wallS = (Date.now() - startedAt) / 1000;
      const cost = outcome && typeof outcome.cost === "number" ? outcome.cost : null;

      let artifactOk = false;
      const proofPath = path.join(cwd, "bench-result.txt");
      if (fs.existsSync(proofPath)) {
        const content = fs.readFileSync(proofPath, "utf8");
        artifactOk = content === "BENCH-OK\n" || content === "BENCH-OK";
      }
      let reportNote = ".oc-report.md missing";
      const reportPath = path.join(cwd, ".oc-report.md");
      if (fs.existsSync(reportPath)) {
        const reportText = fs.readFileSync(reportPath, "utf8");
        reportNote = /STATUS[^\n]*COMPLETED/i.test(reportText)
          ? "report STATUS COMPLETED"
          : "report present (no COMPLETED marker)";
      }
      if (artifactOk && verdict === "ok") reportNote += ", artifact byte-exact BENCH-OK";
      else if (artifactOk) reportNote += `, artifact byte-exact BENCH-OK (status=${outcome?.status})`;
      else reportNote += ", artifact MISSING/WRONG";

      rows.push({ tier: sel.tier, model: sel.id, variant, wallS, cost, verdict });
      console.log(
        `${sel.id}: ${verdict} · wall=${wallS.toFixed(1)}s · cost=${cost == null ? "n/a" : `$${cost.toFixed(6)}`} · ${reportNote}`,
      );
    }

    /* 6. Markdown report */
    console.log("\n| tier | model | variant applied | wall s | cost USD | verdict |");
    console.log("|---|---|---|---|---|---|");
    for (const r of rows) {
      console.log(
        `| ${r.tier} | ${r.model} | ${r.variant} | ${r.wallS.toFixed(1)} | ${r.cost == null ? "n/a" : r.cost.toFixed(6)} | ${r.verdict} |`,
      );
    }
    const okCount = rows.filter((r) => r.verdict === "ok").length;
    const wallSum = rows.reduce((acc, r) => acc + r.wallS, 0);
    const costSum = rows.reduce((acc, r) => acc + (r.cost ?? 0), 0);
    const byVerdict = rows.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc), {});
    console.log(
      `\ntotals: ${okCount}/${rows.length} ok · wall Σ=${wallSum.toFixed(1)}s · cost Σ=$${costSum.toFixed(6)} · ` +
        Object.entries(byVerdict)
          .map(([k, v]) => `${k}=${v}`)
          .join(" "),
    );

    /* 7. Clean shutdown of plugin-spawned opencode servers */
    try {
      const sd = parseResult(await rpc("tools/call", { name: "shutdown", arguments: { cwd } }));
      console.log(`shutdown ok: stopped=${(sd.stopped ?? []).map((s) => s.port).join(",") || "none"}`);
    } catch (err) {
      console.error(`shutdown warning: ${err.message}`);
    }
  } catch (err) {
    hardFail = true;
    console.error(`BENCH FAIL: ${err.message}`);
  } finally {
    proc.kill();
    if (ownsCwd) {
      if (args.keep) console.log(`tmp workspace kept (--keep): ${cwd}`);
      else {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  if (hardFail) process.exitCode = 1;
}

main();

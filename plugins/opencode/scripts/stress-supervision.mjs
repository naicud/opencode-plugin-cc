// Live stress suite for the supervision features of the delegation MCP server.
// Spawns mcp/server.mjs over stdio exactly like Claude Code does and drives
// three adversarial scenarios against REAL opencode servers (spawned on
// demand by the MCP server):
//
//   S1  two concurrent reviewer personas in parallel workspaces, permission
//       pumping via respond + autoRetry chain following
//   S2  waitAll waitFor early-exit under 4-way concurrency, then straggler
//       settling and byte-exact artifact verification
//   S3  honest-failure chain with autoRetry disabled: the driver must survive
//     a degraded upstream session (EmptyOutput etc.) without hanging
//
// Usage: node scripts/stress-supervision.mjs
//        (requires `opencode` installed + authenticated)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "mcp", "server.mjs");

const HOP_BUDGET_MS = 240_000; // global budget per followed session
const SCENARIO_BUDGET_MS = 300_000; // hard hang guard per scenario
const MAX_HOPS = 8;
const TERMINAL_STATUSES = new Set(["idle", "needsInput", "error"]);

const REVIEWER_TASK =
  "Rivedi i file di questo workspace e scrivi i tuoi risultati SOLO nel file .oc-report.md con una riga STATUS (non creare né modificare NESSUN altro file).";

class StressError extends Error {}

let nextId = 1;
const pending = new Map();
const progressFrames = [];

async function main() {
  const primary = fs.mkdtempSync(path.join(os.tmpdir(), "oc-stress-"));
  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_PROGRESS_INTERVAL_MS: "2500" },
  });

  let buffer = "";
  let stderr = "";
  proc.stdout.on("data", (d) => {
    buffer += d.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === "notifications/progress") {
          progressFrames.push(msg);
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
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      if (method.startsWith("notifications/")) {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
        resolve(null); // notifications never get a response
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}; stderr=${stderr.slice(-400)}`)), 240_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  function parseResult(res) {
    if (!res.result || res.result.isError) {
      throw new Error(`tool error: ${res.result?.content?.[0]?.text ?? JSON.stringify(res)}`);
    }
    return JSON.parse(res.result.content[0].text);
  }

  // Shared supervision loop: follow one session through retried chains and
  // permission requests until a terminal state, the hop cap, or the budget.
  async function settleUntilTerminal({ sessionID, cwd, label, budgetMs = HOP_BUDGET_MS, maxHops = MAX_HOPS }) {
    const t0 = Date.now();
    let active = sessionID;
    let answered = 0;
    let last = null;
    for (let hop = 0; hop < maxHops; hop++) {
      if (Date.now() - t0 >= budgetMs) break;
      last = parseResult(
        await rpc("tools/call", {
          name: "wait",
          arguments: { sessionID: active, cwd, timeoutSec: 150 },
        })
      );
      console.log(`${label} wait: ${last.status}`);
      if (last.status === "retried") {
        console.log(`${label} auto-retry -> ${String(last.newSessionID ?? "?").slice(0, 12)}… (${String(last.reason ?? "").slice(0, 60)})`);
        active = last.newSessionID ?? active;
        continue;
      }
      if (last.status === "needsInput") {
        for (const perm of last.permissions ?? []) {
          await rpc("tools/call", {
            name: "respond",
            arguments: { sessionID: active, cwd, permissionID: perm.id, response: "once" },
          });
          answered++;
        }
        continue;
      }
      if (last.status === "idle") break;
      // timeout/error: give another round-robin pass until hop/budget cap
    }
    return { active, answered, last, budgetExhausted: Date.now() - t0 >= budgetMs };
  }

  const score = { passed: 0 };
  async function scenario(name, fn) {
    try {
      await fn();
      console.log(`${name} PASS`);
      score.passed++;
    } catch (err) {
      console.error(`${name} FAIL: ${err.message}`);
      process.exitCode = 1;
    }
  }

  try {
    /* 1. Handshake */
    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "stress-driver", version: "1.0.0" },
    });
    if (!init.result?.serverInfo) throw new StressError("initialize returned no serverInfo");
    console.log(`handshake ok: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);

    await rpc("notifications/initialized", {});

    const list = await rpc("tools/list", {});
    const names = (list.result?.tools ?? []).map((t) => t.name).sort();
    if (
      JSON.stringify(names) !==
      JSON.stringify(["abort", "delegate", "diff", "doctor", "fanOut", "logs", "models", "respond", "shutdown", "status", "wait", "waitAll"])
    ) {
      throw new StressError(`tools/list mismatch: ${names}`);
    }
    console.log("tools/list ok:", names.join(", "));

    /* S1. Two concurrent reviewer personas, each followed independently */
    await scenario("S1", async () => {
      const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), "oc-stress-")), fs.mkdtempSync(path.join(os.tmpdir(), "oc-stress-"))];
      const branch = async (label, dir) => {
        try {
          const del = parseResult(
            await rpc("tools/call", {
              name: "delegate",
              arguments: { cwd: dir, task: REVIEWER_TASK, persona: "reviewer", autoRetry: true, title: `Stress ${label}` },
            })
          );
          if (!del.sessionID) throw new StressError("delegate missing sessionID");
          console.log(`s1 ${label} delegated: ${String(del.sessionID).slice(0, 12)}… persona=${del.persona}`);
          const settled = await settleUntilTerminal({ sessionID: del.sessionID, cwd: dir, label: `s1 ${label}` });
          const report = path.join(dir, ".oc-report.md");
          if (!fs.existsSync(report)) {
            throw new StressError(`.oc-report.md missing (final=${settled.last?.status}, answeredPermissions=${settled.answered})`);
          }
          return { label, ok: true, detail: `report present, final=${settled.last?.status}, answeredPermissions=${settled.answered}` };
        } catch (err) {
          return { label, ok: false, detail: err.message };
        }
      };
      const outcomes = await Promise.all([branch("reviewer-1", dirs[0]), branch("reviewer-2", dirs[1])]);
      for (const o of outcomes) console.log(`s1 ${o.label} ${o.ok ? "PASS" : "FAIL"}: ${o.detail}`);
      if (outcomes.some((o) => !o.ok)) throw new StressError("at least one reviewer branch failed");
    });

    /* S2. waitAll waitFor early exit under 4-way concurrency */
    await scenario("S2", async () => {
      const specs = [
        ["a", "STRESS-A-OK"],
        ["b", "STRESS-B-OK"],
        ["c", "STRESS-C-OK"],
        ["d", "STRESS-D-OK"],
      ];
      const dels = await Promise.all(
        specs.map(([k]) =>
          rpc("tools/call", {
            name: "delegate",
            arguments: {
              cwd: primary,
              task: `Crea il file stress-${k}.txt con contenuto ESATTAMENTE: STRESS-${k.toUpperCase()}-OK. Aggiorna .oc-report.md come da contratto.`,
              autoRetry: true,
              title: `Stress builder-${k}`,
            },
          }).then(parseResult)
        )
      );
      const sessionIDs = dels.map((d) => d.sessionID);
      if (sessionIDs.some((s) => !s)) throw new StressError("a builder delegate missed sessionID");
      console.log(`s2 delegated ok: ${sessionIDs.length} builders`);

      const wres = parseResult(
        await rpc("tools/call", {
          name: "waitAll",
          arguments: { sessionIDs, cwd: primary, timeoutSec: 300, waitFor: 2 },
        })
      );
      if (wres.waitFor !== 2 || wres.partial !== true) {
        throw new StressError(`waitFor echo wrong: ${JSON.stringify({ waitFor: wres.waitFor, partial: wres.partial })}`);
      }
      const byId = new Map((wres.results ?? []).map((r) => [r.sessionID, r]));
      const terminalIDs = sessionIDs.filter((id) => TERMINAL_STATUSES.has(byId.get(id)?.status));
      if (terminalIDs.length < 2) {
        throw new StressError(`early exit delivered ${terminalIDs.length}/4 terminal: ${JSON.stringify(wres.results ?? []).slice(0, 400)}`);
      }
      console.log(`s2 waitAll ok: waitFor=2 partial=true terminal=${terminalIDs.length}/4`);

      for (const id of sessionIDs.filter((sid) => !TERMINAL_STATUSES.has(byId.get(sid)?.status))) {
        const settled = await settleUntilTerminal({ sessionID: id, cwd: primary, label: `s2 straggler ${String(id).slice(0, 8)}…` });
        console.log(`s2 straggler ${String(id).slice(0, 8)}… settled: final=${settled.last?.status}`);
      }

      for (const [k, want] of specs) {
        const p = path.join(primary, `stress-${k}.txt`);
        if (!fs.existsSync(p)) throw new StressError(`artifact stress-${k}.txt missing`);
        const got = fs.readFileSync(p, "utf8").trim();
        if (got !== want) throw new StressError(`stress-${k}.txt wrong: ${got}`);
      }
      console.log("s2 artifacts ok: stress-a..d byte-exact");
    });

    /* S3. EmptyOutput honest-failure chain: survive a degraded session */
    await scenario("S3", async () => {
      const t0 = Date.now();
      const del = parseResult(
        await rpc("tools/call", {
          name: "delegate",
          arguments: {
            cwd: primary,
            task: "Crea il file stress-e.txt con contenuto ESATTAMENTE: STRESS-E-OK.",
            persona: "builder",
            autoRetry: false,
            title: "Stress degraded",
          },
        })
      );
      if (!del.sessionID) throw new StressError("delegate missing sessionID");

      const settled = await settleUntilTerminal({
        sessionID: del.sessionID,
        cwd: primary,
        label: "s3 chain",
        budgetMs: 260_000,
      });
      console.log(
        `s3 chain ok: flow terminated (final=${settled.last?.status}) in ${Math.round((Date.now() - t0) / 1000)}s without hanging`
      );

      let st;
      try {
        st = parseResult(await rpc("tools/call", { name: "status", arguments: { sessionID: settled.active, cwd: primary } }));
      } catch (err) {
        throw new StressError(`status threw on degraded session: ${err.message}`);
      }
      if (!st || typeof st !== "object" || Array.isArray(st)) {
        throw new StressError(`status not a parseable object: ${JSON.stringify(st)?.slice(0, 160)}`);
      }
      console.log(`s3 status ok: state=${JSON.stringify(st.state ?? null)}`);

      const elapsed = Date.now() - t0;
      if (elapsed > SCENARIO_BUDGET_MS) {
        throw new StressError(`scenario hung past ${SCENARIO_BUDGET_MS / 1000}s budget (${Math.round(elapsed / 1000)}s)`);
      }
    });

    /* clean shutdown: kill the plugin-spawned server(s) */
  } catch (err) {
    console.error(`STRESS FAIL: ${err.message}`);
    process.exitCode = 1;
  } finally {
    try {
      const sd = parseResult(await rpc("tools/call", { name: "shutdown", arguments: { cwd: primary } }));
      console.log(`shutdown ok: stopped=${(sd.stopped ?? []).map((s) => s.port).join(",")} jobsCancelled=${sd.jobsCancelled}`);
    } catch (err) {
      console.error(`shutdown warn: ${err.message}`);
    }
    proc.kill();
  }

  console.log(`STRESS-SUPERVISION: ${score.passed}/3 scenarios passed`);
}

main();

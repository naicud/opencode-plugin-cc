// End-to-end test driver for the delegation MCP server.
// Spawns mcp/server.mjs over stdio exactly like Claude Code does
// (.mcp.json: command node, args server.mjs) and drives the full protocol:
//
//   initialize -> tools/list -> models -> delegate -> wait* -> status
//   -> delegate(long task) -> abort
//
// Verifies:
//   - JSON-RPC handshake and the six tools
//   - default tier 0 model is x-preview-f-free with variant "max" applied
//   - delegated task really edits the workspace + writes .oc-report.md
//   - wait surfaces the assistant response, cost, tokens
//   - abort terminates a running session
//
// Usage: npm run test:e2e   (requires `opencode` installed + authenticated)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "mcp", "server.mjs");

let nextId = 1;
const pending = new Map();

function fail(msg) {
  console.error(`E2E FAIL: ${msg}`);
  process.exitCode = 1;
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-e2e-"));
  const proc = spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
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
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}; stderr=${stderr.slice(-400)}`)), 120_000);
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

  try {
    /* 1. Handshake */
    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-driver", version: "1.0.0" },
    });
    if (!init.result?.serverInfo) return fail("initialize returned no serverInfo");
    console.log(`handshake ok: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);

    await rpc("notifications/initialized", {});

    /* 2. tools/list */
    const list = await rpc("tools/list", {});
    const names = (list.result?.tools ?? []).map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(["abort", "delegate", "doctor", "models", "respond", "shutdown", "status", "wait", "waitAll"])) {
      return fail(`tools/list mismatch: ${names}`);
    }
    console.log("tools/list ok:", names.join(", "));

    /* 3. models — expect curated tiers */
    const models = parseResult(await rpc("tools/call", { name: "models", arguments: { cwd } }));
    const byId = Object.fromEntries(models.models.map((m) => [m.id, m]));
    for (const id of ["x-preview-f-free", "deepseek-v4-flash", "deepseek-v4-pro", "kimi-k3"]) {
      if (!byId[id]) return fail(`curated model missing from merged catalog: ${id}`);
    }
    if (!byId["x-preview-f-free"]?.default) return fail("x-preview-f-free should be the default model");
    if (byId["muse-spark-1.2-contributor-free"]) return fail("excluded model leaked into catalog");
    console.log(`models ok: ${models.models.length} entries, default=${models.defaults.tier}, live=${models.live}`);

    /* 4. delegate a real task at max effort */
    const del = parseResult(await rpc("tools/call", {
      name: "delegate",
      arguments: {
        task: "Crea il file e2e-proof.txt con contenuto ESATTAMENTE: E2E-MAX-EFFORT-OK. Poi scrivi .oc-report.md come da contratto.",
        cwd,
        effort: "max",
      },
    }));
    if (del.modelRef !== "opencode/x-preview-f-free") return fail(`unexpected model ${del.modelRef}`);
    if (del.variant !== "max") return fail(`effort not applied as max: ${JSON.stringify(del)}`);
    if (!del.sessionID || !del.jobId) return fail("delegate missing sessionID/jobId");
    console.log(`delegate ok: ${del.modelRef} variant=${del.variant} job=${del.jobId}`);

    /* 5. wait to completion */
    let outcome;
    for (;;) {
      outcome = parseResult(await rpc("tools/call", {
        name: "wait",
        arguments: { sessionID: del.sessionID, cwd, timeoutSec: 150 },
      }));
      console.log(`wait: ${outcome.status}`);
      if (outcome.status !== "timeout") break;
    }
    if (outcome.status === "needsInput") {
      return fail(`unexpected permission request: ${JSON.stringify(outcome.permissions)}`);
    }
    if (outcome.status !== "idle") return fail(`wait ended ${outcome.status}`);
    if (outcome.error) return fail(`assistant error: ${JSON.stringify(outcome.error)}`);
    const proof = path.join(cwd, "e2e-proof.txt");
    if (!fs.existsSync(proof)) return fail("task artifact e2e-proof.txt not created");
    if (fs.readFileSync(proof, "utf8").trim() !== "E2E-MAX-EFFORT-OK") {
      return fail(`artifact content wrong: ${fs.readFileSync(proof, "utf8")}`);
    }
    if (!fs.existsSync(path.join(cwd, ".oc-report.md"))) return fail(".oc-report.md contract not honored");
    if (!/COMPLETED|PARTIAL/.test(outcome.response)) {
      return fail(`response lacks STATUS verdict: ${outcome.response.slice(0, 200)}`);
    }
    console.log(`task verified: artifact + .oc-report.md present; cost=${outcome.cost}`);

    /* 6. status snapshot */
    const st = parseResult(await rpc("tools/call", {
      name: "status",
      arguments: { sessionID: del.sessionID, cwd },
    }));
    if (!st.lastMessage || st.lastMessage.role !== "assistant") return fail("status lastMessage wrong");
    console.log("status ok: state=" + JSON.stringify(st.state));

    /* 7. delegate long-running task then abort */
    const slow = parseResult(await rpc("tools/call", {
      name: "delegate",
      arguments: {
        task: "Conta lentamente da 1 a 200000 scrivendo ogni numero in count.txt (un numero per riga), poi verifica la righe finali.",
        cwd,
        effort: "max",
      },
    }));
    await new Promise((r) => setTimeout(r, 3000)); // let it start
    const ab = parseResult(await rpc("tools/call", {
      name: "abort",
      arguments: { sessionID: slow.sessionID, cwd },
    }));
    if (!ab.aborted) return fail("abort returned false");
    const afterAbort = parseResult(await rpc("tools/call", {
      name: "wait",
      arguments: { sessionID: slow.sessionID, cwd, timeoutSec: 20 },
    }));
    if (afterAbort.status === "needsInput") return fail("aborted session still asking for input");
    console.log(`abort ok: aborted=true, post-abort wait=${afterAbort.status}`);

    /* 8. resume the aborted session via delegate.resumeSessionID */
    const resumed = parseResult(await rpc("tools/call", {
      name: "delegate",
      arguments: {
        task: "Il task precedente è stato interrotto. Crea ora il file resume-proof.txt con contenuto ESATTAMENTE: RESUME-OK e aggiorna .oc-report.md.",
        cwd,
        effort: "max",
        resumeSessionID: slow.sessionID,
      },
    }));
    if (resumed.sessionID !== slow.sessionID) return fail(`resume changed session id: ${resumed.sessionID}`);
    if (resumed.resumedFrom !== slow.sessionID) return fail("resume response missing resumedFrom tie-back");
    let resOutcome;
    for (;;) {
      resOutcome = parseResult(await rpc("tools/call", {
        name: "wait",
        arguments: { sessionID: resumed.sessionID, cwd, timeoutSec: 150 },
      }));
      if (resOutcome.status !== "timeout") break;
    }
    if (resOutcome.status === "needsInput") return fail("resumed run hit needsInput");
    if (resOutcome.status !== "idle") return fail(`resume wait ended ${resOutcome.status}`);
    const resumeProof = path.join(cwd, "resume-proof.txt");
    if (!fs.existsSync(resumeProof)) return fail("resume artifact resume-proof.txt not created");
    if (fs.readFileSync(resumeProof, "utf8").trim() !== "RESUME-OK") return fail("resume artifact content wrong");
    console.log("resume ok: continued session produced resume-proof.txt (RESUME-OK)");

    /* 8b. doctor diagnostics */
    const doc = parseResult(await rpc("tools/call", { name: "doctor", arguments: { cwd } }));
    if (typeof doc.ok !== "boolean" || !Array.isArray(doc.checks) || doc.checks.length === 0) {
      return fail(`doctor report malformed: ${JSON.stringify(doc).slice(0, 200)}`);
    }
    console.log(`doctor ok=${doc.ok}: ${doc.checks.length} checks`);

    /* 9. clean shutdown: kill the plugin-spawned server, verify port freed */
    const sd = parseResult(await rpc("tools/call", {
      name: "shutdown",
      arguments: { cwd },
    }));
    if (!Array.isArray(sd.stopped) || sd.stopped.length < 1) {
      return fail(`shutdown stopped nothing: ${JSON.stringify(sd)}`);
    }
    for (const entry of sd.stopped) {
      if (typeof entry.pid !== "number" || typeof entry.port !== "number") {
        return fail(`shutdown entry malformed: ${JSON.stringify(entry)}`);
      }
    }
    console.log(`shutdown ok: stopped=${sd.stopped.map((s) => s.port).join(",")} jobsCancelled=${sd.jobsCancelled}`);
    // every stopped port must now be unreachable
    await new Promise((r) => setTimeout(r, 500));
    for (const entry of sd.stopped) {
      let reachable = false;
      try {
        const res = await fetch(`http://127.0.0.1:${entry.port}/global/health`, {
          signal: AbortSignal.timeout(2000),
        });
        reachable = res.ok;
      } catch {
        reachable = false;
      }
      if (reachable) return fail(`port ${entry.port} still serving after shutdown`);
    }
    console.log("port check ok: all stopped ports are free");

    console.log("\nE2E PASS: full stdio flow verified (handshake, catalog, max-effort delegation, artifacts, report contract, abort, resume, clean shutdown).");
  } catch (err) {
    fail(err.message);
  } finally {
    proc.kill();
  }
}

main();

// Multi-account E2E stress: two named credentials (same real key under two
// account names) driven through round-robin rotation over the real MCP stdio
// server. Verifies:
//   - models reports configured accounts with env-var names
//   - delegate auto-picks accA then rotates to accB (LRU round-robin)
//   - both accounts spawn independent servers and complete real tasks
//   - explicit account request honored; unknown account rejected
//   - state.json persists job.account + accountLastUsed LRU
//
// Usage: node scripts/stress-multiaccount.mjs  (requires `opencode` authenticated)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "mcp", "server.mjs");
const PLUGIN_ROOT = path.join(__dirname, "..");

let nextId = 1;
const pending = new Map();

function fail(msg) {
  console.error(`MA-STRESS FAIL: ${msg}`);
  process.exitCode = 1;
}

async function main() {
  const authFile = path.join(process.env.HOME, ".local/share/opencode/auth.json");
  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  const key = auth?.opencode?.key ?? auth?.opencode?.access;
  if (!key) return fail("no opencode credential in auth.json — cannot run multi-account stress");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ma-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ma-state-"));

  const config = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "config", "models.json"), "utf8"));
  config.accounts = { names: ["accA", "accB"], strategy: "round-robin", default: "accA" };
  const configPath = path.join(workspace, "models.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  const proc = spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OC_MODELS_CONFIG: configPath,
      CLAUDE_PLUGIN_DATA: pluginData,
      OPENCODE_DELEGATE_KEY_ACCA: key,
      OPENCODE_DELEGATE_KEY_ACCB: key,
    },
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
        resolve(null);
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

  const parseResult = (res) => {
    if (!res.result || res.result.isError) {
      throw new Error(`tool error: ${res.result?.content?.[0]?.text ?? JSON.stringify(res)}`);
    }
    return JSON.parse(res.result.content[0].text);
  };

  const waitIdle = async (sessionID) => {
    for (;;) {
      const outcome = parseResult(await rpc("tools/call", {
        name: "wait",
        arguments: { sessionID, cwd: workspace, timeoutSec: 150 },
      }));
      if (outcome.status !== "timeout") return outcome;
      console.log(`wait: timeout (${sessionID})`);
    }
  };

  const runTask = async (label, file, accountArg) => {
    const args = {
      task: `Crea il file ${file} con contenuto ESATTAMENTE: MA-${label}-OK. Poi scrivi .oc-report.md come da contratto.`,
      cwd: workspace,
      effort: "max",
    };
    if (accountArg !== undefined) args.account = accountArg;
    const del = parseResult(await rpc("tools/call", { name: "delegate", arguments: args }));
    if (!del.sessionID || !del.jobId) throw new Error(`${label}: delegate missing sessionID/jobId`);
    console.log(`delegate ${label}: account=${del.account} model=${del.modelRef} variant=${del.variant}`);
    const outcome = await waitIdle(del.sessionID);
    if (outcome.status === "needsInput") throw new Error(`${label}: unexpected needsInput ${JSON.stringify(outcome.permissions)}`);
    if (outcome.status !== "idle") throw new Error(`${label}: wait ended ${outcome.status}`);
    if (outcome.error) throw new Error(`${label}: assistant error ${JSON.stringify(outcome.error)}`);
    const artifact = path.join(workspace, file);
    if (fs.readFileSync(artifact, "utf8").trim() !== `MA-${label}-OK`) throw new Error(`${label}: artifact content wrong`);
    if (outcome.account !== del.account) throw new Error(`${label}: wait account mismatch ${outcome.account}`);
    console.log(`task ok: ${file} via account=${del.account} jobId=${del.jobId}`);
    return { del, outcome };
  };

  try {
    /* handshake */
    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ma-stress", version: "1.0.0" },
    });
    if (!init.result?.serverInfo) return fail("initialize returned no serverInfo");
    await rpc("notifications/initialized", {});
    console.log(`handshake ok: ${init.result.serverInfo.name}`);

    /* models exposes accounts */
    const models = parseResult(await rpc("tools/call", { name: "models", arguments: { cwd: workspace } }));
    const acct = Object.fromEntries((models.accounts ?? []).map((a) => [a.name, a]));
    if (acct.accA?.configured !== true || acct.accB?.configured !== true) {
      return fail(`accounts not reported as configured: ${JSON.stringify(models.accounts)}`);
    }
    if (acct.accA.envVar !== "OPENCODE_DELEGATE_KEY_ACCA") return fail(`envVar wrong: ${acct.accA.envVar}`);
    console.log("models ok: accounts accA+accB configured");

    /* round-robin rotation across two real delegations */
    const r1 = await runTask("A", "ma-a.txt");
    if (r1.del.account !== "accA") return fail(`first auto pick expected accA, got ${r1.del.account}`);
    const r2 = await runTask("B", "ma-b.txt");
    if (r2.del.account !== "accB") return fail(`second auto pick expected accB (rotation), got ${r2.del.account}`);

    /* explicit account honored */
    const r3 = await runTask("C", "ma-c.txt", "accA");
    if (r3.del.account !== "accA") return fail(`explicit accA not honored: ${r3.del.account}`);

    /* unknown account rejected */
    const badPick = await rpc("tools/call", {
      name: "delegate",
      arguments: { task: "x", cwd: workspace, account: "ghost" },
    });
    if (!badPick.result?.isError || !/ACCOUNT_UNKNOWN/.test(badPick.result.content[0].text)) {
      return fail(`unknown account not rejected properly: ${badPick.result?.content?.[0]?.text}`);
    }
    console.log("reject ok: ghost account → ACCOUNT_UNKNOWN");

    /* state persistence: jobs carry account, LRU recorded */
    const state = JSON.parse(fs.readFileSync(path.join(pluginData, "state", "state.json"), "utf8"));
    const jobs = state.jobs ?? [];
    const expected = [
      [r1.del.jobId, "accA"],
      [r2.del.jobId, "accB"],
      [r3.del.jobId, "accA"],
    ];
    for (const [jobId, want] of expected) {
      const job = jobs.find((j) => j.id === jobId);
      if (!job) return fail(`state.json missing job ${jobId}`);
      if (job.account !== want) return fail(`job ${jobId} account=${job.account}, expected ${want}`);
    }
    if (!jobs.every((j) => typeof j.account === "string")) return fail("some job records lack account field");
    const lru = state.config?.accountLastUsed ?? {};
    if (!(lru.accA > lru.accB)) return fail(`LRU not persisted correctly: ${JSON.stringify(lru)}`);
    console.log(`state ok: ${jobs.length} jobs with account field; lru accA=${lru.accA} > accB=${lru.accB}`);

    if (process.exitCode) return;
    console.log("\nMA-STRESS PASS: round-robin rotation, per-account isolation, explicit pick, rejection, state persistence.");
  } catch (err) {
    fail(err.message);
  } finally {
    proc.kill();
  }
}

main();

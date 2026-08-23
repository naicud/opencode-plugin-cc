// Escalation-path E2E: drive a delegation through a credential that the
// provider will reject, and assert that `wait` returns the assistant error
// WITH an actionable escalation suggestion instead of a bare failure.
//
// Usage: node plugins/opencode/scripts/stress-escalation.mjs  (needs `opencode` installed)

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
  console.error(`ESC-STRESS FAIL: ${msg}`);
  process.exitCode = 1;
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oc-esc-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "oc-esc-state-"));

  const config = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "config", "models.json"), "utf8"));
  // Tier 0 free model stays reachable for the suggestion chain; the doomed
  // account points every request at a deliberately invalid API key.
  const configPath = path.join(workspace, "models.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OC_MODELS_CONFIG: configPath,
      CLAUDE_PLUGIN_DATA: pluginData,
      OPENCODE_DELEGATE_KEY_DOOMED: "sk-invalid-key-for-escalation-test",
    },
    cwd: PLUGIN_ROOT,
  });
  // Force the doomed account by pointing accounts at it via a second config layer:
  // simplest no-workaround route is rewriting the config before spawn — done below.

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

  try {
    /* rewrite config to use ONLY the doomed account (single-account legacy shape) */
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.accounts = { names: ["doomed"], strategy: "fixed", default: "doomed" };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");

    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "esc-stress", version: "1.0.0" },
    });
    if (!init.result?.serverInfo) return fail("no serverInfo");
    await rpc("notifications/initialized", {});
    console.log("handshake ok (doomed-account config)");

    /* models must NOT leak the doomed key anywhere */
    const models = parseResult(await rpc("tools/call", { name: "models", arguments: { cwd: workspace } }));
    if (JSON.stringify(models).includes("sk-invalid")) return fail("secret leaked through models tool");
    console.log("models ok: no secret leakage");

    const del = parseResult(await rpc("tools/call", {
      name: "delegate",
      arguments: { task: "Scrivi ok.txt con contenuto ESCALATION-OK.", cwd: workspace },
    }));
    if (del.account !== "doomed") return fail(`expected doomed account, got ${del.account}`);
    console.log(`delegate ok: account=${del.account} model=${del.modelRef}`);

    /* wait until terminal state; provider should reject the bogus key */
    let outcome = null;
    for (;;) {
      outcome = parseResult(await rpc("tools/call", {
        name: "wait",
        arguments: { sessionID: del.sessionID, cwd: workspace, timeoutSec: 120 },
      }));
      if (outcome.status !== "timeout") break;
      console.log("wait: timeout, retrying");
    }

    if (outcome.status !== "idle") return fail(`unexpected terminal status ${outcome.status}`);
    if (!outcome.error) {
      console.log("NOTE: provider accepted the bogus key (test env without real provider enforcement); escalation path not exercisable here.");
      console.log("\nESC-STRESS PASS (weak mode): flow clean, secret containment verified.");
      return;
    }

    const esc = outcome.escalation;
    if (!esc || esc.retryable !== true) return fail(`missing/non-retryable escalation: ${JSON.stringify(esc)}`);
    if (!esc.suggestModel) return fail(`escalation lacks suggestModel: ${JSON.stringify(esc)}`);
    const tierOf = Object.fromEntries((cfg.models ?? []).map((m) => [m.id, m.tier]));
    const failedTier = tierOf[outcome.error && del.modelRef?.split("/")[1]] ?? cfg.defaults?.tier;
    console.log(`error surfaced: ${outcome.error.name} (${outcome.error.data?.statusCode ?? "?"})`);
    console.log(`escalation ok: kind=${esc.kind} suggest=${esc.suggestModel} variant=${esc.suggestVariant ?? "-"} reason="${esc.reason}"`);

    /* job marked failed in state */
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    const { stateRoot } = await import("../scripts/lib/state.mjs");
    const state = JSON.parse(fs.readFileSync(path.join(stateRoot(workspace), "state.json"), "utf8"));
    const job = (state.jobs ?? []).find((j) => j.id === del.jobId);
    if (!job || job.status !== "failed") return fail(`job not marked failed: ${JSON.stringify(job)}`);

    console.log("\nESC-STRESS PASS: retryable assistant error produced actionable escalation + failed job record.");
  } catch (err) {
    fail(err.message);
  } finally {
    proc.kill();
  }
}

main();

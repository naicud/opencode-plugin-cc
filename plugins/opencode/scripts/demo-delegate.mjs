// Compact live demo of the delegation runtime for the README GIF:
// handshake -> tools -> catalog -> delegate (free tier0, max effort) ->
// wait with streamed progress -> verify artifact + report contract ->
// clean shutdown. Talks to mcp/server.mjs over stdio exactly like Claude Code.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SERVER = path.join(ROOT, "mcp", "server.mjs");
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "oc-demo-"));

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const proc = spawn(process.execPath, [SERVER], {
  cwd: CWD,
  env: { ...process.env, OPENCODE_PROGRESS_INTERVAL_MS: "1200" },
  stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.on("data", () => {}); // keep protocol stdout clean

let nextId = 1;
const pending = new Map();

function send(msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  } else if (msg.method === "notifications/progress") {
    console.log(`  ${cyan("↻")} ${msg.params.message}`);
  }
});

function parse(res) {
  if (res.error || res.result?.isError) {
    throw new Error(JSON.stringify(res.error ?? res.result ?? {}));
  }
  return JSON.parse(res.result.content[0].text);
}

async function main() {
  // Fire-and-forget initialization notification (server never replies).
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "readme-demo", version: "1.0.0" },
  });
  console.log(bold("opencode delegation runtime") + dim(` — ${init.result.serverInfo.name} v${init.result.serverInfo.version}`));

  const tools = await rpc("tools/list", {});
  console.log(green("✓") + ` ${tools.result.tools.length} MCP tools: ${dim(tools.result.tools.map((t) => t.name).join(" "))}`);

  const models = await rpc("tools/call", { name: "models", arguments: { cwd: CWD } });
  const catalog = parse(models);
  const def = catalog.models.find((m) => m.default);
  console.log(green("✓") + ` ${catalog.models.length} models merged from live catalog — default: ${bold(`${catalog.provider}/${def.id}`)} ${yellow(`variant=${def.variants.at(-1)}`)}`);

  console.log(dim("\n▸ delegating task…"));
  const del = await rpc("tools/call", {
    name: "delegate",
    arguments: { task: "Create the file demo-artifact.txt containing exactly DEMO-OK", cwd: CWD },
  });
  const job = parse(del);
  console.log(green("✓") + ` session ${dim(job.sessionID.slice(0, 12))}… → ${bold(job.modelRef)} ${yellow(job.variant)} ${dim(`(${job.account ?? "default account"})`)}`);

  console.log(dim("\n▸ supervising (live progress)…"));
  let last;
  while (true) {
    last = parse(
      await rpc("tools/call", {
        name: "wait",
        arguments: { sessionID: job.sessionID, cwd: CWD, timeoutSec: 20, _meta: { progressToken: `demo-${Date.now()}` } },
      })
    );
    if (last.status !== "timeout") break;
  }
  if (last.status === "needsInput") throw new Error("unexpected permission block in demo");
  if (last.error || last.escalation) {
    throw new Error(`delegation error: ${JSON.stringify(last.error ?? last.escalation).slice(0, 300)}`);
  }
  console.log(green("✓") + ` completed — response: ${bold(String(last.response ?? "").slice(0, 90))}`);

  const reportPath = path.join(CWD, ".oc-report.md");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`no .oc-report.md — raw wait payload: ${JSON.stringify(last).slice(0, 400)}`);
  }
  const report = fs.readFileSync(reportPath, "utf8");
  const status = report.match(/STATUS:\s*(\w+)/)?.[1] ?? "?";
  const artifact = fs.readFileSync(path.join(CWD, "demo-artifact.txt"), "utf8").trim();
  if (artifact !== "DEMO-OK") throw new Error(`artifact mismatch: ${artifact}`);
  console.log(green("✓") + ` artifact verified byte-exact · report STATUS: ${bold(status)} · cost: $${last.cost ?? 0}`);

  console.log(dim("\n▸ clean shutdown…"));
  const sd = parse(await rpc("tools/call", { name: "shutdown", arguments: { cwd: CWD } }));
  console.log(green("✓") + ` stopped server pid(s): ${sd.stopped.map((s) => s.port).join(", ") || "(none)"} — zero orphan processes`);

  console.log("\n" + green(bold("demo complete")));
  proc.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error(`demo failed: ${err.message}`);
  proc.kill();
  process.exit(1);
});

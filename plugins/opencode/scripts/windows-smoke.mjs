// Windows smoke test: boots the MCP server on this machine (opencode CLI
// expected on PATH) and verifies handshake + tools/list + doctor over stdio.
// Zero deps, same driver mechanics as e2e-delegate.mjs.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const EXPECTED_TOOLS = [
  "abort",
  "delegate",
  "diff",
  "doctor",
  "fanOut",
  "logs",
  "models",
  "respond",
  "shutdown",
  "status",
  "wait",
  "waitAll",
];

const proc = spawn(process.execPath, [SERVER], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrTail = "";
proc.stderr?.on("data", (d) => {
  stderrTail = (stderrTail + d.toString()).slice(-4000);
});

const pending = new Map();
let nextId = 1;
let buffer = "";

const rl = readline.createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // non-protocol noise
  }
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function rpc(method, params, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function parseResult(res) {
  if (!res?.result || res.result.isError) {
    throw new Error(`tools/call failed: ${JSON.stringify(res).slice(0, 300)}`);
  }
  return JSON.parse(res.result.content[0].text);
}

function fail(message) {
  console.error(`WINDOWS-SMOKE FAIL: ${message}`);
  if (stderrTail.trim()) console.error(`server stderr tail:\n${stderrTail}`);
  proc.kill();
  process.exit(1);
}

try {
  // Handshake
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "windows-smoke", version: "1.0.0" },
  }).catch((e) => fail(`handshake: ${e.message}`));
  if (init.result?.serverInfo?.name !== "opencode-delegate") {
    fail(`bad serverInfo: ${JSON.stringify(init.result).slice(0, 200)}`);
  }
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  console.log("handshake ok:", init.result.serverInfo.name, init.result.serverInfo.version);

  // tools/list
  const tools = await rpc("tools/list", {}).catch((e) => fail(`tools/list: ${e.message}`));
  const names = tools.result.tools.map((t) => t.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
    fail(`tools mismatch: ${names.join(",")}`);
  }
  console.log("tools ok:", names.length, "tools");

  // doctor — proves the real opencode binary is found and state dir works
  const doctor = await rpc("tools/call", { name: "doctor", arguments: {} }).catch(
    (e) => fail(`doctor: ${e.message}`)
  );
  const report = parseResult(doctor);
  if (typeof report.ok !== "boolean" || !Array.isArray(report.checks)) {
    fail(`doctor malformed: ${JSON.stringify(report).slice(0, 200)}`);
  }
  const binaryCheck = report.checks.find((c) => c.name === "opencode-binary");
  if (!binaryCheck) fail("doctor missing opencode-binary check");
  if (binaryCheck.status !== "pass") {
    // Fresh CI runners occasionally race the npm-global PATH refresh right
    // after `npm i -g`. Retry a few times before declaring the binary dead.
    let last = binaryCheck;
    for (let attempt = 0; attempt < 3 && last.status !== "pass"; attempt++) {
      await new Promise((r) => setTimeout(r, 4000));
      const retry = parseResult(await rpc("tools/call", { name: "doctor", arguments: {} }).catch((e) => fail(`doctor retry: ${e.message}`)));
      last = retry.checks?.find((c) => c.name === "opencode-binary") ?? retry;
    }
    if (last.status !== "pass") {
      fail(`opencode-binary not usable on this runner: ${last.status} — ${last.detail} (PATH=${process.env.PATH ?? "?"})`);
    }
  }
  console.log("doctor ok:", report.ok ? "ok" : `problems (${report.report.split("\n").length - 1} lines)`);

  console.log("\nWINDOWS-SMOKE PASS");
  proc.kill();
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}

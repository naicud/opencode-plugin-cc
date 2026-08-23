// Tests for the rescue/task flow debt fixes:
// 1. handleSetup/handleCancel must derive the server port from the workspace
//    (derivePort) instead of hardcoding 127.0.0.1:4096.
// 2. --model on /opencode:rescue (companion `task` / `task-worker`) must reach
//    the actual OpenCode prompt request, not just be parsed.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import { derivePort, normalizeModelSpec } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { loadState } from "../plugins/opencode/scripts/lib/state.mjs";

const COMPANION = path.resolve("plugins/opencode/scripts/opencode-companion.mjs");

let tmpDir;

beforeEach(() => {
  tmpDir = createTmpDir();
  setupTestEnv(tmpDir);
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("port derivation", () => {
  it("derivePort is deterministic for the same cwd", () => {
    const a = derivePort("/some/workspace");
    const b = derivePort("/some/workspace");
    assert.equal(a, b);
  });

  it("derivePort differs across workspaces", () => {
    const ports = new Set();
    for (let i = 0; i < 20; i++) {
      ports.add(derivePort(`/workspace-${i}`));
    }
    assert.ok(ports.size > 1, "expected distinct ports across workspaces");
  });

  it("derivePort stays inside the derived range", () => {
    for (let i = 0; i < 50; i++) {
      const port = derivePort(`/w-${i}`);
      assert.ok(port >= 4100 && port < 4500, `port ${port} out of range`);
    }
  });

  it("an account yields a different port than no account", () => {
    // Over many seeds the account variant must diverge at least sometimes.
    let diverged = false;
    for (let i = 0; i < 20; i++) {
      const cwd = `/acc-ws-${i}`;
      if (derivePort(cwd) !== derivePort(cwd, "work")) diverged = true;
    }
    assert.ok(diverged, "account seed never changed the port");
  });

  it("companion script no longer hardcodes the default port", () => {
    const source = fs.readFileSync(COMPANION, "utf8");
    assert.equal(source.includes("127.0.0.1:4096"), false, "hardcoded 127.0.0.1:4096 must be gone");
    assert.match(source, /derivePort/, "companion must use derivePort");
  });
});

describe("model spec normalization", () => {
  it("splits provider/model strings into the nested selector", () => {
    assert.deepEqual(normalizeModelSpec("anthropic/claude-opus-4"), {
      providerID: "anthropic",
      modelID: "claude-opus-4",
    });
    // only the first slash separates provider from model id
    assert.deepEqual(normalizeModelSpec("opencode/x-preview-f-free"), {
      providerID: "opencode",
      modelID: "x-preview-f-free",
    });
  });

  it("passes through an already-shaped selector and null", () => {
    const shaped = { providerID: "openai", modelID: "gpt-5" };
    assert.deepEqual(normalizeModelSpec(shaped), shaped);
    assert.equal(normalizeModelSpec(null), null);
    assert.equal(normalizeModelSpec(undefined), undefined);
  });

  it("rejects bare model ids and malformed selectors", () => {
    assert.throws(() => normalizeModelSpec("gpt-5"), /provider\/model/);
    assert.throws(() => normalizeModelSpec("/gpt-5"), /provider\/model/);
    assert.throws(() => normalizeModelSpec("openai/"), /provider\/model/);
    assert.throws(() => normalizeModelSpec({ modelID: "gpt-5" }), /providerID and modelID/);
  });
});

/**
 * This dev machine often has real OpenCode servers listening inside the
 * derived-port range; ensureServer() short-circuits to anything healthy, so a
 * test workspace whose derived port collides would hit a live server. Keep
 * drawing temp workspaces until the derived port is verifiably free.
 */
async function createIsolatedWorkspace() {
  for (let attempt = 0; attempt < 25; attempt++) {
    // realpath: on macOS os.tmpdir() is /var/folders (symlink to
    // /private/var/folders); spawned children observe the resolved path, and
    // derivePort hashes the literal string — both sides must agree.
    const ws = fs.realpathSync(createTmpDir("ws"));
    const port = derivePort(ws);
    const taken = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: AbortSignal.timeout(1000),
    }).then(
      () => true,
      (err) => err?.cause?.code !== "ECONNREFUSED"
    );
    if (!taken) return ws;
    cleanupTmpDir(ws);
  }
  throw new Error("could not find a workspace whose derived port is free");
}

/**
 * Minimal stand-in for an OpenCode HTTP server listening on the port derived
 * for the given workspace. Records every prompt request body.
 */
function startFakeServer(workspace) {
  const captured = [];
  let sessionSeq = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/global/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST" && req.url === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `ses_fake_${++sessionSeq}` }));
      return;
    }
    if (req.method === "GET" && /^\/session\/[^/]+\/diff$/.test(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files: [] }));
      return;
    }
    if (req.method === "POST" && /^\/session\/[^/]+\/message$/.test(req.url)) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          captured.push(JSON.parse(body));
        } catch {
          captured.push(null);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ info: {}, parts: [{ type: "text", text: "ok" }] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    // Listen on exactly the derived port so ensureServer() short-circuits.
    server.listen(derivePort(workspace), "127.0.0.1", () => resolve({ server, captured }));
  });
}

/**
 * Run the companion script asynchronously. spawnSync would block this
 * process's event loop — and with it the fake OpenCode server — so every
 * child request would time out and drift onto a real dev server.
 */
function runCompanion(args, { cwd, data } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

describe("rescue model forwarding", () => {
  it("task-worker forwards --model into the prompt request body", async () => {
    const ws = await createIsolatedWorkspace();
    const data = createTmpDir("data");
    const { server, captured } = await startFakeServer(ws);

    try {
      const run = await runCompanion(
        ["task-worker",
          "--job-id", "mw-test-1",
          "--workspace", ws,
          "--task-text", "fix the bug",
          "--agent", "build",
          "--write",
          "--model", "anthropic/claude-opus-4"],
        { data }
      );
      assert.equal(run.status, 0, `worker failed: ${run.stderr}`);
      assert.equal(captured.length, 1);
      assert.deepEqual(captured[0].model, { providerID: "anthropic", modelID: "claude-opus-4" });
      assert.equal(captured[0].agent, "build");
    } finally {
      server.close();
      cleanupTmpDir(ws);
      cleanupTmpDir(data);
    }
  });

  it("task-worker omits model when --model is not passed", async () => {
    const ws = await createIsolatedWorkspace();
    const data = createTmpDir("data2");
    const { server, captured } = await startFakeServer(ws);

    try {
      const run = await runCompanion(
        ["task-worker",
          "--job-id", "mw-test-2",
          "--workspace", ws,
          "--task-text", "fix the bug",
          "--agent", "build"],
        { data }
      );
      assert.equal(run.status, 0, `worker failed: ${run.stderr}`);
      assert.equal(captured.length, 1);
      assert.equal(captured[0].model, undefined);
    } finally {
      server.close();
      cleanupTmpDir(ws);
      cleanupTmpDir(data);
    }
  });

  it("foreground task forwards --model and records it on the job", async () => {
    const ws = await createIsolatedWorkspace();
    const data = createTmpDir("data3");
    const { server, captured } = await startFakeServer(ws);

    try {
      const run = await runCompanion(
        ["task", "fix the bug", "--model", "openai/gpt-5", "--agent", "plan"],
        // resolveWorkspace falls back to process.cwd() when there is no git root
        { cwd: ws, data }
      );
      assert.equal(run.status, 0, `task failed: ${run.stderr}`);
      assert.equal(captured.length, 1);
      assert.deepEqual(captured[0].model, { providerID: "openai", modelID: "gpt-5" });

      const prevData = process.env.CLAUDE_PLUGIN_DATA;
      process.env.CLAUDE_PLUGIN_DATA = data;
      try {
        const state = loadState(ws);
        const job = state.jobs.find((j) => j.type === "task");
        assert.ok(job, "task job recorded");
        assert.equal(job.model, "openai/gpt-5");
      } finally {
        process.env.CLAUDE_PLUGIN_DATA = prevData;
      }
    } finally {
      server.close();
      cleanupTmpDir(ws);
      cleanupTmpDir(data);
    }
  });
});

// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { stateRoot } from "./state.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;
const DERIVED_PORT_BASE = 4100;
const DERIVED_PORT_SPAN = 400;
const SERVER_START_TIMEOUT = 30_000;

/**
 * Derive a deterministic port for a workspace (CA-16): avoids every delegate
 * colliding on the default port while keeping the port stable across calls.
 * An optional account name yields a DIFFERENT port so one server per
 * credential set can coexist for the same workspace.
 * @param {string} cwd
 * @param {string} [account]
 * @returns {number}
 */
export function derivePort(cwd, account) {
  const seed = account ? `${cwd}\u0000${account}` : cwd;
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return DERIVED_PORT_BASE + (parseInt(hash.slice(0, 12), 16) % DERIVED_PORT_SPAN);
}

/**
 * Validate an OPENCODE_AUTH_CONTENT payload before spawn (findings P8 class:
 * malformed auth/config env vars start a server that answers healthy but
 * fails every real call).
 * @param {string} authContent - JSON string Record<providerId,{type:"api",key}>
 */
export function validateAuthContent(authContent) {
  let parsed;
  try {
    parsed = JSON.parse(authContent);
  } catch {
    throw new Error("OPENCODE_AUTH_CONTENT is not valid JSON");
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENCODE_AUTH_CONTENT must be a JSON object keyed by provider id");
  }
  for (const [provider, info] of Object.entries(parsed)) {
    if (!info || typeof info !== "object" || !["api", "oauth", "wellknown"].includes(info.type)) {
      throw new Error(`OPENCODE_AUTH_CONTENT "${provider}" entry missing valid type`);
    }
    if (typeof info.key !== "string" || info.key.length === 0) {
      throw new Error(`OPENCODE_AUTH_CONTENT "${provider}" entry missing key`);
    }
  }
}

/**
 * Validate the permissions object handed to OPENCODE_PERMISSION before spawn
 * (findings P8: an invalid key starts a degraded server that answers healthy).
 * @param {object} perms
 */
export function validateSpawnPermissions(perms) {
  if (perms == null || typeof perms !== "object" || Array.isArray(perms)) {
    throw new Error("OPENCODE_PERMISSION payload must be an object");
  }
  for (const [key, value] of Object.entries(perms)) {
    if (!/^[a-z_]+$/.test(key)) {
      throw new Error(`OPENCODE_PERMISSION invalid tool key "${key}"`);
    }
    const actions = typeof value === "string" ? { "*": value } : value;
    if (typeof actions !== "object" || Array.isArray(actions)) {
      throw new Error(`OPENCODE_PERMISSION "${key}" must be a string or pattern object`);
    }
    for (const action of Object.values(actions)) {
      if (!["allow", "deny", "ask"].includes(action)) {
        throw new Error(`OPENCODE_PERMISSION "${key}" has invalid action ${JSON.stringify(action)}`);
      }
    }
  }
}

/**
 * Probe a port without mistaking a foreign process for OpenCode.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<"ok"|"free"|"busy">} ok = OpenCode healthy, free = connection refused, busy = something else
 */
async function probePort(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/global/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? "ok" : "busy";
  } catch (err) {
    const code = err?.cause?.code ?? err?.code ?? "";
    return code === "ECONNREFUSED" ? "free" : "busy";
  }
}

/**
 * Check if an OpenCode server is already running on the given port.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isServerRunning(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  return (await probePort(host, port)) === "ok";
}

/**
 * Start the OpenCode server if not already running.
 * The port is derived from the workspace (and account, when given) unless
 * opts.port is set; ports held by foreign processes are skipped incrementally.
 * stdout/stderr go to <stateRoot>/servers/serve-<port>.log so start failures
 * are diagnosable (CA-15).
 * @param {object} opts
 * @param {string} opts.cwd - workspace directory (drives port derivation)
 * @param {number} [opts.port] - explicit override
 * @param {string} [opts.host]
 * @param {string|null} [opts.account] - account name (participates in port derivation)
 * @param {string} [opts.authContent] - OPENCODE_AUTH_CONTENT payload (validated before spawn)
 * @param {object} [opts.permissions] - OPENCODE_PERMISSION payload (spawn-time policy)
 * @param {string} [opts.configPath] - OPENCODE_CONFIG file path
 * @returns {Promise<{ url: string, pid?: number, alreadyRunning: boolean }>}
 */
export async function ensureServer(opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const cwd = opts.cwd ?? process.cwd();
  const firstPort = opts.port ?? derivePort(cwd, opts.account ?? null);

  let port = firstPort;
  for (; port < firstPort + 10; port += 1) {
    const probe = await probePort(host, port);
    if (probe === "ok") {
      return { url: `http://${host}:${port}`, alreadyRunning: true };
    }
    if (probe === "free") break;
  }

  let permissionEnv;
  if (opts.permissions != null) {
    validateSpawnPermissions(opts.permissions);
    permissionEnv = JSON.stringify(opts.permissions);
  }

  let authContentEnv;
  if (opts.authContent != null) {
    validateAuthContent(opts.authContent);
    authContentEnv = opts.authContent;
  }

  // Start the server with logs redirected to disk instead of dropped pipes
  const logDir = path.join(stateRoot(cwd), "servers");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `serve-${port}.log`);
  const logStream = fs.openSync(logFile, "a");

  const env = { ...process.env };
  if (permissionEnv != null) env.OPENCODE_PERMISSION = permissionEnv;
  if (opts.configPath != null) env.OPENCODE_CONFIG = opts.configPath;
  if (authContentEnv != null) env.OPENCODE_AUTH_CONTENT = authContentEnv;

  const proc = spawn(
    "opencode",
    ["serve", "--port", String(port), "--hostname", host],
    { stdio: ["ignore", logStream, logStream], detached: true, cwd, env }
  );
  proc.unref();

  // Wait for the server to become ready
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  while (Date.now() < deadline) {
    if (await isServerRunning(host, port)) {
      return { url: `http://${host}:${port}`, pid: proc.pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `OpenCode server failed to start within ${SERVER_START_TIMEOUT / 1000}s on port ${port}. ` +
      `Check the server log at ${logFile}`
  );
}

/**
 * Create an API client bound to a running OpenCode server.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace directory for x-opencode-directory header
 * @returns {OpenCodeClient}
 */
export function createClient(baseUrl, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (opts.directory) {
    headers["x-opencode-directory"] = opts.directory;
  }
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const cred = Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }

  async function request(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${method} ${path} returned ${res.status}: ${text}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  return {
    baseUrl,

    // Health
    health: () => request("GET", "/global/health"),

    // Sessions
    listSessions: () => request("GET", "/session"),
    createSession: (opts = {}) => request("POST", "/session", opts),
    getSession: (id) => request("GET", `/session/${id}`),
    deleteSession: (id) => request("DELETE", `/session/${id}`),
    abortSession: (id) => request("POST", `/session/${id}/abort`),
    getSessionStatus: () => request("GET", "/session/status"),
    getSessionDiff: (id) => request("GET", `/session/${id}/diff`),

    // Messages
    getMessages: (sessionId, opts = {}) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.before) params.set("before", opts.before);
      const qs = params.toString();
      return request("GET", `/session/${sessionId}/message${qs ? "?" + qs : ""}`);
    },

    /**
     * Send a prompt (synchronous / streaming).
     * Returns the full response text from SSE stream.
     */
    sendPrompt: async (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      if (opts.system) body.system = opts.system;

      const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000), // 10 min for long tasks
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenCode prompt failed ${res.status}: ${text}`);
      }

      return res.json();
    },

    /**
     * Send a prompt asynchronously (returns immediately).
     * Body shape per findings P1+P2: model is the nested {providerID, modelID}
     * object; variant is a TOP-LEVEL field, sibling of model.
     */
    sendPromptAsync: (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      if (opts.variant) body.variant = opts.variant;
      return request("POST", `/session/${sessionId}/prompt_async`, body);
    },

    // Agents
    listAgents: () => request("GET", "/agent"),

    // Providers
    listProviders: () => request("GET", "/provider"),
    getProviderAuth: () => request("GET", "/provider/auth"),
    getProviderCatalog: () => request("GET", "/config/providers"),

    // Todos
    getTodo: (id) => request("GET", `/session/${id}/todo`),

    // Permissions (live shape per findings P5)
    listPermissions: () => request("GET", "/permission"),
    respondPermission: (sessionId, permissionId, response) =>
      request("POST", `/session/${sessionId}/permissions/${permissionId}`, { response }),

    // Config
    getConfig: () => request("GET", "/config"),

    // Events (SSE) - returns a ReadableStream
    subscribeEvents: async () => {
      const res = await fetch(`${baseUrl}/event`, {
        headers: { ...headers, Accept: "text/event-stream" },
      });
      return res.body;
    },
  };
}

/**
 * Connect to OpenCode: ensure server is running, create client.
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {number} [opts.port]
 * @returns {Promise<ReturnType<typeof createClient> & { serverInfo: object }>}
 */
export async function connect(opts = {}) {
  const { url } = await ensureServer(opts);
  const client = createClient(url, { directory: opts.cwd });
  return { ...client, serverInfo: { url } };
}

/**
 * Parse an SSE byte stream into events. Hand-written parser (no deps):
 * buffers chunks, splits on "\n", handles "data: {json}" lines and
 * multi-line data fields. Tolerates events split mid-line across chunks.
 * @param {ReadableStream} stream - body of GET /event
 * @param {(event: object) => void} onEvent
 * @returns {Promise<void>} resolves when the stream closes
 */
export async function consumeSseStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          // Malformed JSON line: skip rather than kill the subscription.
        }
      }
    }
    // Flush any trailing event without newline
    if (buffer.startsWith("data:")) {
      try {
        onEvent(JSON.parse(buffer.slice(5).trim()));
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
}

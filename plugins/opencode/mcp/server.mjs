// OpenCode delegation MCP server.
// JSON-RPC 2.0 over stdio, one message per line, zero npm dependencies.
// Methods: initialize, tools/list, tools/call; anything else with an id → -32601.
//
// Six tools: models, delegate, wait, status, respond, abort.
// Reachable from Claude Code as mcp__plugin_opencode_oc__<tool> (plugin name
// is "opencode", server key in .mcp.json is "oc").

import readline from "node:readline";
import path from "node:path";
import {
  ensureServer,
  createClient,
} from "../scripts/lib/opencode-server.mjs";
import { loadConfig, getCatalog, formatHint } from "./lib/catalog.mjs";
import { resolveSelection, buildModelSelector } from "./lib/resolve.mjs";
import { createPermissionWatcher } from "./lib/permissions.mjs";
import { pickAccount, buildAuthContent, envKeyName, listAccounts } from "./lib/accounts.mjs";
import { buildEscalation } from "./lib/escalation.mjs";
import { createJobRecord } from "../scripts/lib/tracked-jobs.mjs";
import { loadState, upsertJob } from "../scripts/lib/state.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const WAIT_POLL_INTERVAL_MS = 5000;
const DEFAULT_WAIT_TIMEOUT_SEC = 600;

/** @type {Map<string, { client: object, watcher: object }>} keyed by baseUrl */
const connections = new Map();

/**
 * Get (or create) a client + permission watcher pair for a workspace/account.
 * Per-account servers coexist on distinct derived ports; each is spawned with
 * its own OPENCODE_AUTH_CONTENT credential set.
 * @param {string} cwd
 * @param {string|null} account - resolved account name or null (legacy path)
 */
async function getConnection(cwd, account = null) {
  const config = loadConfig();
  let authContent;
  if (account) {
    const key = process.env[envKeyName(account)];
    authContent = buildAuthContent(config.provider, key ?? "");
  }
  const { url } = await ensureServer({
    cwd,
    account,
    permissions: config.permissions?.spawn,
    ...(authContent ? { authContent } : {}),
  });
  let conn = connections.get(url);
  if (!conn) {
    const client = createClient(url, { directory: cwd });
    const watcher = createPermissionWatcher({ client, config: () => loadConfig() });
    watcher.start();
    conn = { client, watcher, account };
    connections.set(url, conn);
  }
  return conn;
}

function getClient(cwd, account = null) {
  return getConnection(cwd, account).then((c) => c.client);
}

/**
 * Resolve the account a session belongs to from its job record.
 * @param {string} cwd
 * @param {string} sessionID
 * @returns {string|null}
 */
function accountForSession(cwd, sessionID) {
  try {
    const job = (loadState(cwd).jobs ?? []).find((j) => j.sessionID === sessionID);
    return job?.account ?? null;
  } catch {
    return null;
  }
}

/* ---------------------------------- tools --------------------------------- */

async function toolModels(args) {
  const config = loadConfig();
  const { client } = await getConnection(args.cwd ?? process.cwd());
  const catalog = await getCatalog(client);
  return {
    provider: config.provider,
    models: catalog.models,
    excluded: catalog.excluded,
    live: catalog.live,
    defaults: config.defaults,
    effortPolicy: config.effortPolicy,
    variantPreference: config.variantPreference,
    budget: config.budget,
    accounts: listAccounts(config),
    offPeakWindowsUtc: ["01:00-04:00", "06:00-10:00"],
    hint: formatHint(config, catalog.models),
  };
}

function renderContract(contract, cwd) {
  return (contract ?? "").replaceAll("${cwd}", cwd);
}

async function toolDelegate(args) {
  const cwd = args.cwd ?? process.cwd();
  if (!args.task || typeof args.task !== "string") {
    throw Object.assign(new Error('delegate requires a non-empty "task" string'), {
      code: "TASK_REQUIRED",
    });
  }
  const config = loadConfig();

  // Retry chains: retryOf must reference a failed or cancelled delegate job.
  let retryTarget = null;
  if (args.retryOf != null) {
    if (typeof args.retryOf !== "string" || !args.retryOf.trim()) {
      throw Object.assign(new Error('retryOf must be a non-empty job id or prefix'), { code: "RETRY_OF_INVALID" });
    }
    const candidates = (loadState(cwd).jobs ?? []).filter(
      (j) => j.type === "delegate" && (j.status === "failed" || j.status === "cancelled")
    );
    const exact = candidates.find((j) => j.id === args.retryOf);
    if (exact) {
      retryTarget = exact;
    } else {
      const prefixMatches = candidates.filter((j) => j.id.startsWith(args.retryOf));
      if (prefixMatches.length > 1) {
        throw Object.assign(new Error(`retryOf prefix "${args.retryOf}" is ambiguous across ${prefixMatches.length} jobs`), { code: "RETRY_OF_AMBIGUOUS" });
      }
      retryTarget = prefixMatches[0] ?? null;
    }
    if (!retryTarget) {
      throw Object.assign(new Error(`retryOf "${args.retryOf}" does not match any failed or cancelled delegate job`), { code: "RETRY_TARGET_NOT_FOUND" });
    }
  }

  // Resolve the account BEFORE spawning: fail fast on missing credentials.
  let account = null;
  const accountsBlock = config.accounts;
  if (accountsBlock?.names?.length > 0) {
    account = pickAccount(config, cwd, args.account);
  }

  // Resolve BEFORE spawning anything so bad requests fail fast and cheaply.
  const catalogModels = (await getCatalog(await getClient(cwd, account))).models;
  const selection = resolveSelection(
    { modelId: args.model, tier: args.tier, effort: args.effort },
    catalogModels,
    config
  );
  const selector = buildModelSelector(config.provider, selection.model.id, selection.variant);

  const { client } = await getConnection(cwd, account);
  const agent = args.agent ?? config.defaults?.agent ?? "build";
  const session = await client.createSession({
    title: args.task.replace(/\s+/g, " ").slice(0, 80),
  });
  const promptText = `${renderContract(config.contract, cwd)}\n---\n\n${args.task}`;

  await client.sendPromptAsync(session.id, promptText, {
    agent,
    model: selector.model,
    variant: selection.variant,
  });

  const job = createJobRecord(cwd, "delegate", {
    sessionID: session.id,
    model: selection.model.id,
    variant: selection.variant ?? null,
    effortApplied: selection.effortApplied,
    tier: selection.model.tier ?? null,
    account,
    directory: cwd,
    ...(retryTarget
      ? { retryOf: retryTarget.id, retryOfSession: retryTarget.sessionID ?? null }
      : {}),
  });
  upsertJob(cwd, { id: job.id, status: "running", phase: "delegated" });

  return {
    sessionID: session.id,
    jobId: job.id,
    account,
    modelRef: `${config.provider}/${selection.model.id}`,
    variant: selection.variant ?? null,
    effortApplied: selection.effortApplied,
    reason: selection.reason ?? null,
    source: selection.source,
    ...(retryTarget ? { retryOf: retryTarget.id } : {}),
    cwd,
    startedAt: new Date().toISOString(),
  };
}

async function fetchAssistantOutcome(client, sessionId) {
  try {
    const messages = await client.getMessages(sessionId, { limit: 2 });
    const assistant = [...(messages ?? [])].reverse().find((m) => m.info?.role === "assistant");
    if (!assistant) return null;
    const text = (assistant.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    return { info: assistant.info, text };
  } catch {
    return null;
  }
}

/**
 * Update the delegate job record matching a sessionID (best effort).
 * @param {string} cwd
 * @param {string} sessionID
 * @param {(job: object) => object} patchFn
 */
function markJobBySession(cwd, sessionID, patchFn) {
  try {
    const job = (loadState(cwd).jobs ?? []).find((j) => j.sessionID === sessionID);
    if (job) upsertJob(cwd, { id: job.id, ...patchFn(job) });
  } catch {}
}

/**
 * Compact todo progress summary for wait responses.
 * @param {object} client
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
async function summarizeTodos(client, sessionId) {
  try {
    const todos = await client.getTodo(sessionId);
    if (!Array.isArray(todos) || todos.length === 0) return null;
    const counts = {};
    for (const t of todos) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const current = todos.find((t) => t.status === "in_progress") ?? null;
    return { counts, current: current?.content ?? null, total: todos.length };
  } catch {
    return null;
  }
}

async function toolWait(args) {
  const cwd = args.cwd ?? process.cwd();
  const account = accountForSession(cwd, args.sessionID);
  const { client, watcher } = await getConnection(cwd, account);
  const deadline = Date.now() + (args.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC) * 1000;
  const job = (loadState(cwd).jobs ?? []).find((j) => j.sessionID === args.sessionID);

  for (;;) {
    // Pending permissions for this session surface as needsInput (RF-19)
    const pending = watcher.pendingList(args.sessionID);
      if (pending.length > 0) {
        return {
          status: "needsInput",
          sessionID: args.sessionID,
          jobId: job?.id ?? null,
          account,
          permissions: pending.map((p) => ({
          id: p.id,
          permission: p.permission,
          patterns: p.patterns ?? [],
          command: p.metadata?.command ?? null,
          suggestedAlways: p.always ?? [],
        })),
      };
    }

    const statuses = await client.getSessionStatus().catch(() => null);
    // The live map only contains BUSY sessions: absence means idle (probe finding).
    const state = statuses?.[args.sessionID] ?? { type: "idle" };
    if (state.type !== "busy") {
      const outcome = await fetchAssistantOutcome(client, args.sessionID);
      // Race guard (E2E finding): right after prompt_async the session is not
      // yet marked busy AND has no assistant reply. Treat as still starting.
      if (!outcome && Date.now() < deadline - WAIT_POLL_INTERVAL_MS) {
        if (Date.now() >= deadline) return { status: "timeout", sessionID: args.sessionID, state };
        await new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS));
        continue;
      }
      if (outcome?.info?.error) {
        markJobBySession(cwd, args.sessionID, (job) => ({
          status: "failed",
          errorMessage: outcome.info.error?.data?.message ?? "unknown error",
          completedAt: new Date().toISOString(),
        }));
      } else {
        markJobBySession(cwd, args.sessionID, (job) => ({
          status: "completed",
          completedAt: new Date().toISOString(),
        }));
      }
      return {
        status: "idle",
        sessionID: args.sessionID,
        jobId: job?.id ?? null,
        account,
        state,
        error: outcome?.info?.error ?? null,
        ...(outcome?.info?.error
          ? { escalation: buildEscalation(outcome.info.error, loadConfig(), outcome.info.modelID) }
          : {}),
        cost: outcome?.info?.cost ?? null,
        tokens: outcome?.info?.tokens ?? null,
        variant: outcome?.info?.variant ?? null,
        todos: await summarizeTodos(client, args.sessionID),
        response: outcome?.text ?? "",
      };
    }

    if (Date.now() >= deadline) {
      return { status: "timeout", sessionID: args.sessionID, state };
    }
    await new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS));
  }
}

async function toolStatus(args) {
  const cwd = args.cwd ?? process.cwd();
  const client = await getClient(cwd, accountForSession(cwd, args.sessionID));
  // RF-11: any failing sub-endpoint becomes null, the tool itself must not fail.
  const [statuses, todo, diff, messages] = await Promise.all([
    client.getSessionStatus().catch(() => null),
    client.getTodo(args.sessionID).catch(() => null),
    client.getSessionDiff(args.sessionID).catch(() => null),
    client.getMessages(args.sessionID, { limit: 2 }).catch(() => null),
  ]);
  const lastMessage = Array.isArray(messages) ? messages.at(-1) : null;
  return {
    sessionID: args.sessionID,
    state: statuses?.[args.sessionID] ?? null,
    todo,
    diff: diff ?? null,
    lastMessage:
      lastMessage != null
        ? {
            role: lastMessage.info?.role ?? null,
            variant: lastMessage.info?.variant ?? null,
            cost: lastMessage.info?.cost ?? null,
            error: lastMessage.info?.error ?? null,
            text: (lastMessage.parts ?? [])
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
          }
        : null,
  };
}

async function toolRespond(args) {
  const cwd = args.cwd ?? process.cwd();
  const client = await getClient(cwd, accountForSession(cwd, args.sessionID));
  const ok = await client.respondPermission(args.sessionID, args.permissionID, args.response);
  return { responded: Boolean(ok), permissionID: args.permissionID, response: args.response };
}

async function toolAbort(args) {
  const cwd = args.cwd ?? process.cwd();
  const client = await getClient(cwd, accountForSession(cwd, args.sessionID));
  await client.abortSession(args.sessionID);
  markJobBySession(cwd, args.sessionID, () => ({
    status: "cancelled",
    completedAt: new Date().toISOString(),
  }));
  return { aborted: true, sessionID: args.sessionID };
}

const TOOLS = [
  {
    name: "models",
    title: "Model catalog",
    description:
      "List delegateable opencode models merged with the live catalog: tiers, variants, costs, effort policy, budget and a selection hint.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace directory" },
      },
    },
  },
  {
    name: "delegate",
    title: "Delegate task",
    description:
      "Delegate a task to an opencode model asynchronously. Returns immediately with sessionID/jobId. Use wait to observe progress.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string", description: "Full task description with goal, scope files, verifiable criteria and test command" },
        cwd: { type: "string", description: "Workspace directory" },
        model: { type: "string", description: "Explicit model id (overrides tier)" },
        tier: { type: "number", description: "Tier 0-3 when no explicit model" },
        effort: { type: "string", enum: ["off", "high", "max"], description: "Effort request; default from effortPolicy" },
        account: { type: "string", description: 'OpenCode account for quota routing ("auto" default round-robin)' },
        agent: { type: "string", description: "OpenCode agent (default build)" },
        retryOf: { type: "string", description: "Job id or id prefix of a failed/cancelled delegate job this run retries" },
      },
    },
  },
  {
    name: "wait",
    title: "Wait for session",
    description:
      "Poll a delegated session until it goes idle, needs input (pending permission), or the timeout expires.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["sessionID"],
      properties: {
        sessionID: { type: "string" },
        cwd: { type: "string", description: "Workspace directory" },
        timeoutSec: { type: "number", description: "Default 600" },
      },
    },
  },
  {
    name: "status",
    title: "Session snapshot",
    description: "Non-blocking snapshot of a delegated session: state, todos, diff, last message. Failing sub-endpoints return null instead of erroring.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["sessionID"],
      properties: {
        sessionID: { type: "string" },
        cwd: { type: "string", description: "Workspace directory" },
      },
    },
  },
  {
    name: "respond",
    title: "Answer permission",
    description: "Answer a pending permission request: once, always or reject.",
    inputSchema: {
      type: "object",
      required: ["sessionID", "permissionID", "response"],
      properties: {
        sessionID: { type: "string" },
        permissionID: { type: "string" },
        response: { type: "string", enum: ["once", "always", "reject"] },
        cwd: { type: "string", description: "Workspace directory" },
      },
    },
  },
  {
    name: "abort",
    title: "Abort session",
    description: "Abort a running delegated session.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      required: ["sessionID"],
      properties: {
        sessionID: { type: "string" },
        cwd: { type: "string", description: "Workspace directory" },
      },
    },
  },
];

const TOOL_HANDLERS = {
  models: toolModels,
  delegate: toolDelegate,
  wait: toolWait,
  status: toolStatus,
  respond: toolRespond,
  abort: toolAbort,
};

/* -------------------------------- json-rpc -------------------------------- */

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Handle one JSON-RPC message and return the response object
 * (null for notifications / malformed input without id).
 * @param {object} msg
 * @returns {Promise<object|null>}
 */
export async function handleRpcMessage(msg) {
  if (msg == null || typeof msg !== "object") return null;
  const hasId = "id" in msg && msg.id !== undefined;

  if (msg.method === "initialize") {
    if (!hasId) return null;
    return rpcResult(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "opencode-delegate", version: "1.0.0" },
    });
  }

  if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) {
    return null; // notifications expect no response
  }

  if (msg.method === "tools/list") {
    return rpcResult(msg.id, { tools: TOOLS });
  }

  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params ?? {};
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      if (hasId) {
        return rpcResult(msg.id, {
          content: [{ type: "text", text: `Unknown tool "${name}"` }],
          isError: true,
        });
      }
      return null;
    }
    try {
      const result = await handler(args ?? {});
      return rpcResult(msg.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      });
    } catch (err) {
      return rpcResult(msg.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: err.message,
                ...(err.file ? { file: err.file, line: err.line, column: err.column } : {}),
                ...(err.code ? { code: err.code } : {}),
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      });
    }
  }

  if (hasId) {
    return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
  return null;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      writeMessage(rpcError(null, -32700, "Parse error"));
      return;
    }
    handleRpcMessage(msg)
      .then((response) => {
        if (response) writeMessage(response);
      })
      .catch((err) => {
        if (msg.id !== undefined) writeMessage(rpcError(msg.id, -32603, err.message));
      });
  });

  const shutdown = () => {
    for (const { watcher } of connections.values()) watcher.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;

if (invokedDirectly) {
  main();
}

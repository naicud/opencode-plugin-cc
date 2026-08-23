// OpenCode delegation MCP server.
// JSON-RPC 2.0 over stdio, one message per line, zero npm dependencies.
// Methods: initialize, tools/list, tools/call; anything else with an id → -32601.
//
// Nine tools: models, delegate, wait, waitAll, status, respond, abort,
// shutdown, doctor.
// Reachable from Claude Code as mcp__plugin_opencode_oc__<tool> (plugin name
// is "opencode", server key in .mcp.json is "oc").

import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ensureServer,
  createClient,
  readServerRegistry,
  stopServerEntry,
  removeRegistryEntry,
  stopTrackedServers,
} from "../scripts/lib/opencode-server.mjs";
import { loadConfig, getCatalog, formatHint, formatCostTable } from "./lib/catalog.mjs";
import { resolveSelection, buildModelSelector } from "./lib/resolve.mjs";
import { createPermissionWatcher } from "./lib/permissions.mjs";
import { pickAccount, buildAuthContent, envKeyName, listAccounts } from "./lib/accounts.mjs";
import { buildAgentConfigContent, validateAgentConfigContent, AGENT_NAME } from "./lib/agent.mjs";
import { buildEscalation } from "./lib/escalation.mjs";
import { checkBudget, summarizeBudget } from "./lib/budget.mjs";
import { runDiagnostics, formatDoctorReport } from "../scripts/lib/doctor.mjs";
import { createJobRecord } from "../scripts/lib/tracked-jobs.mjs";
import { loadState, upsertJob, stateBase, generateJobId } from "../scripts/lib/state.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const WAIT_POLL_INTERVAL_MS = 5000;
const DEFAULT_WAIT_TIMEOUT_SEC = 600;
// MCP progress notifications: long waits (wait/waitAll/fanOut-race) stream
// live updates when the caller supplies params._meta.progressToken. Interval
// override exists for tests/e2e; default keeps stdout quiet.
const PROGRESS_INTERVAL_MS_DEFAULT = 15_000;

let progressNotifier = null;

/**
 * Register the stdout writer used for notifications/progress frames.
 * Called once from main(); direct-import tests leave it unset (emitters no-op).
 * @param {(msg: object) => void} [fn]
 */
export function setProgressNotifier(fn) {
  progressNotifier = typeof fn === "function" ? fn : null;
}

/**
 * Build a throttled progress emitter for one tool call.
 * @param {object|undefined} meta - request params._meta ({progressToken})
 * @param {{ totalSec?: number }} [opts]
 * @returns {((message: string) => boolean)|null} emits or null when disabled
 */
export function buildProgressEmitter(meta, opts = {}) {
  const token = meta?.progressToken;
  if (!token || !progressNotifier) return null;
  const total = Number.isFinite(opts.totalSec) ? Math.max(1, Math.round(opts.totalSec)) : undefined;
  const envInterval = Number(process.env.OPENCODE_PROGRESS_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(envInterval) && envInterval >= 250
      ? envInterval
      : PROGRESS_INTERVAL_MS_DEFAULT;
  const startedAt = Date.now();
  let lastSent = 0;
  return (message) => {
    const now = Date.now();
    if (now - lastSent < intervalMs) return false;
    lastSent = now;
    const elapsedSec = Math.round((now - startedAt) / 1000);
    try {
      progressNotifier({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: token,
          ...(total !== undefined ? { total, progress: Math.min(total, elapsedSec) } : { progress: elapsedSec }),
          message: String(message).slice(0, 400),
        },
      });
      return true;
    } catch {
      return false; // a broken notifier must never kill a supervision loop
    }
  };
}

function shortId(sessionID) {
  return typeof sessionID === "string" ? sessionID.slice(0, 8) : "?";
}

/** @type {Map<string, { client: object, watcher: object }>} keyed by baseUrl */
const connections = new Map();

/**
 * Get (or create) a client + permission watcher pair for a workspace/account.
 * Per-account servers coexist on distinct derived ports; each is spawned with
 * its own OPENCODE_AUTH_CONTENT credential set and the server-side
 * "oc-delegate" agent (work contract baked into the agent definition).
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
  const agentContent = buildAgentConfigContent(renderContract(config.contract ?? "", cwd));
  const { url } = await ensureServer({
    cwd,
    account,
    permissions: config.permissions?.spawn,
    configContent: agentContent,
    ...(authContent ? { authContent } : {}),
  });
  let conn = connections.get(url);
  if (!conn) {
    const client = createClient(url, { directory: cwd });
    const watcher = createPermissionWatcher({ client, config: () => loadConfig() });
    watcher.start();
    conn = { client, watcher, account, cwd };
    connections.set(url, conn);
  }
  return conn;
}

/**
 * Resolve which agent a delegated session should run under: our injected
 * "oc-delegate" when the server knows it, else the stock "build" agent
 * (compat shim for older CLIs — reported in delegate responses as
 * supervisorAgent so nothing degrades silently).
 * Result cached per connection.
 */
async function resolveDelegationAgent(conn) {
  if (conn.delegationAgent) return conn.delegationAgent;
  let available = false;
  try {
    const agents = await conn.client.listAgents();
    const names = new Set(
      (Array.isArray(agents) ? agents : Object.keys(agents ?? {})).map((a) =>
        typeof a === "string" ? a : a?.name
      )
    );
    available = names.has(AGENT_NAME);
  } catch {
    available = false;
  }
  conn.delegationAgent = available ? AGENT_NAME : "build";
  conn.delegationAgentInjected = available;
  return conn.delegationAgent;
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
    costTable: formatCostTable(catalog.models),
    budget: summarizeBudget(config, loadState(args.cwd ?? process.cwd()).jobs ?? []),
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

  if (args.autoRetry != null && typeof args.autoRetry !== "boolean") {
    throw Object.assign(new Error('delegate: "autoRetry" must be a boolean'), {
      code: "AUTO_RETRY_INVALID",
    });
  }
  const autoRetry = args.autoRetry === true;

  const jobsNow = loadState(cwd).jobs ?? [];

  // Concurrency cap: protect quotas from runaway fan-outs (waitAll x N).
  const cap = Number(config.concurrency?.maxDelegates);
  if (Number.isFinite(cap) && cap > 0) {
    const running = jobsNow.filter((j) => j.type === "delegate" && j.status === "running").length;
    if (running >= cap) {
      throw Object.assign(
        new Error(
          `delegate limit reached: ${running}/${cap} delegate jobs already running (config.concurrency.maxDelegates); wait or abort one first`
        ),
        { code: "DELEGATE_LIMIT_EXCEEDED" }
      );
    }
  }

  // Budget guard: refuse work that would exceed configured spend limits.
  const verdict = checkBudget(config, jobsNow);
  if (!verdict.ok) {
    throw Object.assign(new Error(verdict.reason), { code: verdict.code });
  }

  // Resolve BEFORE spawning anything so bad requests fail fast and cheaply.
  const catalogModels = (await getCatalog(await getClient(cwd, account))).models;
  const selection = resolveSelection(
    { modelId: args.model, tier: args.tier, effort: args.effort },
    catalogModels,
    config
  );
  const selector = buildModelSelector(selection.model.provider ?? config.provider, selection.model.id, selection.variant);

  const conn = await getConnection(cwd, account);
  const { client } = conn;
  // Server-side agent: our injected "oc-delegate" carries the work contract;
  // explicit args.agent still wins; stock "build" is the reported compat shim.
  const agent = args.agent ?? config.defaults?.agent ?? (await resolveDelegationAgent(conn));
  const agentInjected = args.agent || config.defaults?.agent ? null : conn.delegationAgentInjected === true;

  // resumeSessionID continues an existing persisted session (crash recovery,
  // multi-step delegation) instead of creating a new one. Fail fast when the
  // session does not exist on this server.
  let sessionID;
  let resumedFrom = null;
  if (args.resumeSessionID != null) {
    if (typeof args.resumeSessionID !== "string" || !args.resumeSessionID.trim()) {
      throw Object.assign(new Error("resumeSessionID must be a non-empty session id"), { code: "RESUME_SESSION_INVALID" });
    }
    try {
      await client.getMessages(args.resumeSessionID, { limit: 1 });
    } catch {
      throw Object.assign(new Error(`session "${args.resumeSessionID}" not found on this server; cannot resume`), { code: "RESUME_SESSION_NOT_FOUND" });
    }
    sessionID = args.resumeSessionID;
    resumedFrom = args.resumeSessionID;
  } else {
    const session = await client.createSession({
      title:
        typeof args.title === "string" && args.title.trim()
          ? args.title.replace(/\s+/g, " ").trim().slice(0, 80)
          : args.task.replace(/\s+/g, " ").slice(0, 80),
    });
    sessionID = session.id;
  }

  const promptText = `${renderContract(config.contract, cwd)}\n---\n\n${args.task}`;

  await client.sendPromptAsync(sessionID, promptText, {
    agent,
    model: selector.model,
    variant: selection.variant,
  });

  const job = createJobRecord(cwd, "delegate", {
    sessionID,
    model: selection.model.id,
    variant: selection.variant ?? null,
    effortApplied: selection.effortApplied,
    tier: selection.model.tier ?? null,
    account,
    directory: cwd,
    task: args.task,
    autoRetry,
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(retryTarget
      ? { retryOf: retryTarget.id, retryOfSession: retryTarget.sessionID ?? null }
      : {}),
  });
  upsertJob(cwd, { id: job.id, status: "running", phase: "delegated" });

  return {
    sessionID,
    jobId: job.id,
    account,
    modelRef: `${selection.model.provider ?? config.provider}/${selection.model.id}`,
    variant: selection.variant ?? null,
    effortApplied: selection.effortApplied,
    reason: selection.reason ?? null,
    source: selection.source,
    agent,
    ...(agentInjected === false ? { agentNote: `server does not expose "${AGENT_NAME}" agent; ran under stock "build" (contract still prepended to the prompt)` } : {}),
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(retryTarget ? { retryOf: retryTarget.id } : {}),
    cwd,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Fan out MULTIPLE tasks in parallel with ONE call: same resolved model+variant
 * for every task, round-robin account rotation per task (when accounts are
 * configured), one job record each tagged with a shared fanOutId. Supervise the
 * batch afterwards with waitAll. Partial failures mid-loop keep already-started
 * tasks running and are reported instead of discarding the work.
 *
 * mode:"race" supervises inline instead: the first task that reaches idle
 * WITHOUT an assistant error wins; every other session is aborted (jobs marked
 * cancelled as race-loser) so losers stop burning quota immediately.
 */
async function toolFanOut(args, meta) {
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    throw Object.assign(new Error('fanOut requires a non-empty "tasks" string array'), {
      code: "TASKS_REQUIRED",
    });
  }
  if (args.tasks.length > 12) {
    throw Object.assign(new Error("fanOut supports at most 12 tasks per call"), {
      code: "TASKS_TOO_MANY",
    });
  }
  args.tasks.forEach((t, i) => {
    if (!t || typeof t !== "string" || !t.trim()) {
      throw Object.assign(new Error(`tasks[${i}] must be a non-empty string`), {
        code: "TASKS_INVALID",
      });
    }
  });
  if (args.titlePrefix != null && (typeof args.titlePrefix !== "string" || !args.titlePrefix.trim())) {
    throw Object.assign(new Error('fanOut: "titlePrefix" must be a non-empty string'), {
      code: "TITLE_PREFIX_INVALID",
    });
  }
  const mode = args.mode ?? "batch";
  if (!["batch", "race"].includes(mode)) {
    throw Object.assign(new Error('fanOut: "mode" must be "batch" or "race"'), {
      code: "MODE_INVALID",
    });
  }

  const cwd = args.cwd ?? process.cwd();
  const config = loadConfig();
  const jobsNow = loadState(cwd).jobs ?? [];

  // Concurrency cap counts the whole batch, not just the first task.
  const cap = Number(config.concurrency?.maxDelegates);
  if (Number.isFinite(cap) && cap > 0) {
    const running = jobsNow.filter((j) => j.type === "delegate" && j.status === "running").length;
    if (running + args.tasks.length > cap) {
      throw Object.assign(
        new Error(
          `delegate limit reached: ${running}/${cap} delegate jobs already running and fanOut wants ${args.tasks.length} more (config.concurrency.maxDelegates); wait or abort first`
        ),
        { code: "DELEGATE_LIMIT_EXCEEDED" }
      );
    }
  }

  // Budget guard once for the whole batch.
  const verdict = checkBudget(config, jobsNow);
  if (!verdict.ok) {
    throw Object.assign(new Error(verdict.reason), { code: verdict.code });
  }

  // Resolve model+variant ONCE against the catalog; identical effort everywhere.
  const firstAccount =
    config.accounts?.names?.length > 0 ? pickAccount(config, cwd, args.account ?? "auto") : null;
  const catalogModels = (await getCatalog(await getClient(cwd, firstAccount))).models;
  const selection = resolveSelection(
    { modelId: args.model, tier: args.tier, effort: args.effort },
    catalogModels,
    config
  );
  const selector = buildModelSelector(selection.model.provider ?? config.provider, selection.model.id, selection.variant);
  const firstConn = await getConnection(cwd, firstAccount);
  const agent = args.agent ?? config.defaults?.agent ?? (await resolveDelegationAgent(firstConn));
  const prefix = (
    typeof args.titlePrefix === "string" && args.titlePrefix.trim()
      ? args.titlePrefix.replace(/\s+/g, " ").trim()
      : "Fanout"
  ).slice(0, 40);

  const fanOutId = generateJobId("fanout");
  const n = args.tasks.length;
  const jobs = [];
  const failed = [];

  for (let i = 0; i < n; i += 1) {
    const task = args.tasks[i].trim();
    try {
      // Round-robin rotates per task when accounts are configured.
      let account = null;
      if (config.accounts?.names?.length > 0) {
        account =
          i === 0 && args.account !== undefined && args.account !== "auto"
            ? firstAccount
            : pickAccount(config, cwd, args.account ?? "auto");
      }
      const { client } = await getConnection(cwd, account);
      const session = await client.createSession({
        title: `${prefix} ${i + 1}/${n}: ${task.replace(/\s+/g, " ").slice(0, 60)}`,
      });
      await client.sendPromptAsync(session.id, `${renderContract(config.contract, cwd)}\n---\n\n${task}`, {
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
        task,
        autoRetry: false,
        fanOutId,
        fanOutIndex: i,
      });
      upsertJob(cwd, { id: job.id, status: "running", phase: "delegated" });
      jobs.push({
        jobId: job.id,
        sessionID: session.id,
        index: i,
        account,
        title: `${prefix} ${i + 1}/${n}`,
      });
    } catch (err) {
      failed.push({ index: i, error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
  }

  const batchResult = {
    fanOutId,
    total: n,
    started: jobs.length,
    failed,
    jobs,
    modelRef: `${selection.model.provider ?? config.provider}/${selection.model.id}`,
    variant: selection.variant ?? null,
    effortApplied: selection.effortApplied,
  };

  if (mode !== "race") {
    return {
      ...batchResult,
      nextStep:
        jobs.length > 0
          ? `Supervise with waitAll on these sessionIDs: ${jobs.map((j) => j.sessionID).join(", ")}`
          : "No task could be started.",
    };
  }
  if (jobs.length === 0) {
    return { ...batchResult, mode, winner: null, aborted: [], note: "No task could be started." };
  }

  // ---- race supervision: first clean idle wins, the rest get aborted ----
  const RACE_SLICE_SEC = 15;
  const raceEmit = buildProgressEmitter(meta, { totalSec: args.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC });
  const globalDeadline = Date.now() + (args.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC) * 1000;
  let winner = null;
  while (winner === null && Date.now() < globalDeadline) {
    const sliceRemaining = Math.max(1, Math.ceil((globalDeadline - Date.now()) / 1000));
    const slice = await Promise.all(
      jobs.map((j) =>
        toolWait({
          sessionID: j.sessionID,
          cwd,
          timeoutSec: Math.min(RACE_SLICE_SEC, sliceRemaining),
        })
      )
    );
    // Deterministic pick: lowest index that finished cleanly in this slice.
    const cleanIdx = slice.findIndex((r) => r.status === "idle" && !r.error);
    if (cleanIdx >= 0) {
      winner = { ...jobs[cleanIdx], outcome: slice[cleanIdx] };
      break;
    }
    // Everyone blocked on permissions or finished with errors: nobody can win
    // without external help — stop early instead of burning the deadline.
    const terminal = (r) => r.status === "idle" || r.status === "needsInput";
    if (slice.every(terminal)) break;
    raceEmit?.(
      `race ${jobs.length} runners — ${slice.filter((r) => r.status === "timeout").length} still working; ` +
        jobs.map((j, i2) => `${shortId(j.sessionID)}: ${slice[i2]?.status ?? "?"}`).join(", ")
    );
  }

  const aborted = [];
  for (const j of jobs) {
    if (winner && j.sessionID === winner.sessionID) continue;
    try {
      await toolAbort({ sessionID: j.sessionID, cwd });
      markJobBySession(cwd, j.sessionID, () => ({ cancelledReason: winner ? "race-loser" : "race-no-winner" }));
      aborted.push({ sessionID: j.sessionID, jobId: j.jobId, index: j.index });
    } catch {
      // already idle/terminal: nothing to abort
    }
  }

  if (!winner) {
    return {
      ...batchResult,
      mode,
      winner: null,
      aborted,
      note:
        aborted.length > 0
          ? "Race ended without a clean winner (blocked on permissions or errors); losers aborted."
          : "Race deadline hit before any task finished; sessions were NOT aborted — supervise with waitAll.",
      ...(aborted.length === 0
        ? { nextStep: `Supervise with waitAll on these sessionIDs: ${jobs.map((j) => j.sessionID).join(", ")}` }
        : {}),
    };
  }

  return {
    ...batchResult,
    mode,
    winner: {
      jobId: winner.jobId,
      sessionID: winner.sessionID,
      index: winner.index,
      account: winner.account,
      response: winner.outcome.response ?? null,
      cost: winner.outcome.cost ?? null,
    },
    aborted,
    nextStep: `Winner session ${winner.sessionID} completed its task; verify its artifacts yourself.`,
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

async function toolWait(args, meta) {
  const cwd = args.cwd ?? process.cwd();
  const account = accountForSession(cwd, args.sessionID);
  const { client, watcher } = await getConnection(cwd, account);
  const timeoutSec = args.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC;
  const emit = buildProgressEmitter(meta, { totalSec: timeoutSec });
  const deadline = Date.now() + timeoutSec * 1000;
  const job = (loadState(cwd).jobs ?? []).find((j) => j.sessionID === args.sessionID);

  for (;;) {
    // Pending permissions for this session surface as needsInput (RF-19)
    const pending = watcher.pendingList(args.sessionID);
      if (pending.length > 0) {
        const progress = await fetchAssistantOutcome(client, args.sessionID).catch(() => null);
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
        ...(progress?.text
          ? { progress: { tail: progress.text.slice(-300), todos: await summarizeTodos(client, args.sessionID) } }
          : {}),
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
        const esc = buildEscalation(outcome.info.error, loadConfig(), outcome.info.modelID);

        // Auto-retry (one shot per original delegation): re-delegate the same
        // task at the escalation-suggested model/variant.
        if (esc?.retryable && job?.autoRetry && !job.autoRetriedAs && retryChainDepth(cwd, job) < maxAutoRetries(loadConfig())) {
          try {
            const retried = await toolDelegate({
              task: job.task ?? args.task ?? undefined,
              cwd,
              ...(esc.suggestModel ? { model: esc.suggestModel } : {}),
              effort: esc.suggestVariant ?? "max",
              ...(account ? { account } : {}),
              retryOf: job.id,
            });
            markJobBySession(cwd, args.sessionID, () => ({
              status: "failed",
              errorMessage: outcome.info.error?.data?.message ?? "unknown error",
              completedAt: new Date().toISOString(),
              autoRetriedAs: retried.jobId,
              autoRetrySession: retried.sessionID,
            }));
            return {
              status: "retried",
              sessionID: args.sessionID,
              jobId: job?.id ?? null,
              retryJobId: retried.jobId,
              newSessionID: retried.sessionID,
              modelRef: retried.modelRef,
              variant: retried.variant,
              reason: esc.reason ?? "retryable failure escalated automatically",
              originalError: outcome.info.error,
            };
          } catch {
            // fall through to the plain failed return below
          }
        }

        markJobBySession(cwd, args.sessionID, () => ({
          status: "failed",
          errorMessage: outcome.info.error?.data?.message ?? "unknown error",
          completedAt: new Date().toISOString(),
        }));
      } else {
        markJobBySession(cwd, args.sessionID, () => ({
          status: "completed",
          completedAt: new Date().toISOString(),
          ...(Number.isFinite(outcome?.info?.cost) ? { cost: outcome.info.cost } : {}),
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
      // Live progress: at deadline, attach a short tail of the latest assistant
      // text plus todos so the supervisor sees movement without extra calls.
      const progress = await fetchAssistantOutcome(client, args.sessionID).catch(() => null);
      return {
        status: "timeout",
        sessionID: args.sessionID,
        jobId: job?.id ?? null,
        account,
        state,
        ...(progress?.text ? { progress: { tail: progress.text.slice(-300), todos: await summarizeTodos(client, args.sessionID) } } : {}),
      };
    }
    // Sleep the poll interval, but wake instantly when a session.idle SSE
    // event arrives for this session (watcher consumes /event already).
    await Promise.race([
      new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS)),
      watcher.waitForIdle(args.sessionID, WAIT_POLL_INTERVAL_MS).catch(() => false),
    ]);

    // Live progress frame (only when the caller passed a progressToken):
    // latest streamed assistant text straight from the SSE part tracker.
    emit?.(`waiting ${shortId(args.sessionID)} — ${watcher.assistantText(args.sessionID).replace(/\s+/g, " ").trim().slice(-200) || "no assistant output yet"}`);
  }
}

/**
 * Configurable auto-retry chain budget (config.retryPolicy.maxAutoRetries,
 * default 2). Values below 1 fall back to the default.
 * @param {object} config
 * @returns {number}
 */
function maxAutoRetries(config) {
  const v = config?.retryPolicy?.maxAutoRetries;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 2;
}

/**
 * Length of the retryOf chain ending at this job (capped walk).
 * @param {string} cwd
 * @param {object} job
 * @returns {number}
 */
function retryChainDepth(cwd, job) {
  let depth = 0;
  let current = job;
  const seen = new Set();
  while (current?.retryOf && depth < 5 && !seen.has(current.id)) {
    seen.add(current.id);
    const prev = (loadState(cwd).jobs ?? []).find((j) => j.id === current.retryOf);
    if (!prev) break;
    depth += 1;
    current = prev;
  }
  return depth;
}

async function toolStatus(args) {
  const cwd = args.cwd ?? process.cwd();
  // Batch mode: no sessionID → recent delegate jobs overview.
  if (!args.sessionID) {
    const jobs = (loadState(cwd).jobs ?? [])
      .filter((j) => j.type === "delegate")
      .sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime())
      .slice(0, 20)
      .map((j) => ({
        id: j.id,
        status: j.status,
        sessionID: j.sessionID ?? null,
        model: j.model ?? null,
        variant: j.variant ?? null,
        account: j.account ?? null,
        tier: j.tier ?? null,
        retryOf: j.retryOf ?? null,
        resumedFrom: j.resumedFrom ?? null,
        errorMessage: j.errorMessage ?? null,
        cost: Number.isFinite(j.cost) ? j.cost : null,
        createdAt: j.createdAt ?? null,
        completedAt: j.completedAt ?? null,
      }));
    return { jobs };
  }
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

async function toolWaitAll(args, meta) {
  const ids = Array.isArray(args.sessionIDs) ? args.sessionIDs : [];
  if (ids.length === 0 || ids.some((s) => typeof s !== "string" || !s.trim())) {
    throw Object.assign(new Error('waitAll requires a non-empty "sessionIDs" string array'), {
      code: "SESSION_IDS_REQUIRED",
    });
  }
  const MAX_PARALLEL_WAITS = 12;
  if (ids.length > MAX_PARALLEL_WAITS) {
    throw Object.assign(new Error(`waitAll supports at most ${MAX_PARALLEL_WAITS} sessions per call`), {
      code: "SESSION_IDS_TOO_MANY",
    });
  }
  const results = await Promise.all(
    ids.map((sessionID) =>
      toolWait({ ...args, sessionID }, meta).catch((err) => ({
        status: "error",
        sessionID,
        error: err?.message ?? String(err),
      }))
    )
  );
  return {
    sessionIDs: ids,
    results,
    summary: {
      total: results.length,
      idle: results.filter((r) => r.status === "idle").length,
      needsInput: results.filter((r) => r.status === "needsInput").length,
      timeout: results.filter((r) => r.status === "timeout").length,
      error: results.filter((r) => r.status === "error").length,
    },
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

/**
 * Enumerate every tracked-server registry across ALL workspaces
 * (shutdown tool "all" scope). Entries carry their own cwd.
 */
function allRegistryEntries() {
  const base = stateBase();
  let hashes;
  try {
    hashes = fs.readdirSync(base);
  } catch {
    return [];
  }
  const entries = [];
  for (const h of hashes) {
    const dir = path.join(base, h, "servers");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^serve-\d+\.json$/.test(f)) continue;
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (entry && typeof entry.pid === "number" && typeof entry.cwd === "string") {
          entries.push(entry);
        }
      } catch {
        // unreadable entry: skip
      }
    }
  }
  return entries;
}

/**
 * Gracefully abort the busy sessions of one server (best effort) before its
 * process is stopped. Sessions survive as MessageAbortedError and can be
 * continued later via delegate.resumeSessionID.
 */
async function abortBusySessions(baseUrl, cwd) {
  const client = createClient(baseUrl, { directory: cwd });
  const busy = await client.getSessionStatus();
  const aborted = [];
  for (const sessionID of Object.keys(busy ?? {})) {
    try {
      await client.abortSession(sessionID);
      aborted.push(sessionID);
    } catch {
      // already idle or endpoint hiccup: not fatal for shutdown
    }
  }
  return aborted;
}

function cancelRunningJobs(cwd, { account = null, sessionIDs = [] } = {}) {
  let cancelled = 0;
  let jobs;
  try {
    jobs = loadState(cwd).jobs ?? [];
  } catch {
    return 0;
  }
  const sidSet = new Set(sessionIDs);
  for (const job of jobs) {
    if (job.status !== "running" || !job.sessionID) continue;
    const matchesAccount = !account || job.account === account;
    const matchesSession = sidSet.size === 0 || sidSet.has(job.sessionID);
    if (matchesAccount && matchesSession) {
      markJobBySession(cwd, job.sessionID, () => ({
        status: "cancelled",
        completedAt: new Date().toISOString(),
        cancelledBy: "shutdown",
      }));
      cancelled += 1;
    }
  }
  return cancelled;
}

/**
 * Cleanly stop plugin-spawned OpenCode servers:
 * 1. abort busy sessions on each target (graceful),
 * 2. stop permission watchers + drop live connections,
 * 3. SIGTERM→SIGKILL the exact recorded pids (ps-identity checked; foreign or
 *    recycled pids are refused, never signalled),
 * 4. mark their running delegate jobs cancelled.
 * Scope: current workspace by default; `account` narrows it; `all:true`
 * sweeps every workspace this plugin ever spawned servers for.
 */
async function toolShutdown(args) {
  if (args.all != null && typeof args.all !== "boolean") {
    throw Object.assign(new Error('shutdown: "all" must be a boolean'), { code: "ALL_INVALID" });
  }
  if (args.account != null && (typeof args.account !== "string" || !args.account)) {
    throw Object.assign(new Error('shutdown: "account" must be a non-empty string'), {
      code: "ACCOUNT_INVALID",
    });
  }
  if (args.deleteSessions != null && typeof args.deleteSessions !== "boolean") {
    throw Object.assign(new Error('shutdown: "deleteSessions" must be a boolean'), {
      code: "DELETE_SESSIONS_INVALID",
    });
  }
  const cwd = args.cwd ?? process.cwd();
  const scopeAll = args.all === true;
  const account = args.account ?? null;
  // Session GC: opt-in destructive cleanup. Only sessions referenced by
  // TERMINAL delegate jobs of the target workspaces are deleted — never
  // running ones, never sessions the plugin does not know about.
  const deleteSessions = args.deleteSessions === true;

  // Collect target registry entries grouped by their owning workspace.
  let targets; // Array<{ cwd, entry }>
  if (scopeAll) {
    targets = allRegistryEntries()
      .filter((e) => !account || e.account === account)
      .map((entry) => ({ cwd: entry.cwd, entry }));
  } else {
    targets = readServerRegistry(cwd)
      .filter((e) => !account || e.account === account)
      .map((entry) => ({ cwd, entry }));
  }

  const stopped = [];
  const alreadyDead = [];
  const refused = [];
  const failed = [];
  const abortedSessions = [];
  let jobsCancelled = 0;
  let deletedSessions = 0;

  for (const target of targets) {
    const baseUrl = `http://${target.entry.host ?? "127.0.0.1"}:${target.entry.port}`;
    // 1) graceful abort while the server is still alive
    try {
      abortedSessions.push(...(await abortBusySessions(baseUrl, target.cwd)));
    } catch {
      // server unreachable: proceed to process cleanup anyway
    }
    // 1b) opt-in session GC for terminal delegate jobs of this workspace
    if (deleteSessions) {
      const sids = new Set(
        (loadState(target.cwd).jobs ?? [])
          .filter(
            (j) =>
              j.type === "delegate" &&
              j.sessionID &&
              j.status !== "running" &&
              (!account || j.account === account)
          )
          .map((j) => j.sessionID)
          .filter((sid) => !abortedSessions.includes(sid))
      );
      for (const sid of sids) {
        try {
          await createClient(baseUrl, { directory: target.cwd }).deleteSession(sid);
          deletedSessions += 1;
        } catch {
          // session already gone or endpoint hiccup: not fatal
        }
      }
    }
    // 2) drop any live connection + watcher bound to this server
    for (const [url, conn] of [...connections]) {
      if (url !== baseUrl) continue;
      try {
        conn.watcher.stop();
      } catch {
        // watcher already gone
      }
      connections.delete(url);
    }
    // 3) identity-checked process stop + registry cleanup
    const res = await stopServerEntry(target.entry);
    if (res.outcome !== "refused") removeRegistryEntry(target.cwd, target.entry.port);
    switch (res.outcome) {
      case "stopped":
        stopped.push({ port: target.entry.port, pid: target.entry.pid, account: target.entry.account ?? null });
        break;
      case "alreadyDead":
        alreadyDead.push({ port: target.entry.port });
        break;
      case "refused":
        refused.push({ port: target.entry.port, pid: target.entry.pid, reason: res.reason });
        break;
      default:
        failed.push({ port: target.entry.port, pid: target.entry.pid, reason: res.reason });
    }
    // 4) bookkeeping per owning workspace
    jobsCancelled += cancelRunningJobs(target.cwd, {
      account: target.entry.account ?? null,
      sessionIDs: abortedSessions,
    });
  }

  return {
    scope: scopeAll ? "all" : "workspace",
    ...(account ? { account } : {}),
    ...(deleteSessions ? { deletedSessions } : {}),
    stopped,
    alreadyDead,
    refused,
    failed,
    abortedSessions,
    jobsCancelled,
  };
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
        resumeSessionID: { type: "string", description: "Existing opencode session id to continue (crash recovery / multi-step) instead of creating a new session" },
        title: { type: "string", description: "Optional session title override (default: first 80 chars of task)" },
        autoRetry: { type: "boolean", description: "On retryable failure (quota/rate/5xx), automatically re-delegate once at the escalation-suggested model+variant and return status 'retried' with the new sessionID" },
      },
    },
  },
  {
    name: "fanOut",
    title: "Fan out tasks",
    description:
      "Delegate MULTIPLE tasks in parallel with one call: same resolved model+variant for all, round-robin account rotation per task, shared fanOutId. Returns per-task jobId/sessionID; supervise the batch with waitAll.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 12, description: "Task descriptions (same model+effort each)" },
        mode: { type: "string", enum: ["batch", "race"], description: "batch (default): return immediately, supervise with waitAll. race: first task to finish cleanly wins, all others are aborted to save quota" },
        timeoutSec: { type: "number", description: "race mode shared deadline seconds (default 600)" },
        cwd: { type: "string", description: "Workspace directory" },
        model: { type: "string", description: "Explicit model id (overrides tier)" },
        tier: { type: "number", description: "Tier 0-3 when no explicit model" },
        effort: { type: "string", enum: ["off", "high", "max"], description: "Effort request; default from effortPolicy" },
        account: { type: "string", description: 'OpenCode account for quota routing ("auto" default round-robin)' },
        agent: { type: "string", description: "OpenCode agent (default oc-delegate when injected, else build)" },
        titlePrefix: { type: "string", description: "Session title prefix (default Fanout)" },
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
    name: "waitAll",
    title: "Wait for sessions",
    description:
      "Wait for MULTIPLE delegated sessions in parallel until each goes idle, needs input, or the shared timeout expires. Returns per-session outcomes plus counts.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["sessionIDs"],
      properties: {
        sessionIDs: { type: "array", items: { type: "string" }, description: "Up to 12 session ids" },
        cwd: { type: "string", description: "Workspace directory" },
        timeoutSec: { type: "number", description: "Default 600 (shared deadline)" },
      },
    },
  },
  {
    name: "status",
    title: "Session snapshot",
    description: "Non-blocking snapshot of a delegated session (state, todos, diff, last message). WITHOUT sessionID: lists recent delegate jobs with status/model/account. Failing sub-endpoints return null instead of erroring.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        sessionID: { type: "string", description: "Omit to list recent delegate jobs instead" },
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
  {
    name: "shutdown",
    title: "Shutdown delegate servers",
    description:
      "Cleanly stop OpenCode servers spawned by this plugin: gracefully aborts busy sessions, kills ONLY the exact tracked processes (ps identity-checked — foreign pids are refused), marks their jobs cancelled. Leaves zero orphan processes. Default scope: current workspace; account narrows it; all:true sweeps every workspace. deleteSessions:true additionally deletes the terminal delegate sessions (opt-in GC).",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace directory (default scope)" },
        account: { type: "string", description: "Only stop servers bound to this account" },
        all: { type: "boolean", description: "Stop plugin-spawned servers across ALL workspaces" },
        deleteSessions: { type: "boolean", description: "Also DELETE terminal delegate sessions from OpenCode storage (destructive, opt-in)" },
      },
    },
  },
  {
    name: "doctor",
    title: "Diagnostics",
    description:
      "Run environment diagnostics for the delegation plugin: opencode binary on PATH, node version, auth env vars (legacy + per-account), derived port health, server registry state (stale entries cleaned automatically), state dir writability.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace directory" },
      },
    },
  },
];

const TOOL_HANDLERS = {
  models: toolModels,
  delegate: toolDelegate,
  fanOut: toolFanOut,
  wait: toolWait,
  waitAll: toolWaitAll,
  status: toolStatus,
  respond: toolRespond,
  abort: toolAbort,
  shutdown: toolShutdown,
  doctor: toolDoctor,
};

/**
 * Environment diagnostics rendered for the supervisor: structured checks plus
 * a human-readable report block.
 */
async function toolDoctor(args) {
  const cwd = args.cwd ?? process.cwd();
  const report = await runDiagnostics({ cwd, config: loadConfig(), checkBinaries: true });
  return {
    ok: report.ok,
    platform: report.platform,
    node: report.node,
    checks: report.checks,
    report: formatDoctorReport(report),
  };
}

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
      const result = await handler(args ?? {}, msg.params?._meta);
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
  setProgressNotifier(writeMessage);
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

// Direct-invocation guard. fileURLToPath is required for Windows: the naive
// `new URL(import.meta.url).pathname` yields "/C:/..." which never equals a
// resolved argv[1], so the server would silently start no stdio loop there.
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main();
}

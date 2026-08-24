// OpenCode delegation MCP server.
// JSON-RPC 2.0 over stdio, one message per line, zero npm dependencies.
// Methods: initialize, tools/list, tools/call; anything else with an id → -32601.
//
// Twelve tools: models, delegate, fanOut, wait, waitAll, status, logs, diff,
// respond, abort, shutdown, doctor.
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
import { snapshotGitHead, diffSinceSnapshot } from "./lib/workspace-diff.mjs";
import { pickAccount, buildAuthContent, envKeyName, listAccounts } from "./lib/accounts.mjs";
import { buildAgentConfigContent, validateAgentConfigContent, AGENT_NAME, PERSONAS } from "./lib/agent.mjs";
import { buildEscalation } from "./lib/escalation.mjs";
import { checkBudget, summarizeBudget } from "./lib/budget.mjs";
import { runDiagnostics, formatDoctorReport } from "../scripts/lib/doctor.mjs";
import { createJobRecord } from "../scripts/lib/tracked-jobs.mjs";
import { loadState, upsertJob, stateBase, generateJobId } from "../scripts/lib/state.mjs";
import { jobLogPath } from "../scripts/lib/state.mjs";
import { tailLines } from "../scripts/lib/fs.mjs";
import { createActivitySink } from "./lib/activity-log.mjs";
import {
  emitLog,
  setLogSink,
  setLogLevel,
} from "./lib/mcp-log.mjs";
import { sweepStateDirs } from "../scripts/lib/hygiene.mjs";
import { getGitRoot } from "../scripts/lib/git.mjs";

/**
 * Default workspace for tools called without an explicit cwd.
 * Anchored ONCE at startup: the git root of the directory Claude Code launched
 * the MCP server from (falling back to that directory). This mirrors the
 * companion's resolveWorkspace() rule, so artifacts, job records and server
 * ports always land in the user's project — never in some random host cwd.
 * Exported for tests.
 */
export const DEFAULT_CWD = (await getGitRoot(process.cwd())) ?? process.cwd();

const PROTOCOL_VERSION = "2024-11-05";
const WAIT_POLL_INTERVAL_MS = 5000;
// How long an idle session with zero assistant output is given to wake up on
// its own before the zombie nudge fires (see toolWait).
const EMPTY_IDLE_GRACE_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_SEC = 600;
// Auto-slice for `wait` calls that pin neither timeoutSec nor a progressToken:
// return an activity snapshot every slice so the supervisor sees live movement
// (override with OPENCODE_WAIT_SLICE_SEC; tests use 1).
const WAIT_SLICE_SEC = 60;
// MCP progress notifications: long waits (wait/waitAll/fanOut-race) stream
// live updates when the caller supplies params._meta.progressToken. These
// frames render in Claude Code's UI ONLY — they never enter the model context,
// so streaming costs zero tokens/quota. Interval override exists for tests;
// default keeps the UI lively without spamming.
const PROGRESS_INTERVAL_MS_DEFAULT = 8_000;

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

/**
 * Validate and resolve the workspace directory argument.
 * Rejects non-strings, empty values, relative paths, and directories that do
 * not exist. The path is returned UNCHANGED (no realpath) so state keys stay
 * stable for callers that always pass the same spelling.
 * @param {object} args
 * @returns {string}
 */
function resolveCwd(args) {
  const cwd = args?.cwd ?? DEFAULT_CWD;
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw Object.assign(new Error('cwd must be a non-empty string'), { code: "CWD_INVALID" });
  }
  if (!path.isAbsolute(cwd)) {
    throw Object.assign(new Error(`cwd must be an absolute path: ${cwd}`), {
      code: "CWD_NOT_ABSOLUTE",
    });
  }
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw Object.assign(new Error(`cwd does not exist: ${cwd}`), { code: "CWD_NOT_FOUND" });
  }
  if (!stat.isDirectory()) {
    throw Object.assign(new Error(`cwd is not a directory: ${cwd}`), { code: "CWD_NOT_DIRECTORY" });
  }
  return cwd;
}

/** @type {Map<string, { client: object, watcher: object }>} keyed by baseUrl */
const connections = new Map();

// Shared activity sink: streams SSE session activity (assistant text,
// reasoning, permissions, errors) into an in-memory per-job buffer consumed
// by the logs tool. Exported for tests.
export const activitySink = createActivitySink();

// Job ids whose .oc-report.md content was already embedded in a wait response.
// First idle wait delivers the full report; later waits only confirm it was
// seen — this is what makes the hygiene reaper's deferred deletion safe.
const reportsDelivered = new Set();
const REPORT_MAX_CHARS = 8000;
// Safety valve for very long-lived server processes.
const MAX_TRACKED_REPORTS = 500;

/**
 * Read the contract report (.oc-report.md) a delegated agent wrote in the
 * workspace, capped to REPORT_MAX_CHARS. Exported for tests.
 * @param {string} cwd
 * @param {string} [jobId]
 * @returns {{ path: string, status: string|null, chars: number, truncated: boolean, content?: string, deliveredBefore?: boolean }|null}
 */
export function readReportSnapshot(cwd, jobId = null) {
  // Preferred: the per-job file (fan-out safe). Fallback: the legacy root
  // .oc-report.md written by sessions before per-job paths existed.
  const candidates = [
    jobId ? path.join(cwd, ".oc-reports", `${jobId}.md`) : null,
    path.join(cwd, ".oc-report.md"),
  ].filter(Boolean);
  let raw = null;
  let file = candidates[candidates.length - 1];
  for (const candidate of candidates) {
    try {
      raw = fs.readFileSync(candidate, "utf8");
      file = candidate;
      break;
    } catch {}
  }
  if (raw == null) return null;
  const status = (raw.split("\n", 1)[0] ?? "").trim() || null;
  const alreadyDelivered = jobId != null && reportsDelivered.has(jobId);
  if (jobId != null) {
    if (reportsDelivered.size >= MAX_TRACKED_REPORTS) reportsDelivered.clear();
    reportsDelivered.add(jobId);
  }
  const base = { path: file, status, chars: raw.length, truncated: raw.length > REPORT_MAX_CHARS };
  return alreadyDelivered
    ? { ...base, deliveredBefore: true }
    : { ...base, content: raw.slice(0, REPORT_MAX_CHARS) };
}

/**
 * Boot-time + periodic hygiene sweep wrapper. Fire-and-forget: stdout is
 * reserved for JSON-RPC, so results surface as MCP log notifications,
 * stderr lines and doctor checks instead of return values.
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function runHygieneSweep(opts = {}) {
  const res = sweepStateDirs(opts);
  const cleaned =
    res.removedDirs.length +
    res.removedJobFiles.length +
    res.removedTmpFiles.length +
    res.removedReports.length;
  if (cleaned > 0 || res.errors.length > 0 || opts.dryRun) {
    emitLog(
      res.errors.length > 0 ? "warning" : "info",
      `hygiene sweep: ${res.scanned} workspace dir(s), removed ${res.removedDirs.length} stale dir(s), ${res.removedJobFiles.length} orphan job file(s), ${res.removedTmpFiles.length} tmp leftover(s), ${res.removedReports.length} old .oc-report.md`,
      {
        force: true,
        data: opts.dryRun ? { dryRun: true, ...res } : undefined,
      }
    );
  }
  return res;
}

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
    const watcher = createPermissionWatcher({
      client,
      config: () => loadConfig(),
      onEvent: (event) => activitySink.handleEvent(event),
    });
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
async function resolveDelegationAgent(conn, agentName = AGENT_NAME) {
  conn.agentAvailability ??= new Set();
  if (conn.agentAvailability.has(agentName)) return agentName;
  if (conn.agentAvailability.has(`!${agentName}`)) return "build";
  let available = false;
  try {
    const agents = await conn.client.listAgents();
    const names = new Set(
      (Array.isArray(agents) ? agents : Object.keys(agents ?? {})).map((a) =>
        typeof a === "string" ? a : a?.name
      )
    );
    available = names.has(agentName);
  } catch {
    available = false;
  }
  conn.agentAvailability.add(available ? agentName : `!${agentName}`);
  if (available && agentName === AGENT_NAME) {
    conn.delegationAgent = agentName;
    conn.delegationAgentInjected = true;
  }
  return available ? agentName : "build";
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
  const { client } = await getConnection(args.cwd ?? DEFAULT_CWD);
  const catalog = await getCatalog(client);
  return {
    provider: config.provider,
    models: catalog.models,
    excluded: catalog.excluded,
    live: catalog.live,
    defaults: config.defaults,
    effortPolicy: config.effortPolicy,
    variantPreference: config.variantPreference,
    accounts: listAccounts(config),
    offPeakWindowsUtc: ["01:00-04:00", "06:00-10:00"],
    hint: formatHint(config, catalog.models),
    costTable: formatCostTable(catalog.models),
    budget: summarizeBudget(config, loadState(args.cwd ?? DEFAULT_CWD).jobs ?? []),
  };
}

function renderContract(contract, cwd, jobId = null) {
  // ${reportPath} is per-job so concurrent delegates on the SAME workspace
  // never race on one shared file (fan-out overwrote sibling reports before).
  const reportPath = jobId ? `.oc-reports/${jobId}.md` : ".oc-report.md";
  return (contract ?? "").replaceAll("${cwd}", cwd).replaceAll("${reportPath}", reportPath);
}

/**
 * Canonical report location for a job: a dedicated file under .oc-reports/ —
 * unique per job, so parallel fan-out tasks sharing a workspace cannot
 * overwrite each other. The legacy root .oc-report.md stays supported as a
 * read fallback for sessions started before this change.
 */
export function reportPathFor(cwd, jobId) {
  return path.join(cwd, ".oc-reports", `${jobId}.md`);
}

async function toolDelegate(args) {
  const cwd = resolveCwd(args);
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

  // Persona validation happens BEFORE any connection work so invalid args
  // never spawn a server.
  const persona = args.persona ?? "builder";
  if (!Object.keys(PERSONAS).includes(persona)) {
    throw Object.assign(
      new Error(`delegate: "persona" must be one of ${Object.keys(PERSONAS).join("|")}`),
      { code: "PERSONA_INVALID" }
    );
  }

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

  // Budget guard: refuse work that would exceed configured spend limits
  // (global caps plus per-account daily overrides).
  const verdict = checkBudget(config, jobsNow, { account: args.account ?? null });
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
  // Server-side agent: our injected agents carry the work contract;
  // persona selects builder (oc-delegate) vs reviewer (oc-reviewer);
  // explicit args.agent still wins; stock "build" is the reported compat shim.
  const agent = args.agent ?? config.defaults?.agent ?? (await resolveDelegationAgent(conn, PERSONAS[persona]));
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

  // The job id exists before the prompt so the contract can pin a per-job
  // report path (no shared-file races between concurrent delegates).
  const jobId = generateJobId("delegate");
  const promptText =
    `${renderContract(config.contract, cwd, jobId)}\n---\n\n${args.task}\n\n` +
    `[REPORT] Percorso obbligatorio del report finale per QUESTO job: ${reportPathFor(cwd, jobId)} — scrivilo ESATTAMENTE lì (sovrascrive ogni altra indicazione sul percorso del report).`;

  await client.sendPromptAsync(sessionID, promptText, {
    agent,
    model: selector.model,
    variant: selection.variant,
  });

  const job = createJobRecord(cwd, "delegate", {
    id: jobId,
    sessionID,
    model: selection.model.id,
    variant: selection.variant ?? null,
    effortApplied: selection.effortApplied,
    tier: selection.model.tier ?? null,
    account,
    directory: cwd,
    gitBase: snapshotGitHead(cwd),
    task: args.task,
    autoRetry,
    persona,
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(retryTarget
      ? { retryOf: retryTarget.id, retryOfSession: retryTarget.sessionID ?? null }
      : {}),
  });
  upsertJob(cwd, { id: job.id, status: "running", phase: "delegated" });
  activitySink.note(
    cwd,
    sessionID,
    "delegate",
    `job ${job.id} started — model=${selection.model.id}${selection.variant ? ` variant=${selection.variant}` : ""} agent=${agent} persona=${persona}${resumedFrom ? ` resumedFrom=${resumedFrom}` : ""}`
  );
  emitLog("notice", `delegate started job=${job.id} model=${selection.model.id}${selection.variant ? ` variant=${selection.variant}` : ""} persona=${persona}`, {
    force: true,
    data: { jobId: job.id, sessionID, model: selection.model.id, variant: selection.variant ?? null, persona },
  });

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
    persona,
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

  // Per-task workspaces: items may be plain strings or {task, cwd?} objects
  // for parallel delegation across DIFFERENT repositories.
  const entries = args.tasks.map((t, i) => {
    if (typeof t === "string") {
      if (!t.trim()) {
        throw Object.assign(new Error(`tasks[${i}] must be a non-empty string`), {
          code: "TASKS_INVALID",
        });
      }
      return { task: t.trim(), cwd: null };
    }
    if (t && typeof t === "object" && !Array.isArray(t) && typeof t.task === "string" && t.task.trim()) {
      if (t.cwd != null) {
        resolveCwd({ cwd: t.cwd }); // throws CWD_* on bad paths
      }
      return { task: t.task.trim(), cwd: t.cwd ?? null };
    }
    throw Object.assign(new Error(`tasks[${i}] must be a non-empty string or {task, cwd?} object`), {
      code: "TASKS_INVALID",
    });
  });

  const cwd = resolveCwd(args);
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
  // Persona validation happens BEFORE any connection work so invalid args
  // never spawn a server.
  const fanPersona = args.persona ?? "builder";
  if (!Object.keys(PERSONAS).includes(fanPersona)) {
    throw Object.assign(
      new Error(`fanOut: "persona" must be one of ${Object.keys(PERSONAS).join("|")}`),
      { code: "PERSONA_INVALID" }
    );
  }
  const catalogModels = (await getCatalog(await getClient(cwd, firstAccount))).models;
  const selection = resolveSelection(
    { modelId: args.model, tier: args.tier, effort: args.effort },
    catalogModels,
    config
  );
  const selector = buildModelSelector(selection.model.provider ?? config.provider, selection.model.id, selection.variant);
  const firstConn = await getConnection(cwd, firstAccount);
  const agent = args.agent ?? config.defaults?.agent ?? (await resolveDelegationAgent(firstConn, PERSONAS[fanPersona]));
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
    const task = entries[i].task;
    const taskCwd = entries[i].cwd ?? cwd;
    try {
      // Round-robin rotates per task when accounts are configured.
      let account = null;
      if (config.accounts?.names?.length > 0) {
        account =
          i === 0 && args.account !== undefined && args.account !== "auto"
            ? firstAccount
            : pickAccount(config, taskCwd, args.account ?? "auto");
      }
      const { client } = await getConnection(taskCwd, account);
      const session = await client.createSession({
        title: `${prefix} ${i + 1}/${n}: ${task.replace(/\s+/g, " ").slice(0, 60)}`,
      });
      // Per-job report path: parallel tasks on one workspace never overwrite
      // each other's .oc-report (the shared-file bug reported on fan-out).
      const jobId = generateJobId("task");
      await client.sendPromptAsync(
        session.id,
        `${renderContract(config.contract, taskCwd, jobId)}\n---\n\n${task}\n\n` +
          `[REPORT] Percorso obbligatorio del report finale per QUESTO job: ${reportPathFor(taskCwd, jobId)} — scrivilo ESATTAMENTE lì (sovrascrive ogni altra indicazione sul percorso del report).`,
        {
          agent,
          model: selector.model,
          variant: selection.variant,
        }
      );
      const job = createJobRecord(taskCwd, "delegate", {
        id: jobId,
        sessionID: session.id,
        model: selection.model.id,
        variant: selection.variant ?? null,
        effortApplied: selection.effortApplied,
        tier: selection.model.tier ?? null,
        account,
        directory: taskCwd,
        gitBase: snapshotGitHead(taskCwd),
        task,
        autoRetry: false,
        fanOutId,
        fanOutIndex: i,
      });
      upsertJob(taskCwd, { id: job.id, status: "running", phase: "delegated" });
      jobs.push({
        jobId: job.id,
        sessionID: session.id,
        index: i,
        account,
        ...(entries[i].cwd ? { cwd: taskCwd } : {}),
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
    emitLog("notice", `fanOut ${jobs.length}/${n} task(s) started (batch)`, { force: true });
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

  // Reasoning tail of the winning run — quality comparison across race
  // competitors needs the WHY, not just the verdict.
  let winnerReasoningTail = "";
  try {
    const winConn = await getConnection(cwd, winner.account ?? null);
    winnerReasoningTail = (winConn.watcher.reasoningText?.(winner.sessionID) ?? "").slice(-600);
  } catch {}

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
      reasoningTail: winnerReasoningTail,
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

/**
 * Find a delegate job for a sessionID, first in the given workspace then
 * across every workspace state dir (fanOut tasks may live in per-task
 * workspaces while wait/waitAll are called with the primary cwd).
 * @returns {{ job: object|null, jobCwd: string }}
 */
export function findJobRecord(cwd, sessionID) {
  const direct = (loadState(cwd).jobs ?? []).find((j) => j.sessionID === sessionID);
  if (direct) return { job: direct, jobCwd: cwd };
  const base = stateBase();
  let hashes = [];
  try {
    hashes = fs.readdirSync(base);
  } catch {
    return { job: null, jobCwd: cwd };
  }
  for (const h of hashes) {
    const file = path.join(base, h, "state.json");
    let jobs;
    try {
      jobs = JSON.parse(fs.readFileSync(file, "utf8")).jobs ?? [];
    } catch {
      continue;
    }
    const hit = jobs.find((j) => j.sessionID === sessionID && typeof j.directory === "string");
    if (hit) return { job: hit, jobCwd: hit.directory };
  }
  return { job: null, jobCwd: cwd };
}

/**
 * Effective wait duration. When the caller pins timeoutSec (or supplies a
 * progressToken) behavior is unchanged: one long blocking poll. Otherwise the
 * call auto-slices to WAIT_SLICE_SEC so Claude Code sees a fresh activity
 * snapshot (assistant tail, reasoning, tool calls) every slice instead of a
 * mute block that eventually gets backgrounded — classic-subagent feel with
 * zero manual `logs` calls.
 */
export function effectiveWaitTimeoutSec(args = {}, meta = {}) {
  if (Number.isFinite(args.timeoutSec)) return Math.max(1, args.timeoutSec);
  if (meta?.progressToken) return DEFAULT_WAIT_TIMEOUT_SEC;
  const envSlice = Number.parseInt(process.env.OPENCODE_WAIT_SLICE_SEC ?? "", 10);
  return Number.isFinite(envSlice) && envSlice > 0 ? envSlice : WAIT_SLICE_SEC;
}

async function toolWait(args, meta) {
  const cwd = resolveCwd(args);
  const account = accountForSession(cwd, args.sessionID);
  const { client, watcher } = await getConnection(cwd, account);
  const autoSliced = !Number.isFinite(args.timeoutSec) && !meta?.progressToken;
  const timeoutSec = effectiveWaitTimeoutSec(args, meta);
  const emit = buildProgressEmitter(meta, { totalSec: timeoutSec });
  const deadline = Date.now() + timeoutSec * 1000;
  const found = findJobRecord(cwd, args.sessionID);
  const job = found.job;
  const jobCwd = found.jobCwd; // may differ from cwd for cross-workspace fanOut tasks
  let firstIdleSeen = 0; // zombie detection: when we first saw idle+no-assistant

  for (;;) {
    // Pending permissions for this session surface as needsInput (RF-19)
    const pending = watcher.pendingList(args.sessionID);
      if (pending.length > 0) {
        const progress = await fetchAssistantOutcome(client, args.sessionID).catch(() => null);
        activitySink.note(jobCwd, args.sessionID, "wait", "needsInput — permission pending");
        emitLog("notice", `session ${shortId(args.sessionID)} needs input — ${pending.length} permission(s) pending`, { force: true });
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
      // Server-side retry (live finding): a transient provider failure puts the
      // session in state.type==="retry" (absent from the busy map). It will
      // resume on its own — NOT terminal; keep supervising until deadline.
      if (outcome?.info?.state?.type === "retry") {
        if (Date.now() >= deadline) {
          return { status: "timeout", sessionID: args.sessionID, state: outcome.info.state };
        }
        await new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS));
        continue;
      }
      // Race guard + zombie recovery (E2E finding): right after prompt_async
      // the session is not yet marked busy AND has no assistant reply. Keep
      // polling through the start-up grace; if the session sits idle with NO
      // assistant message at all beyond EMPTY_IDLE_GRACE_MS, upstream has
      // wedged it (live finding under provider flakiness) — nudge the SAME
      // persisted session instead of waiting out the whole deadline.
      const nowTs = Date.now();
      if (!outcome && nowTs < deadline - WAIT_POLL_INTERVAL_MS) {
        if (!firstIdleSeen) firstIdleSeen = nowTs;
        const waitedIdle = nowTs - firstIdleSeen;
        if (
          waitedIdle > EMPTY_IDLE_GRACE_MS &&
          job?.type === "delegate" &&
          (job.nudgedCount ?? 0) < 2
        ) {
          try {
            await client.sendPromptAsync(
              args.sessionID,
              job?.id
            ? `Non hai prodotto alcun output. Esegui ORA il task assegnato e scrivi il report in ${reportPathFor(jobCwd, job.id)} come richiesto.`
            : "Non hai prodotto alcun output. Esegui ORA il task assegnato e scrivi .oc-report.md come richiesto."
            );
            markJobBySession(jobCwd, args.sessionID, () => ({
              nudgedCount: (job.nudgedCount ?? 0) + 1,
              nudgedAt: new Date().toISOString(),
            }));
          } catch {
            // nudge failed: keep polling; honest timeout if it never wakes
          }
        }
        await new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS));
        continue;
      }
      // Empty-idle guard (live finding): the session went idle with an
      // assistant message that has NO text, NO error and NO cost — upstream
      // occasionally does this under provider flakiness. Nudge (same budget
      // as the zombie path) instead of reporting a hollow success.
      if (
        outcome &&
        !outcome.text &&
        !outcome.info?.error &&
        job?.type === "delegate" &&
        (job.nudgedCount ?? 0) < 2 &&
        Date.now() < deadline - WAIT_POLL_INTERVAL_MS
      ) {
        try {
          await client.sendPromptAsync(
            args.sessionID,
            job?.id
            ? `Non hai prodotto alcun output. Esegui ORA il task assegnato e scrivi il report in ${reportPathFor(jobCwd, job.id)} come richiesto.`
            : "Non hai prodotto alcun output. Esegui ORA il task assegnato e scrivi .oc-report.md come richiesto."
          );
          markJobBySession(jobCwd, args.sessionID, () => ({
            nudgedCount: (job.nudgedCount ?? 0) + 1,
            nudgedAt: new Date().toISOString(),
          }));
          await new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS));
          continue;
        } catch {
          // nudge failed: fall through and report the empty idle honestly
        }
      }
      if (outcome?.info?.error) {
        const esc = buildEscalation(outcome.info.error, loadConfig(), outcome.info.modelID);

        // Auto-retry (one shot per original delegation): re-delegate the same
        // task at the escalation-suggested model/variant.
        if (esc?.retryable && job?.autoRetry && !job.autoRetriedAs && retryChainDepth(jobCwd, job) < maxAutoRetries(loadConfig())) {
          try {
            // Mark the original failed BEFORE re-delegating: retryOf only
            // accepts failed/cancelled targets.
            markJobBySession(jobCwd, args.sessionID, () => ({
              status: "failed",
              errorMessage: outcome.info.error?.data?.message ?? "unknown error",
              completedAt: new Date().toISOString(),
            }));
            const retried = await toolDelegate({
              task: job.task ?? args.task ?? undefined,
              cwd,
              ...(esc.suggestModel ? { model: esc.suggestModel } : {}),
              effort: esc.suggestVariant ?? "max",
              ...(account ? { account } : {}),
              retryOf: job.id,
              ...(autoRetry ? { autoRetry: true } : {}),
            });
            markJobBySession(jobCwd, args.sessionID, () => ({
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

        markJobBySession(jobCwd, args.sessionID, () => ({
          status: "failed",
          errorMessage: outcome.info.error?.data?.message ?? "unknown error",
          completedAt: new Date().toISOString(),
        }));
      } else {
        // Honest-failure gate: a builder session that went idle WITHOUT any
        // assistant output even after the zombie nudges is not a completion.
        // Surface it as a retryable EmptyOutput error so the existing
        // auto-retry/escalation machinery can recover (reviewer sessions are
        // exempt: their deliverable is .oc-report.md on disk, not chat text).
        const emptyOutput =
          job?.type === "delegate" &&
          (job.persona ?? "builder") !== "reviewer" &&
          !outcome?.text &&
          !outcome?.info?.error;
        if (emptyOutput) {
          const emptyReason =
            "EmptyOutput: session went idle without producing any assistant output (nudges exhausted)";
        if (job?.autoRetry && !job.autoRetriedAs && retryChainDepth(jobCwd, job) < maxAutoRetries(loadConfig())) {
          try {
            // Mark the original failed BEFORE re-delegating: retryOf only
            // accepts failed/cancelled targets.
            markJobBySession(jobCwd, args.sessionID, () => ({
              status: "failed",
              errorMessage: emptyReason,
              completedAt: new Date().toISOString(),
            }));
            const retried = await toolDelegate({
              task: job.task ?? undefined,
              cwd,
              effort: "max",
              ...(account ? { account } : {}),
              retryOf: job.id,
              autoRetry: true,
            });
            markJobBySession(jobCwd, args.sessionID, () => ({
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
                reason: emptyReason,
                originalError: { name: "EmptyOutput" },
              };
            } catch {
              // fall through to the plain failed marking below
            }
          }
          markJobBySession(jobCwd, args.sessionID, () => ({
            status: "failed",
            errorMessage: emptyReason,
            completedAt: new Date().toISOString(),
          }));
        } else {
          markJobBySession(jobCwd, args.sessionID, () => ({
            status: "completed",
            completedAt: new Date().toISOString(),
            ...(Number.isFinite(outcome?.info?.cost) ? { cost: outcome.info.cost } : {}),
          }));
        }
      }
      const emptyIdleFailed =
        job?.type === "delegate" &&
        (job.persona ?? "builder") !== "reviewer" &&
        !outcome?.text &&
        !outcome?.info?.error;
      activitySink.note(
        jobCwd,
        args.sessionID,
        "wait",
        outcome?.info?.error
          ? `failed — ${outcome.info.error?.data?.message ?? "unknown error"}`
          : emptyIdleFailed
            ? "idle with EMPTY output (EmptyOutput)"
            : `idle — cost=${outcome?.info?.cost ?? 0}`
      );
      if (outcome?.info?.error) {
        emitLog("warning", `session ${shortId(args.sessionID)} failed — ${outcome.info.error?.data?.message ?? "unknown error"}`, { force: true });
      } else {
        emitLog("info", `session ${shortId(args.sessionID)} idle — cost=${outcome?.info?.cost ?? 0}`, { force: true });
      }
      const report =
        !outcome?.info?.error && !emptyIdleFailed && job
          ? readReportSnapshot(jobCwd, job.id)
          : null;
      return {
        status: "idle",
        sessionID: args.sessionID,
        jobId: job?.id ?? null,
        account,
        state,
        ...(report ? { report } : {}),
        error: outcome?.info?.error ?? (emptyIdleFailed ? { name: "EmptyOutput" } : null),
        ...(outcome?.info?.error
          ? { escalation: buildEscalation(outcome.info.error, loadConfig(), outcome.info.modelID) }
          : emptyIdleFailed
            ? { escalation: { retryable: true, reason: "session produced no output; re-delegate suggested" } }
            : {}),
        cost: outcome?.info?.cost ?? null,
        tokens: outcome?.info?.tokens ?? null,
        variant: outcome?.info?.variant ?? null,
        todos: await summarizeTodos(client, args.sessionID),
        response: outcome?.text ?? "",
      };
    }

    if (Date.now() >= deadline) {
      // Live progress: at deadline, attach a SHORT snapshot so auto-sliced
      // calls stay cheap for the supervisor's context window.
      const progress = await fetchAssistantOutcome(client, args.sessionID).catch(() => null);
      activitySink.note(jobCwd, args.sessionID, "wait", `timeout after ${timeoutSec}s — still busy`);
      const snapshot = {
        tail: progress?.text?.slice(-160) ?? "",
        reasoningTail: (watcher.reasoningText?.(args.sessionID) ?? "").slice(-160),
        tools: activitySink.recentTools(args.sessionID, 3),
        todos: await summarizeTodos(client, args.sessionID),
      };
      return {
        status: "timeout",
        sessionID: args.sessionID,
        jobId: job?.id ?? null,
        account,
        state,
        progress: snapshot,
        ...(autoSliced ? { sliced: true } : {}),
        nextStep:
          "the delegated session is STILL RUNNING server-side — nothing was lost; call wait {sessionID} again to keep supervising (each call streams the live feed / returns the next slice) until it reports idle",
      };
    }
    // Sleep the poll interval, but wake instantly when a session.idle SSE
    // event arrives for this session (watcher consumes /event already).
    await Promise.race([
      new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS)),
      watcher.waitForIdle(args.sessionID, WAIT_POLL_INTERVAL_MS).catch(() => false),
    ]);

    // Live progress frame (only when the caller passed a progressToken):
    // rich one-line feed straight from the in-memory activity buffer —
    // latest reasoning, newest tool call, assistant tail — shown by Claude
    // Code under the running wait call, like a classic subagent transcript.
    const liveSummary = activitySink.summary(args.sessionID);
    emit?.(
      `waiting ${shortId(args.sessionID)} — ${liveSummary || watcher.assistantText(args.sessionID).replace(/\s+/g, " ").trim().slice(-200) || "no assistant output yet"}`
    );
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
  const cwd = resolveCwd(args);
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

/**
 * Activity log viewer: tail the per-job activity log (assistant text,
 * reasoning, permission asks, lifecycle notes) for a delegated session.
 * Resolution order: jobId → sessionID → most recent delegate job.
 */
async function toolLogs(args) {
  const cwd = resolveCwd(args);
  const jobs = loadState(cwd).jobs ?? [];
  let job = null;
  if (args.jobId != null) {
    if (typeof args.jobId !== "string" || !args.jobId.trim()) {
      throw Object.assign(new Error("jobId must be a non-empty job id or prefix"), { code: "JOB_ID_INVALID" });
    }
    const exact = jobs.find((j) => j.id === args.jobId);
    const prefixMatches = jobs.filter((j) => j.id.startsWith(args.jobId));
    job = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);
    if (!job) {
      throw Object.assign(
        new Error(`jobId "${args.jobId}" matched ${prefixMatches.length} jobs; use the full id or a unique prefix`),
        { code: "JOB_NOT_FOUND" }
      );
    }
  } else if (args.sessionID != null) {
    const found = findJobRecord(cwd, args.sessionID);
    job = found.job;
  } else {
    job = [...jobs]
      .filter((j) => j.type === "delegate")
      .sort((a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime())[0] ?? null;
  }
  if (!job) {
    throw Object.assign(new Error("no delegate job found for this workspace yet"), { code: "LOGS_NO_JOBS" });
  }
  const lines = Math.min(Math.max(Number.isInteger(args.lines) ? args.lines : 80, 1), 400);
  // Primary source: the in-memory activity buffer of THIS server process
  // (zero files by default). Fallback: an opt-in file mirror written when
  // OPENCODE_ACTIVITY_LOG=1 was set for terminal follow sessions.
  let logLines = activitySink.tail(job.id, lines);
  let hasMirror = false;
  try {
    hasMirror = fs.statSync(jobLogPath(job.directory ?? cwd, job.id)).size > 0;
  } catch {}
  if (logLines.length === 0 && hasMirror) {
    logLines = tailLines(jobLogPath(job.directory ?? cwd, job.id), lines);
  }
  // Live tails straight from the SSE part tracker — only meaningful while the
  // session is still running, and only when its server is up (never spawn one
  // just to read logs).
  let assistantTail = "";
  let reasoningTail = "";
  if (job.status === "running") {
    try {
      const conn = await getConnection(job.directory ?? cwd, job.account ?? null);
      assistantTail = (conn.watcher.assistantText?.(job.sessionID) ?? "").slice(-800);
      reasoningTail = (conn.watcher.reasoningText?.(job.sessionID) ?? "").slice(-800);
    } catch {}
  }
  return {
    jobId: job.id,
    sessionID: job.sessionID ?? null,
    status: job.status ?? null,
    phase: job.phase ?? null,
    model: job.model ?? null,
    variant: job.variant ?? null,
    tier: job.tier ?? null,
    account: job.account ?? null,
    errorMessage: job.errorMessage ?? null,
    ...(hasMirror ? { logPath: jobLogPath(job.directory ?? cwd, job.id) } : {}),
    lines: logLines,
    live: { running: job.status === "running", assistantTail, reasoningTail },
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
  const waitFor = args.waitFor ?? null;
  if (
    waitFor != null &&
    (!Number.isInteger(waitFor) || waitFor < 1 || waitFor > ids.length)
  ) {
    throw Object.assign(
      new Error(`waitFor must be an integer between 1 and ${ids.length} (got ${JSON.stringify(args.waitFor)})`),
      { code: "WAIT_FOR_INVALID" }
    );
  }
  if (waitFor == null) {
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

  // Early-exit mode: return as soon as `waitFor` sessions reach a terminal
  // state (idle / needsInput / error). Per-session timeouts are retried in
  // later slices until the shared deadline is spent.
  const totalSec = args.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC;
  const deadline = Date.now() + totalSec * 1000;
  const collected = new Map();
  let pending = [...ids];
  while (pending.length > 0 && collected.size < waitFor && Date.now() < deadline) {
    const remainingSec = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const sliceSec = Math.min(10, remainingSec);
    const settled = await Promise.all(
      pending.map((sessionID) =>
        toolWait({ ...args, sessionID, timeoutSec: sliceSec }, meta).catch((err) => ({
          status: "error",
          sessionID,
          error: err?.message ?? String(err),
        }))
      )
    );
    const stillPending = [];
    for (const r of settled) {
      if (r.status === "timeout") {
        stillPending.push(r.sessionID);
      } else if (collected.size < waitFor || r.status !== "idle") {
        collected.set(r.sessionID, r);
      } else {
        // already have enough terminal sessions; drop extras
      }
    }
    pending = stillPending;
  }
  const results = ids.map((sessionID) =>
    collected.get(sessionID) ?? { status: "timeout", sessionID }
  );
  const summary = {
    total: results.length,
    idle: results.filter((r) => r.status === "idle").length,
    needsInput: results.filter((r) => r.status === "needsInput").length,
    timeout: results.filter((r) => r.status === "timeout").length,
    error: results.filter((r) => r.status === "error").length,
  };
  return {
    sessionIDs: ids,
    ...(waitFor != null ? { waitFor, partial: true } : {}),
    results,
    summary,
    // Long-horizon guarantee: a timeout entry means the shared deadline of THIS
    // waitAll call expired while that session is still executing server-side.
    // Nothing was cancelled — keep supervising; abort only on explicit request.
    ...(summary.timeout > 0
      ? {
          note: `${summary.timeout} session(s) still running past this call's deadline — nothing was cancelled. Re-issue waitAll (or wait per sessionID) until they report idle; kill only if the user explicitly asks.`,
        }
      : {}),
  };
}

async function toolRespond(args) {
  const cwd = resolveCwd(args);
  const client = await getClient(cwd, accountForSession(cwd, args.sessionID));
  const ok = await client.respondPermission(args.sessionID, args.permissionID, args.response);
  return { responded: Boolean(ok), permissionID: args.permissionID, response: args.response };
}

async function toolAbort(args) {
  const cwd = resolveCwd(args);
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
/**
 * Show what a delegated agent changed in the workspace: git diff --stat
 * against the HEAD snapshot recorded when the job was created, plus untracked
 * files. Read-only; works even when the session already finished or aborted.
 */
async function toolDiff(args) {
  if (!args.sessionID || typeof args.sessionID !== "string") {
    throw Object.assign(new Error('diff requires "sessionID"'), { code: "SESSION_ID_REQUIRED" });
  }
  const cwd = resolveCwd(args);
  let jobs;
  try {
    jobs = loadState(cwd).jobs ?? [];
  } catch {
    jobs = [];
  }
  const job = jobs.find((j) => j.type === "delegate" && j.sessionID === args.sessionID) ?? null;
  const result = diffSinceSnapshot(cwd, { base: job?.gitBase ?? null });
  return {
    sessionID: args.sessionID,
    jobId: job?.id ?? null,
    model: job?.model ?? null,
    status: job?.status ?? null,
    ...result,
  };
}

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
  if (args.cleanState != null && typeof args.cleanState !== "boolean") {
    throw Object.assign(new Error('shutdown: "cleanState" must be a boolean'), {
      code: "CLEAN_STATE_INVALID",
    });
  }
  const cwd = resolveCwd(args);
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

  // 5) opt-in disk hygiene: TTL sweep over stale state dirs, orphaned job
  // files and consumed .oc-report.md files (plugin-known workspaces only).
  const hygiene = args.cleanState === true ? await runHygieneSweep() : null;

  emitLog("info", `shutdown done — stopped ${stopped.length}, alreadyDead ${alreadyDead.length}, refused ${refused.length}, failed ${failed.length}${hygiene ? `, hygiene cleaned ${hygiene.removedDirs.length + hygiene.removedJobFiles.length + hygiene.removedReports.length} item(s)` : ""}`, { force: true });

  return {
    scope: scopeAll ? "all" : "workspace",
    ...(account ? { account } : {}),
    ...(deleteSessions ? { deletedSessions } : {}),
    ...(hygiene
      ? {
          hygiene: {
            removedDirs: hygiene.removedDirs.length,
            removedJobFiles: hygiene.removedJobFiles.length,
            removedTmpFiles: hygiene.removedTmpFiles.length,
            removedReports: hygiene.removedReports,
            errors: hygiene.errors,
          },
        }
      : {}),
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
        persona: { type: "string", enum: ["builder", "reviewer"], description: "builder (default): oc-delegate agent, may edit files. reviewer: read-only oc-reviewer agent that may only write .oc-report.md" },
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
      "Delegate MULTIPLE tasks in parallel with one call: same resolved model+variant for all, round-robin account rotation per task, shared fanOutId, optional per-task workspace (items may be strings or {task, cwd?} objects for cross-repo fan-out). Returns per-task jobId/sessionID; supervise the batch with waitAll.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", properties: { task: { type: "string" }, cwd: { type: "string", description: "Per-task workspace directory (absolute)" } }, required: ["task"] }] }, minItems: 1, maxItems: 12, description: "Task descriptions; objects add a per-task workspace for parallel delegation across different repos (same model+effort each)" },
        mode: { type: "string", enum: ["batch", "race"], description: "batch (default): return immediately, supervise with waitAll. race: first task to finish cleanly wins, all others are aborted to save quota" },
        timeoutSec: { type: "number", description: "race mode shared deadline seconds (default 600)" },
        cwd: { type: "string", description: "Workspace directory" },
        model: { type: "string", description: "Explicit model id (overrides tier)" },
        tier: { type: "number", description: "Tier 0-3 when no explicit model" },
        effort: { type: "string", enum: ["off", "high", "max"], description: "Effort request; default from effortPolicy" },
        account: { type: "string", description: 'OpenCode account for quota routing ("auto" default round-robin)' },
        agent: { type: "string", description: "OpenCode agent (default oc-delegate when injected, else build)" },
        persona: { type: "string", enum: ["builder", "reviewer"], description: "Agent persona for every task in the batch (default builder)" },
        titlePrefix: { type: "string", description: "Session title prefix (default Fanout)" },
      },
    },
  },
  {
    name: "wait",
    title: "Wait for session",
    description:
      "Poll a delegated session until it goes idle, needs input, or the timeout expires. WITHOUT an explicit timeoutSec the call auto-slices (60s): each slice returns a fresh activity snapshot (assistant tail, reasoning, tool calls) plus nextStep — call wait again until idle for a live subagent-style feed.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["sessionID"],
      properties: {
        sessionID: { type: "string" },
        cwd: { type: "string", description: "Workspace directory" },
        timeoutSec: { type: "number", description: "Default 600 when a progressToken is supplied; otherwise auto-slices every 60s" },
      },
    },
  },
  {
    name: "waitAll",
    title: "Wait for sessions",
    description:
      "Wait for MULTIPLE delegated sessions in parallel until each goes idle, needs input, or the shared timeout expires. Returns per-session outcomes plus counts. Optional waitFor:N returns early as soon as N sessions reach a terminal state (idle/needsInput/error).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      required: ["sessionIDs"],
      properties: {
        sessionIDs: { type: "array", items: { type: "string" }, description: "Up to 12 session ids" },
        cwd: { type: "string", description: "Workspace directory" },
        timeoutSec: { type: "number", description: "Default 600 (shared deadline)" },
        waitFor: {
          type: "integer",
          description:
            "Early exit once N sessions reach a terminal state (idle/needsInput/error); remaining sessions are reported as timeout",
        },
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
    name: "logs",
    title: "Delegation activity log",
    description:
      "Tail a delegation's activity log to SEE what the OpenCode agent is doing: streamed assistant output AND chain-of-thought reasoning, permission asks, lifecycle transitions. WITHOUT jobId/sessionID: the most recent delegate job. Also returns live reasoning/output tails for running sessions.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job id or unique prefix (overrides sessionID)" },
        sessionID: { type: "string", description: "Session id; omit both for the latest delegate job" },
        lines: { type: "integer", description: "How many log lines to tail (default 80, max 400)" },
        cwd: { type: "string", description: "Workspace directory" },
      },
    },
  },
  {
    name: "diff",
    title: "Agent workspace changes",
    description:
      "Show what a delegated agent changed in the workspace since its job started: git diff --stat against the HEAD snapshot recorded at delegation time plus untracked files. Read-only; works after completion or abort. Non-git workspaces report isRepo:false with the porcelain status note.",
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
        cleanState: { type: "boolean", description: "Also run the disk hygiene sweep: remove stale state dirs, orphaned job files and consumed .oc-report.md files (TTL-based, opt-in; runs automatically on every server boot)" },
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
  logs: toolLogs,
  diff: toolDiff,
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
  const cwd = resolveCwd(args);
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
      // `logging` advertises the notifications/message channel that renders in
      // Claude Code's MCP tab — without it the client never shows server logs.
      capabilities: { tools: {}, logging: {} },
      serverInfo: { name: "opencode-delegate", version: "1.0.0" },
    });
  }

  if (msg.method === "logging/setLevel") {
    if (!hasId) return null;
    const active = setLogLevel(msg.params?.level);
    emitLog("info", `log level set to "${active}"`, { force: true });
    return rpcResult(msg.id, { level: active });
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
        emitLog("warning", `unknown tool "${name}" requested`, { force: true });
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
      emitLog("error", `tool ${name} failed — ${err.message}${err.code ? ` (${err.code})` : ""}`, { force: true });
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
  setLogSink(writeMessage);
  emitLog("info", `opencode delegation server started (pid ${process.pid}, node ${process.version})`, { force: true });
  // Orphan sweep: shortly after boot, reap opencode servers orphaned by
  // previous crashed/closed sessions (identity-checked, idle+old only, busy
  // servers and long tasks are never touched). Fire-and-forget — stdout is
  // reserved for JSON-RPC, so results surface through doctor instead.
  setTimeout(() => {
    import("../scripts/lib/opencode-server.mjs")
      .then(({ reapStaleServers }) => reapStaleServers())
      .catch(() => {});
  }, 3000).unref();
  // Hygiene sweep: same boot window, TTL-based disk cleanup (stale state dirs,
  // orphaned job files, consumed .oc-report.md). Repeats hourly so a
  // long-lived server session never lets dirt accumulate. Fire-and-forget.
  const HYGIENE_BOOT_DELAY_MS = 4000;
  const HYGIENE_INTERVAL_MS = 60 * 60 * 1000;
  const hygieneTimer = setInterval(() => {
    runHygieneSweep().catch(() => {});
  }, HYGIENE_INTERVAL_MS);
  hygieneTimer.unref?.();
  setTimeout(() => {
    runHygieneSweep().catch(() => {});
  }, HYGIENE_BOOT_DELAY_MS).unref();
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

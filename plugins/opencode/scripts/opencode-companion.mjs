#!/usr/bin/env node

// OpenCode Companion - Main entry point for the Claude Code plugin.
// Mirrors the codex-plugin-cc codex-companion.mjs architecture but uses
// OpenCode's HTTP REST API instead of JSON-RPC over stdin/stdout.

import path from "node:path";
import process from "node:process";
import fs from "node:fs";

import { parseArgs, extractTaskText } from "./lib/args.mjs";
import { isOpencodeInstalled, getOpencodeVersion, spawnDetached } from "./lib/process.mjs";
import { isServerRunning, ensureServer, createClient, connect, derivePort } from "./lib/opencode-server.mjs";
import { resolveWorkspace } from "./lib/workspace.mjs";
import { loadState, updateState, upsertJob, generateJobId, jobDataPath } from "./lib/state.mjs";
import { buildStatusSnapshot, resolveResultJob, resolveCancelableJob, enrichJob, buildCostSnapshot } from "./lib/job-control.mjs";
import { createJobRecord, runTrackedJob, getClaudeSessionId } from "./lib/tracked-jobs.mjs";
import { renderStatus, renderResult, renderReview, renderSetup, renderCost } from "./lib/render.mjs";
import { buildReviewPrompt, buildTaskPrompt } from "./lib/prompts.mjs";
import { getDiff, getStatus as getGitStatus } from "./lib/git.mjs";
import { readJson, writeJson } from "./lib/fs.mjs";
import {
  validateModelConfig,
  listSelectableModels,
  addModel,
  setModel,
  setEffort,
  describeChanges,
} from "../mcp/lib/model-config.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");
const MODELS_CONFIG_PATH = path.join(PLUGIN_ROOT, "config", "models.json");

// ------------------------------------------------------------------
// Subcommand dispatch
// ------------------------------------------------------------------

const [subcommand, ...argv] = process.argv.slice(2);

const handlers = {
  setup: handleSetup,
  review: handleReview,
  "adversarial-review": handleAdversarialReview,
  task: handleTask,
  "task-worker": handleTaskWorker,
  "task-resume-candidate": handleTaskResumeCandidate,
  status: handleStatus,
  cost: handleCost,
  model: handleModel,
  result: handleResult,
  cancel: handleCancel,
};

const handler = handlers[subcommand];
if (!handler) {
  console.error(`Unknown subcommand: ${subcommand}`);
  console.error(`Available: ${Object.keys(handlers).join(", ")}`);
  process.exit(1);
}

handler(argv).catch((err) => {
  console.error(`Error in ${subcommand}: ${err.message}`);
  process.exit(1);
});

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
  });

  const installed = await isOpencodeInstalled();
  const version = installed ? await getOpencodeVersion() : null;

  // Resolve the workspace up front so the server probe and provider listing
  // hit the same derived port ensureServer() uses for this cwd (CA-16).
  const workspace = await resolveWorkspace();
  const port = derivePort(workspace);

  let serverRunning = false;
  let providers = [];

  if (installed) {
    serverRunning = await isServerRunning(undefined, port);

    if (serverRunning) {
      try {
        const client = createClient(`http://127.0.0.1:${port}`);
        const providerList = await client.listProviders();
        if (Array.isArray(providerList)) {
          providers = providerList.map((p) => p.id ?? p.name).filter(Boolean);
        }
      } catch {
        // Server may not be fully ready
      }
    }
  }

  // Handle review gate toggle
  let reviewGate = false;

  if (options["enable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = true;
    });
    reviewGate = true;
  } else if (options["disable-review-gate"]) {
    updateState(workspace, (state) => {
      state.config = state.config || {};
      state.config.reviewGate = false;
    });
    reviewGate = false;
  } else {
    const state = loadState(workspace);
    reviewGate = state.config?.reviewGate ?? false;
  }

  const status = { installed, version, serverRunning, providers, reviewGate };

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(renderSetup(status));
  }
}

// ------------------------------------------------------------------
// Review
// ------------------------------------------------------------------

async function handleReview(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["base", "scope"],
    booleanOptions: ["wait", "background"],
  });

  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "review", { base: options.base });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating review session...");
      const session = await client.createSession({ title: `Code Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: false,
      }, PLUGIN_ROOT);

      report("reviewing", "Running review...");
      log(`Prompt length: ${prompt.length} chars`);

      const response = await client.sendPrompt(session.id, prompt, {
        agent: "plan", // read-only agent for reviews
      });

      report("finalizing", "Processing review output...");

      // Try to parse structured output
      const text = extractResponseText(response);
      let structured = tryParseJson(text);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Review failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleAdversarialReview(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["base", "scope"],
    booleanOptions: ["wait", "background"],
  });

  const focus = positional.join(" ").trim();
  const workspace = await resolveWorkspace();
  const job = createJobRecord(workspace, "adversarial-review", {
    base: options.base,
    focus,
  });

  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      report("reviewing", "Creating adversarial review session...");
      const session = await client.createSession({ title: `Adversarial Review ${job.id}` });
      upsertJob(workspace, { id: job.id, opencodeSessionId: session.id });

      const prompt = await buildReviewPrompt(workspace, {
        base: options.base,
        adversarial: true,
        focus,
      }, PLUGIN_ROOT);

      report("reviewing", "Running adversarial review...");
      log(`Prompt length: ${prompt.length} chars, focus: ${focus || "(none)"}`);

      const response = await client.sendPrompt(session.id, prompt, {
        agent: "plan",
      });

      report("finalizing", "Processing review output...");

      const text = extractResponseText(response);
      let structured = tryParseJson(text);

      return {
        rendered: structured ? renderReview(structured) : text,
        raw: response,
        structured,
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Adversarial review failed: ${err.message}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// Task (rescue delegation)
// ------------------------------------------------------------------

async function handleTask(argv) {
  const { options, positional } = parseArgs(argv, {
    valueOptions: ["model", "agent"],
    booleanOptions: ["write", "background", "wait", "resume-last", "fresh"],
  });

  const taskText = extractTaskText(argv, ["model", "agent"], [
    "write", "background", "wait", "resume-last", "fresh",
  ]);

  if (!taskText) {
    console.error("No task text provided.");
    process.exit(1);
  }

  const workspace = await resolveWorkspace();
  const isWrite = options.write !== undefined ? options.write : true;
  const agentName = options.agent ?? (isWrite ? "build" : "plan");

  // Check for resume
  let resumeSessionId = null;
  if (options["resume-last"]) {
    const state = loadState(workspace);
    const sessionId = getClaudeSessionId();
    const lastTask = state.jobs
      ?.filter((j) => j.type === "task" && j.opencodeSessionId)
      ?.filter((j) => !sessionId || j.sessionId === sessionId)
      ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

    if (lastTask?.opencodeSessionId) {
      resumeSessionId = lastTask.opencodeSessionId;
    }
  }

  const job = createJobRecord(workspace, "task", {
    agent: agentName,
    resumeSessionId,
    model: options.model ?? null,
  });

  // Background mode: spawn a detached worker
  if (options.background) {
    const workerArgs = [
      path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs"),
      "task-worker",
      "--job-id", job.id,
      "--workspace", workspace,
      "--task-text", taskText,
      "--agent", agentName,
    ];
    if (isWrite) workerArgs.push("--write");
    if (resumeSessionId) workerArgs.push("--resume-session", resumeSessionId);
    if (options.model) workerArgs.push("--model", options.model);

    spawnDetached("node", workerArgs, { cwd: workspace });
    console.log(`OpenCode task started in background: ${job.id}`);
    console.log("Check `/opencode:status` for progress.");
    return;
  }

  // Foreground mode
  try {
    const result = await runTrackedJob(workspace, job, async ({ report, log }) => {
      report("starting", "Connecting to OpenCode server...");
      const client = await connect({ cwd: workspace });

      let sessionId;
      if (resumeSessionId) {
        report("starting", `Resuming OpenCode session ${resumeSessionId}...`);
        sessionId = resumeSessionId;
      } else {
        report("starting", "Creating new OpenCode session...");
        const session = await client.createSession({ title: `Task ${job.id}` });
        sessionId = session.id;
      }
      upsertJob(workspace, { id: job.id, opencodeSessionId: sessionId });

      const prompt = buildTaskPrompt(taskText, { write: isWrite });

      report("investigating", "Sending task to OpenCode...");
      log(`Agent: ${agentName}, Model: ${options.model ?? "(default)"}, Write: ${isWrite}, Prompt: ${prompt.length} chars`);

      const response = await client.sendPrompt(sessionId, prompt, {
        agent: agentName,
        model: options.model,
      });

      report("finalizing", "Processing task output...");

      const text = extractResponseText(response);

      // Get changed files if write mode
      let changedFiles = [];
      if (isWrite) {
        try {
          const diff = await client.getSessionDiff(sessionId);
          if (diff?.files) {
            changedFiles = diff.files.map((f) => f.path || f.name).filter(Boolean);
          }
        } catch {
          // diff endpoint may not be available
        }
      }

      return {
        rendered: text,
        messages: response,
        changedFiles,
        summary: text.slice(0, 500),
      };
    });

    console.log(result.rendered);
  } catch (err) {
    console.error(`Task failed: ${err.message}`);
    process.exit(1);
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["job-id", "workspace", "task-text", "agent", "model", "resume-session"],
    booleanOptions: ["write"],
  });

  const workspace = options.workspace;
  const jobId = options["job-id"];
  const taskText = options["task-text"];
  const agentName = options.agent ?? "build";
  const isWrite = !!options.write;
  const resumeSessionId = options["resume-session"];
  const modelName = options.model;

  if (!workspace || !jobId || !taskText) {
    process.exit(1);
  }

  try {
    await runTrackedJob(workspace, { id: jobId }, async ({ report, log }) => {
      report("starting", "Background worker connecting to OpenCode...");
      const client = await connect({ cwd: workspace });

      let sessionId;
      if (resumeSessionId) {
        sessionId = resumeSessionId;
        report("starting", `Resuming session ${resumeSessionId}...`);
      } else {
        const session = await client.createSession({ title: `Task ${jobId}` });
        sessionId = session.id;
        report("starting", `Created session ${sessionId}`);
      }
      upsertJob(workspace, { id: jobId, opencodeSessionId: sessionId });

      const prompt = buildTaskPrompt(taskText, { write: isWrite });
      report("investigating", `Running task... (agent: ${agentName}, model: ${modelName ?? "default"})`);

      const response = await client.sendPrompt(sessionId, prompt, {
        agent: agentName,
        model: modelName,
      });

      const text = extractResponseText(response);
      report("finalizing", "Done");

      return { rendered: text, summary: text.slice(0, 500) };
    });
  } catch (err) {
    // Error is already logged by runTrackedJob
    process.exit(1);
  }
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { booleanOptions: ["json"] });

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  const lastTask = state.jobs
    ?.filter((j) => j.type === "task" && j.opencodeSessionId)
    ?.filter((j) => j.status === "completed" || j.status === "running")
    ?.filter((j) => !sessionId || j.sessionId === sessionId)
    ?.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))?.[0];

  const result = {
    available: !!lastTask,
    jobId: lastTask?.id ?? null,
    opencodeSessionId: lastTask?.opencodeSessionId ?? null,
  };

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.available ? `Resumable session: ${result.opencodeSessionId}` : "No resumable session.");
  }
}

// ------------------------------------------------------------------
// Status / Result / Cancel
// ------------------------------------------------------------------

async function handleStatus(argv) {
  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  const sessionId = getClaudeSessionId();

  const snapshot = buildStatusSnapshot(state.jobs ?? [], workspace, { sessionId });
  console.log(renderStatus(snapshot));
}

async function handleCost(argv) {
  const workspace = await resolveWorkspace();
  const state = loadState(workspace);
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "config", "models.json"), "utf8"));
  } catch {
    // budget limits simply render as unset
  }
  const snapshot = buildCostSnapshot(state.jobs ?? [], config);
  console.log(renderCost(snapshot));
}

// ------------------------------------------------------------------
// Model wizard backend (used by /opencode:model)
// ------------------------------------------------------------------

function readModelsConfig() {
  return JSON.parse(fs.readFileSync(MODELS_CONFIG_PATH, "utf8"));
}

/**
 * `model list` — selectable catalog with tiers/variants/costs.
 */
async function handleModelList() {
  const config = readModelsConfig();
  let live = {};
  try {
    live = JSON.parse(process.env.OC_LIVE_MODELS || "{}");
  } catch {
    // no live overlay in wizard mode
  }
  const rows = listSelectableModels(config, live);
  if (rows.length === 0) {
    console.log("No models configured.");
    return;
  }
  for (const r of rows) {
    const flags = [r.isDefault ? "default" : null, r.isExcluded ? "excluded" : null]
      .filter(Boolean)
      .join(",");
    const cost =
      r.costIn === null && r.costOut === null
        ? "cost n/a"
        : `$${r.costIn ?? "?"}/Mtok in · $${r.costOut ?? "??"}/Mtok out`;
    console.log(
      `tier ${r.tier ?? "-"}  ${r.id}  variants=[${(r.variants ?? []).join(",")}]  ${cost}${flags ? `  (${flags})` : ""}`
    );
  }
}

function failModelOp(res) {
  console.error(`ERROR ${res.code}: ${res.reason}`);
  process.exitCode = 1;
}

/**
 * `model add <id> --tier N [--variants max,high] [--default] [--cost-in X] [--cost-out Y]`
 * `model set <id> [--tier N] [--variants ...] [--default] [--remove]`
 * `model effort global|tier:N|model:<id> <max|high|low|off>`
 * `model check` — validate models.json, print problems
 *
 * All mutations go through the pure model-config lib and are written back
 * atomically only when valid; the before/after diff is printed.
 */
async function handleModel(argv) {
  const op = argv[0];
  if (!op || op === "help") {
    console.log(
      [
        "Usage:",
        "  model list",
        "  model add <id> --tier N [--variants max,high] [--default] [--cost-in X] [--cost-out Y]",
        "  model set <id> [--tier N] [--variants a,b] [--default] [--remove]",
        "  model effort global|tier:N|model:<id> max|high|low|off",
        "  model check",
      ].join("\n")
    );
    return;
  }

  const { options, positional } = parseArgs(argv.slice(1), {
    valueOptions: ["tier", "variants", "cost-in", "cost-out"],
    booleanOptions: ["default", "remove"],
  });

  if (op === "check") {
    const problems = validateModelConfig(readModelsConfig());
    if (problems.length === 0) {
      console.log("config/models.json is valid.");
    } else {
      for (const p of problems) console.error(`- ${p}`);
      process.exitCode = 1;
    }
    return;
  }

  if (op === "list") {
    await handleModelList();
    return;
  }

  const before = readModelsConfig();
  const tierNum = options.tier != null && options.tier !== "" ? Number(options.tier) : undefined;
  const costIn = options["cost-in"] != null && options["cost-in"] !== "" ? Number(options["cost-in"]) : undefined;
  const costOut = options["cost-out"] != null && options["cost-out"] !== "" ? Number(options["cost-out"]) : undefined;
  const cost = costIn !== undefined || costOut !== undefined ? { input: costIn, output: costOut } : undefined;

  let res;
  if (op === "add") {
    const id = positional[0];
    if (!id) {
      console.error("ERROR: model id required (model add <id> --tier N ...)");
      process.exitCode = 1;
      return;
    }
    res = addModel(before, {
      id,
      tier: tierNum,
      variants: options.variants
        ? options.variants.split(",").map((v) => v.trim()).filter(Boolean)
        : undefined,
      cost,
      makeDefault: options.default === true,
    });
  } else if (op === "set") {
    const id = positional[0];
    if (!id) {
      console.error("ERROR: model id required (model set <id> ...)");
      process.exitCode = 1;
      return;
    }
    res = setModel(before, {
      id,
      ...(tierNum !== undefined ? { tier: tierNum } : {}),
      ...(options.variants
        ? { variants: options.variants.split(",").map((v) => v.trim()).filter(Boolean) }
        : {}),
      makeDefault: options.default === true,
      remove: options.remove === true,
    });
  } else if (op === "effort") {
    const scopeArg = positional[0] ?? "";
    const mode = positional[1] ?? "";
    let scope;
    if (scopeArg === "global") scope = { kind: "global" };
    else if (scopeArg.startsWith("tier:")) scope = { kind: "tier", tier: Number(scopeArg.slice(5)) };
    else if (scopeArg.startsWith("model:")) scope = { kind: "model", id: scopeArg.slice(6) };
    else {
      console.error("ERROR: scope must be global | tier:<N> | model:<id>");
      process.exitCode = 1;
      return;
    }
    res = setEffort(before, { scope, mode });
  } else {
    console.error(`Unknown model operation: ${op} (use list/add/set/effort/check/help)`);
    process.exitCode = 1;
    return;
  }

  if (!res.ok) {
    failModelOp(res);
    return;
  }

  const problems = validateModelConfig(res.config);
  if (problems.length > 0) {
    console.error("ERROR: operation would produce an invalid config:");
    for (const p of problems) console.error(`- ${p}`);
    console.error("Nothing written.");
    process.exitCode = 1;
    return;
  }

  writeJson(MODELS_CONFIG_PATH, res.config);
  console.log(`OK. Changes:`);
  for (const line of describeChanges(before, res.config)) console.log(`  ${line}`);
}

async function handleResult(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);

  const { job, ambiguous } = resolveResultJob(state.jobs ?? [], ref);

  if (ambiguous) {
    console.error("Ambiguous job reference. Please provide a more specific ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No finished job found.");
    return;
  }

  const enriched = enrichJob(job, workspace);

  // Try to load detailed result data
  const dataFile = jobDataPath(workspace, job.id);
  const resultData = readJson(dataFile);

  console.log(renderResult(enriched, resultData));
}

async function handleCancel(argv) {
  const { positional } = parseArgs(argv, {});
  const ref = positional[0];

  const workspace = await resolveWorkspace();
  const state = loadState(workspace);

  const { job, ambiguous } = resolveCancelableJob(state.jobs ?? [], ref);

  if (ambiguous) {
    console.error("Multiple running jobs. Please specify a job ID prefix.");
    process.exit(1);
  }

  if (!job) {
    console.log("No active job to cancel.");
    return;
  }

  // Abort the OpenCode session if we have one. MCP delegate jobs store the
  // session under `sessionID` instead of `opencodeSessionId`.
  const sessionId = job.opencodeSessionId ?? job.sessionID;
  if (sessionId) {
    try {
      const client = createClient(`http://127.0.0.1:${derivePort(workspace)}`);
      await client.abortSession(sessionId);
    } catch {
      // Server may not be running
    }
  }

  // Kill the process if we have a PID
  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Process may already be gone
    }
  }

  upsertJob(workspace, {
    id: job.id,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: "Canceled by user",
  });

  console.log(`Canceled job: ${job.id}`);
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Extract text from an OpenCode API response.
 * @param {any} response
 * @returns {string}
 */
function extractResponseText(response) {
  if (typeof response === "string") return response;

  // Response shape: { info: { ... }, parts: [ { type: "text", text: "..." }, ... ] }
  if (response?.parts) {
    return response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  // Fallback: try info.content or just stringify
  if (response?.info?.content) {
    if (typeof response.info.content === "string") return response.info.content;
    if (Array.isArray(response.info.content)) {
      return response.info.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
  }

  return JSON.stringify(response, null, 2);
}

/**
 * Try to parse a string as JSON, returning null on failure.
 * @param {string} text
 * @returns {object|null}
 */
function tryParseJson(text) {
  // Look for JSON in the text (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = jsonMatch ? jsonMatch[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}

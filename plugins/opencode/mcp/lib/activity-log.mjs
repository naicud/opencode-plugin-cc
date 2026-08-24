// In-memory activity buffer for delegated sessions. Captures what OpenCode
// does — reasoning, assistant output, tool-call transitions, permission asks,
// lifecycle notes — WITHOUT touching disk (unless OPENCODE_ACTIVITY_LOG=1
// opts into per-job log files).
//
// Consumers:
//   - the `logs` MCP tool (tail of the buffer, same server process)
//   - optional file mirror for terminal `oc-logs.mjs` follow sessions

import fs from "node:fs";
import { appendLine } from "../../scripts/lib/fs.mjs";
import { jobLogPath, stateBase } from "../../scripts/lib/state.mjs";

const MAX_LINES_PER_JOB = 300;
const MAX_LINE_CHARS = 600;
const MAX_PERSISTED_JOBS = 100;
const FLUSH_INTERVAL_MS = 10_000;
// How often a negative session→job lookup is retried (ms). Sessions get their
// job record at delegate time; events arriving earlier must not rescan disk.
const NEGATIVE_TTL_MS = 5000;
const FILE_MIRROR = process.env.OPENCODE_ACTIVITY_LOG === "1";

function bufferFile() {
  return path.join(stateBase(), "activity-buffer.json");
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function clean(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS);
}

/** Find the delegate job owning a session across every workspace state dir. */
function findJobForSession(sessionID) {
  let hashes = [];
  try {
    hashes = fs.readdirSync(stateBase());
  } catch {
    return null;
  }
  for (const h of hashes) {
    let jobs;
    try {
      jobs = JSON.parse(fs.readFileSync(path0(h), "utf8")).jobs ?? [];
    } catch {
      continue;
    }
    const hit = jobs.find((j) => j.sessionID === sessionID && typeof j.directory === "string");
    if (hit) return { cwd: hit.directory, jobId: hit.id };
  }
  return null;
}

import path from "node:path";
function path0(hash) {
  return path.join(stateBase(), hash, "state.json");
}

/**
 * Create an activity buffer bound to no particular workspace: it resolves the
 * owning job for each sessionID on demand and caches the mapping.
 */
export function createActivitySink() {
  /** @type {Map<string, string[]>} key (jobId AND sessionID) -> shared lines array */
  const buffers = new Map();
  /** @type {Map<string, number>} partKey -> chars already written */
  const emitted = new Map();
  /** @type {Set<string>} dedupe of identical tool-state transitions */
  const seenToolStates = new Set();
  /** @type {Map<string, { cwd: string, jobId: string }|null>} sessionID -> target */
  const targets = new Map();
  const misses = new Map(); // sessionID -> last failed lookup ts
  let loadedFromDisk = false;
  let dirty = false;
  let flushTimer = null;

  // ---- persistence: survive MCP server restarts --------------------------
  function flush() {
    if (!dirty) return;
    dirty = false;
    try {
      const jobs = {};
      let count = 0;
      for (const [key, arr] of buffers) {
        if (!key.startsWith("task-") && !key.startsWith("fanout-")) continue; // job ids only
        if (arr.length === 0) continue;
        jobs[key] = arr.slice(-MAX_LINES_PER_JOB);
        if (++count >= MAX_PERSISTED_JOBS) break;
      }
      fs.mkdirSync(stateBase(), { recursive: true });
      const tmp = `${bufferFile()}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), jobs }));
      fs.renameSync(tmp, bufferFile());
    } catch {
      // best-effort only
    }
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }

  function loadOnce() {
    if (loadedFromDisk) return;
    loadedFromDisk = true;
    try {
      const data = JSON.parse(fs.readFileSync(bufferFile(), "utf8"));
      for (const [jobId, lines] of Object.entries(data.jobs ?? {})) {
        if (buffers.has(jobId)) continue;
        const arr = Array.isArray(lines) ? lines.slice(-MAX_LINES_PER_JOB) : [];
        buffers.set(jobId, arr);
      }
    } catch {
      // first run or unreadable snapshot: start empty
    }
  }

  process.on("exit", () => {
    try {
      if (dirty) flush();
    } catch {}
  });

  function resolveTarget(sessionID) {
    if (targets.has(sessionID)) return targets.get(sessionID);
    const missAt = misses.get(sessionID);
    if (missAt && Date.now() - missAt < NEGATIVE_TTL_MS) return null;
    const found = findJobForSession(sessionID);
    if (found) {
      targets.set(sessionID, found);
      return found;
    }
    misses.set(sessionID, Date.now());
    return null;
  }

  function push(target, kind, text) {
    const body = clean(text);
    if (!body) return;
    const line = `[${stamp()}] [${kind}] ${body}`;
    let arr = buffers.get(target.jobId);
    if (!arr) {
      arr = [];
      buffers.set(target.jobId, arr);
    }
    arr.push(line);
    if (arr.length > MAX_LINES_PER_JOB * 2) arr.splice(0, arr.length - MAX_LINES_PER_JOB);
    scheduleFlush();
    if (FILE_MIRROR) {
      try {
        const logFile = jobLogPath(target.cwd, target.jobId);
        appendLine(logFile, line);
      } catch {}
    }
  }

  function bind(sessionID, target) {
    targets.set(sessionID, target);
    let arr = buffers.get(target.jobId);
    if (!arr) {
      arr = [];
      buffers.set(target.jobId, arr);
    }
    buffers.set(sessionID, arr);
  }

  function handleEvent(event) {
    if (event == null || typeof event.type !== "string") return;
    switch (event.type) {
      case "message.part.updated": {
        const props = event.properties ?? {};
        const part = props.part ?? {};
        const sessionID = props.sessionID ?? part.sessionID;
        if (!sessionID || typeof part !== "object") return;

        // Tool calls: record every state transition (pending/running/completed)
        // with the tool name and a short input summary — the OpenCode TUI's
        // "running bash…" style lines.
        if (part.type === "tool") {
          const status = part.state?.status ?? "unknown";
          const dedupeKey = `${sessionID}:${part.id ?? "?"}:${part.callID ?? "?"}:${status}`;
          if (seenToolStates.has(dedupeKey)) return;
          if (seenToolStates.size > 2000) seenToolStates.clear();
          seenToolStates.add(dedupeKey);
          const target = resolveTarget(sessionID);
          if (!target) return;
          bind(sessionID, target);
          let inputSummary = "";
          const input = part.state?.input;
          if (typeof input === "string" && input.trim()) inputSummary = input.slice(0, 160);
          else if (input && typeof input === "object") {
            inputSummary = JSON.stringify(input).slice(0, 160);
          }
          push(target, "tool", `${part.tool ?? part.name ?? "?"} (${status})${inputSummary ? ` ${inputSummary}` : ""}`);
          return;
        }

        if (typeof part.text !== "string") return;
        if (part.type !== "text" && part.type !== "reasoning") return;
        const key = `${sessionID}:${part.messageID ?? "?"}:${part.id ?? "?"}`;
        const already = emitted.get(key) ?? 0;
        if (part.text.length <= already) {
          if (!emitted.has(key)) emitted.set(key, part.text.length);
          return;
        }
        const delta = part.text.slice(already);
        emitted.set(key, part.text.length);
        if (emitted.size > 4000) emitted.clear(); // safety valve for long sessions
        const target = resolveTarget(sessionID);
        if (!target) return;
        bind(sessionID, target);
        push(target, part.type === "reasoning" ? "reasoning" : "assistant", delta);
        return;
      }
      case "permission.v2.asked": {
        const perm = event.properties ?? event;
        if (!perm?.sessionID) return;
        const target = resolveTarget(perm.sessionID);
        if (!target) return;
        bind(perm.sessionID, target);
        const meta = perm.metadata ?? {};
        push(
          target,
          "permission",
          `ASKED id=${perm.id} ${meta.command ?? (Array.isArray(perm.patterns) ? perm.patterns.join(" ") : perm.permission ?? "")}`
        );
        return;
      }
      case "session.error": {
        const props = event.properties ?? event;
        const sid = props?.sessionID ?? props?.info?.sessionID;
        if (!sid) return;
        const target = resolveTarget(sid);
        if (!target) return;
        push(target, "error", JSON.stringify(props?.info?.error ?? props?.error ?? "unknown"));
        return;
      }
      default:
        return; // session.idle etc. are logged as explicit notes by toolWait
    }
  }

  /**
   * Explicit lifecycle line. Safe to call with unknown sessions: silently
   * ignored when no job matches yet (retry later once the record exists).
   * @param {string} _cwd - unused hint kept for call-site compatibility
   * @param {string} sessionID
   * @param {string} kind
   * @param {string} message
   */
  function note(_cwd, sessionID, kind, message) {
    try {
      let target = targets.get(sessionID);
      if (!target) {
        target = findJobForSession(sessionID); // {cwd, jobId} | null
        if (!target) return;
        targets.set(sessionID, target);
      }
      bind(sessionID, target);
      push(target, kind, message);
    } catch {
      // never break supervision
    }
  }

  /**
   * Last n buffered lines for a jobId or sessionID. Falls back to the
   * persisted snapshot from a previous server process when the live buffer
   * has nothing (survives MCP restarts).
   * @returns {string[]}
   */
  function tail(key, n = 80) {
    let arr = buffers.get(key);
    if (!arr || arr.length === 0) {
      loadOnce();
      arr = buffers.get(key);
    }
    if (!arr || arr.length === 0) return [];
    return arr.slice(-Math.max(1, Math.min(n, MAX_LINES_PER_JOB)));
  }

  /**
   * Compact one-line summary for MCP progress frames: latest reasoning,
   * newest tool transition and assistant tail joined with separators.
   */
  function summary(sessionID) {
    const arr = buffers.get(sessionID);
    if (!arr || arr.length === 0) return "";
    let reasoning = "";
    let tool = "";
    let text = "";
    for (let i = arr.length - 1; i >= 0; i--) {
      const line = arr[i];
      if (!tool && line.includes("[tool]")) tool = line.replace(/^\[[\d:.]+\] \[\w+\] /, "");
      if (!reasoning && line.includes("[reasoning]")) reasoning = line.replace(/^\[[\d:.]+\] \[\w+\] /, "");
      if (!text && line.includes("[assistant]")) text = line.replace(/^\[[\d:.]+\] \[\w+\] /, "");
      if (reasoning && tool && text) break;
    }
    return [reasoning && `…${reasoning.slice(-140)}`, tool, text && `${text.slice(0, 140)}…`]
      .filter(Boolean)
      .join(" · ");
  }

  /**
   * Recent tool-call lines for a session (newest last), for progress payloads.
   * @returns {string[]}
   */
  function recentTools(sessionID, n = 5) {
    const arr = buffers.get(sessionID);
    if (!arr || arr.length === 0) return [];
    const tools = arr.filter((l) => l.includes("[tool]"));
    return tools.slice(-Math.max(1, Math.min(n, 12))).map((l) => l.replace(/^\[[\d:.]+\] /, ""));
  }

  return { handleEvent, note, tail, summary, recentTools, flush };
}

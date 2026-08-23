// Cross-platform process identity utilities for the OpenCode companion.
// Extracted from opencode-server.mjs so shutdown logic can verify a pid's
// command line before signalling it without depending on `ps` (which does not
// exist on Windows). Identity/refusal decisions stay with the CALLER; this
// module only answers "is it alive?", "what is it running?" and performs the
// mechanical stop sequence.

import { execFileSync } from "node:child_process";

/**
 * Check whether a process is alive using signal 0 (no signal actually sent).
 * A pid we lack permission to signal (EPERM) still counts as alive.
 * Non-positive or non-integer pids are never alive.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // alive but owned by another user
  }
}

/**
 * Read a process's full command line, cross-platform.
 * - win32: PowerShell CIM query (`ps` is unavailable).
 * - darwin/linux: `ps -p <pid> -o command=`.
 * Returns "" for dead processes, failures, or invalid pids.
 * @param {number} pid
 * @returns {string}
 */
export function getProcessCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    if (process.platform === "win32") {
      // NOTE: Windows branch has no CI coverage (no windows runner); accepted.
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { encoding: "utf8", timeout: 5000, windowsHide: true }
      );
      return out.trim();
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return "";
  }
}

/**
 * Decide whether a command line looks like an `opencode serve` invocation.
 * Stricter than the historical /\bopencode\b/ + /\bserve\b/ pair: --port must
 * be present and word boundaries prevent matching e.g. "openserve". All
 * matches are case-insensitive (Windows paths like C:\tools\OpenCode.EXE).
 * @param {string} commandLine
 * @returns {boolean}
 */
export function looksLikeOpcodeserve(commandLine) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return false;
  // NOTE: /\b--port\b/ can never match ("space" and "-" are both non-word
  // chars, so there is no word boundary); anchor the flag to whitespace/start.
  return (
    /\bopencode(\.exe|\.cmd)?\b/i.test(commandLine) &&
    /\bserve\b/i.test(commandLine) &&
    /(?:^|\s)--port\b/i.test(commandLine)
  );
}

/**
 * Mechanically stop a process tree leader: graceful signal, poll until
 * graceMs elapses, then SIGKILL fallback. Performs NO identity checking —
 * callers MUST verify the pid belongs to an opencode serve process first.
 * On win32 SIGTERM maps to TerminateProcess via Node, same flow applies.
 * @param {number} pid
 * @param {{ graceMs?: number, signal?: string }} [opts]
 * @returns {Promise<{ outcome: "stopped"|"alreadyDead"|"refused"|"failed", reason?: string }>}
 */
export async function stopProcessTree(pid, { graceMs = 5000, signal = "SIGTERM" } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!isProcessAlive(pid)) {
    return { outcome: "alreadyDead" };
  }
  try {
    process.kill(pid, signal);
  } catch {
    // lost the race with its own exit — fine
    return { outcome: "alreadyDead" };
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(200);
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // lost the race with its own exit — fine
    }
    await sleep(300);
  }
  return isProcessAlive(pid)
    ? { outcome: "failed", reason: `pid ${pid} survived SIGKILL` }
    : { outcome: "stopped" };
}

/**
 * One-handle adapter for callers (e.g. the opencode-server rewiring) that want
 * the platform-appropriate command reader plus the serve matcher together.
 * @returns {{ platform: string, commandFn: typeof getProcessCommand, matcher: typeof looksLikeOpcodeserve }}
 */
export function platformIdentityAdapter() {
  return {
    platform: process.platform,
    commandFn: getProcessCommand,
    matcher: looksLikeOpcodeserve,
  };
}

// Environment diagnostics for the OpenCode plugin ("doctor").
// runDiagnostics collects independent environment checks; every check captures
// its own error so a report object is always produced (never throws). The
// result is plain serializable data — formatDoctorReport renders it for
// humans / MCP tool content.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stateRoot, loadState } from "./state.mjs";
import { derivePort, isServerRunning, readServerRegistry, reapStaleServers } from "./opencode-server.mjs";
import { resolveOpencodeCommand } from "./opencode-bin.mjs";
import { envKeyName } from "../../mcp/lib/accounts.mjs";

const STATUS_TAG = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

/**
 * Run all plugin health checks and aggregate them into one report.
 * Never throws: each check catches its own error into a "fail" entry.
 * @param {object} [opts]
 * @param {string} [opts.cwd] - workspace path driving port derivation + state root
 * @param {object|null} [opts.config] - parsed models.json ({ accounts?: { names?: string[] }, ... })
 * @param {boolean} [opts.checkBinaries=true] - probe `opencode --version` on PATH
 * @returns {Promise<{ ok: boolean, platform: string, node: string, checks: Array<{name:string,status:"pass"|"warn"|"fail"|"skip",detail?:string}> }>}
 */
export async function runDiagnostics({ cwd = process.cwd(), config = null, checkBinaries = true } = {}) {
  const checks = [];
  const add = (name, status, detail) => {
    checks.push(detail == null ? { name, status } : { name, status, detail });
  };

  /**
   * Run one check body, converting any throw into a "fail" check result.
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  const guarded = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      add(name, "fail", err?.message ? String(err.message) : String(err));
    }
  };

  const accountNames = Array.isArray(config?.accounts?.names) ? config.accounts.names : [];

  // 1. opencode binary on PATH
  if (!checkBinaries) {
    add("opencode-binary", "skip");
  } else {
    await guarded("opencode-binary", () => {
      let version;
      try {
        const { command, prefix } = resolveOpencodeCommand();
        version = execFileSync(command, [...prefix, "--version"], { timeout: 8000, encoding: "utf8" }).trim();
      } catch (err) {
        if (err?.code === "ENOENT") throw new Error("opencode not found on PATH");
        throw err;
      }
      add("opencode-binary", "pass", version);
    });
  }

  // 2. node runtime version
  await guarded("node-version", () => {
    const major = Number.parseInt(String(process.versions.node).split(".")[0], 10);
    if (major >= 18) {
      add("node-version", "pass", `node ${process.version}`);
    } else if (major >= 16) {
      add("node-version", "warn", `node ${process.version} below supported 18.18`);
    } else {
      add("node-version", "fail", `node ${process.version} unsupported (need >=18.18)`);
    }
  });

  // 3. legacy basic-auth passthrough (informational)
  await guarded("auth-legacy", () => {
    if (process.env.OPENCODE_SERVER_PASSWORD) {
      add("auth-legacy", "pass", "OPENCODE_SERVER_PASSWORD set - basic-auth passthrough active");
    } else {
      add("auth-legacy", "pass", "OPENCODE_SERVER_PASSWORD not set (unauthenticated local servers assumed)");
    }
  });

  // 4. per-account delegate credentials
  await guarded("auth-accounts", () => {
    if (accountNames.length === 0) {
      add("auth-accounts", "pass", "no multi-account block (legacy mode)");
      return;
    }
    let have = 0;
    const parts = [];
    for (const name of accountNames) {
      const envVar = envKeyName(name);
      const value = process.env[envVar];
      const okKey = typeof value === "string" && value.trim() !== "";
      if (okKey) have += 1;
      parts.push(`${name}: ${okKey ? "key set" : `MISSING (expected env ${envVar})`}`);
    }
    const detail = parts.join("; ");
    if (have === accountNames.length) add("auth-accounts", "pass", detail);
    else if (have === 0) add("auth-accounts", "fail", detail);
    else add("auth-accounts", "warn", detail);
  });

  // 5. derived ports (workspace + per-account)
  await guarded("ports", async () => {
    const targets = [{ account: null, port: derivePort(cwd, null) }];
    for (const name of accountNames) targets.push({ account: name, port: derivePort(cwd, name) });
    const parts = [];
    let running = 0;
    for (const t of targets) {
      const up = await isServerRunning("127.0.0.1", t.port);
      if (up) running += 1;
      parts.push(`port ${t.port}: ${up ? "opencode healthy" : "free"}`);
    }
    const aggregate = running > 0 ? "server(s) running" : "all derived ports free";
    add("ports", "pass", `${parts.join("; ")} - ${aggregate}`);
  });

  // 6. server registry liveness + stale-entry cleanup
  await guarded("registry", () => {
    const entries = readServerRegistry(cwd);
    if (entries.length === 0) {
      add("registry", "pass", "no tracked servers");
      return;
    }
    const live = [];
    let removed = 0;
    for (const entry of entries) {
      let alive = false;
      try {
        process.kill(entry.pid, 0);
        alive = true;
      } catch (err) {
        alive = err?.code === "EPERM"; // alive but owned by another user
      }
      if (alive) {
        live.push(`pid ${entry.pid} (port ${entry.port}) still running - use shutdown tool`);
        continue;
      }
      try {
        fs.rmSync(path.join(stateRoot(cwd), "servers", `serve-${entry.port}.json`), { force: true });
        removed += 1;
      } catch {
        // unreadable/unremovable stale file: leave it, not worth failing over
      }
    }
    if (live.length > 0) {
      const extra = removed > 0 ? ` (removed ${removed} stale entr${removed === 1 ? "y" : "ies"})` : "";
      add("registry", "warn", `${live.join("; ")}${extra}`);
    } else {
      add("registry", "pass", `registry clean (removed ${removed} stale entries)`);
    }
  });

  // 6b. orphan reaper: kill idle opencode servers orphaned by crashed/closed
  // Claude sessions (identity-checked; busy/young servers are never touched).
  await guarded("orphan-reaper", async () => {
    const r = await reapStaleServers();
    if (r.reaped.length > 0) {
      add(
        "orphan-reaper",
        "pass",
        `reaped ${r.reaped.length} orphaned server(s): ${r.reaped.map((s) => `pid ${s.pid} port ${s.port}`).join(", ")}`
      );
    } else if (r.refused > 0) {
      add("orphan-reaper", "warn", `${r.refused} stale entr${r.refused === 1 ? "y" : "ies"} refused identity check — inspect manually`);
    } else {
      add("orphan-reaper", "pass", `no orphans (${r.scanned} tracked, ${r.removedDead} dead entries removed, ${r.skipped} active/young kept)`);
    }
  });

  // 7. state directory readable/writable
  await guarded("state-dir", () => {
    const root = stateRoot(cwd);
    fs.mkdirSync(root, { recursive: true });
    const state = loadState(cwd);
    if (!state || !Array.isArray(state.jobs)) {
      throw new Error(`state at ${root} malformed (missing jobs array)`);
    }
    add("state-dir", "pass", root);
  });

  // 8. disk hygiene preview: what the TTL reaper WOULD clean right now
  // (dry run — nothing is removed by doctor).
  await guarded("hygiene", async () => {
    const { sweepStateDirs } = await import("./hygiene.mjs");
    const p = sweepStateDirs({ dryRun: true });
    if (p.errors.length > 0) {
      add("hygiene", "warn", `sweep errors: ${p.errors.slice(0, 3).join("; ")}`);
      return;
    }
    const dirt =
      p.removedDirs.length + p.removedJobFiles.length + p.removedTmpFiles.length + p.removedReports.length;
    if (dirt === 0) {
      add("hygiene", "pass", `clean (${p.scanned} workspace dir(s), ${p.keptDirs} active kept)`);
    } else {
      add(
        "hygiene",
        "pass",
        `${dirt} item(s) past TTL will be cleaned on next sweep: ${p.removedDirs.length} state dir(s), ${p.removedJobFiles.length} job file(s), ${p.removedTmpFiles.length} tmp leftover(s), ${p.removedReports.length} .oc-report.md`
      );
    }
  });

  return {
    ok: !checks.some((c) => c.status === "fail"),
    platform: process.platform,
    node: process.version,
    checks,
  };
}

/**
 * Render a doctor report as human-readable multi-line text.
 * Deterministic: lines follow the checks array order.
 * Used later by a doctor MCP tool to render into tool content.
 * @param {{ ok: boolean, checks: Array<{name:string,status:string,detail?:string}> }} report
 * @returns {string}
 */
export function formatDoctorReport(report) {
  const list = Array.isArray(report.checks) ? report.checks : [];
  const bad = report.ok === false || list.some((c) => c.status === "fail");
  const lines = [`opencode plugin doctor — ${bad ? "PROBLEMS FOUND" : "ok"}`];
  for (const check of list) {
    const tag = STATUS_TAG[check.status] ?? String(check.status ?? "?").toUpperCase();
    lines.push(check.detail != null ? `[${tag}] ${check.name}: ${check.detail}` : `[${tag}] ${check.name}`);
  }
  return lines.join("\n");
}

// Platform-aware opencode CLI resolution.
// On Windows the npm-installed `opencode` is usually a .cmd shim, which Node
// refuses to spawn directly (and cannot be exec'd without a shell). Prefer a
// real .exe when one is on PATH; otherwise route through cmd.exe. POSIX keeps
// the plain binary name.
//
// Exports resolveOpencodeCommand() -> { command: string, prefix: string[] }:
//   spawn(command, [...prefix, ...opencodeArgs], opts)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let cached = null;

/**
 * Known npm-global shim locations, checked in order when `where.exe` comes up
 * empty (fresh CI runners occasionally race PATH refreshes).
 */
function npmGlobalCandidates() {
  const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
  return [
    path.join(appData, "npm", "opencode.cmd"),
    path.join(appData, "npm", "opencode.bat"),
    path.join(appData, "npm", "opencode"), // extensionless bash-style shim
  ];
}

export function resolveOpencodeCommand() {
  if (cached) return cached;
  const entry = { command: "opencode", prefix: [] };
  if (process.platform !== "win32") {
    cached = entry;
    return entry;
  }
  let lines = [];
  try {
    const out = execFileSync("where.exe", ["opencode"], { encoding: "utf8", windowsHide: true });
    lines = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    lines = [];
  }
  const exe = lines.find((l) => /\.exe$/i.test(l));
  const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l));
  let found = null;
  if (exe) {
    entry.command = exe;
    found = exe;
  } else if (shim) {
    entry.command = "cmd.exe";
    entry.prefix = ["/c", shim];
    found = shim;
  } else {
    // where.exe came up empty: probe the standard npm global bin dirs
    // directly before giving up.
    found =
      npmGlobalCandidates().find((p) => {
        try {
          return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch {
          return false;
        }
      }) ?? null;
    if (found) {
      entry.command = "cmd.exe";
      entry.prefix = ["/c", found];
    }
  }
  // Cache only successful resolutions so a PATH-refresh race (fresh CI
  // runners right after npm i -g) can heal on the next call instead of
  // being pinned to a failed lookup forever.
  if (found) cached = entry;
  return entry;
}

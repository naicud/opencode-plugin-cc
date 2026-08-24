// Platform-aware opencode CLI resolution.
// On Windows the npm-installed `opencode` is usually a .cmd shim, which Node
// refuses to spawn directly (and cannot be exec'd without a shell). Prefer a
// real .exe when one is on PATH; otherwise route through cmd.exe. POSIX keeps
// the plain binary name.
//
// Exports resolveOpencodeCommand() -> { command: string, prefix: string[] }:
//   spawn(command, [...prefix, ...opencodeArgs], opts)

import { execFileSync } from "node:child_process";

let cached = null;

export function resolveOpencodeCommand() {
  if (cached) return cached;
  const entry = { command: "opencode", prefix: [] };
  if (process.platform === "win32") {
    try {
      const out = execFileSync("where.exe", ["opencode"], { encoding: "utf8", windowsHide: true });
      const lines = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const exe = lines.find((l) => /\.exe$/i.test(l));
      const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l));
      if (exe) {
        entry.command = exe;
      } else if (shim) {
        entry.command = "cmd.exe";
        entry.prefix = ["/c", shim];
      }
      // nothing resolvable -> keep defaults; downstream will surface ENOENT
    } catch {
      // where.exe failed -> keep defaults; downstream will surface ENOENT
    }
  }
  cached = entry;
  return entry;
}

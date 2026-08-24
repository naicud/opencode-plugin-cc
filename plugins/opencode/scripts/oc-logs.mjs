#!/usr/bin/env node
// oc-logs: tail (and follow) a delegation's activity log from the terminal.
//
//   node oc-logs.mjs                       # latest delegate job
//   node oc-logs.mjs <jobId|sessionID>     # specific job (prefix ok)
//   node oc-logs.mjs -n 200                # more lines
//   node oc-logs.mjs -f                    # FOLLOW: live stream like the
//                                          # OpenCode TUI (reasoning, output,
//                                          # tool calls, permissions)
//   node oc-logs.mjs --cwd /path/to/repo   # other workspace
//
// Prints the resolved job header plus the last N lines of its activity log,
// streaming new lines as they land with -f until Ctrl-C.
//
// NOTE: the MCP server keeps its activity feed IN MEMORY (no files) unless it
// was launched with OPENCODE_ACTIVITY_LOG=1. Start Claude Code with that env
// set to use this terminal follower alongside a delegation.

import fs from "node:fs";
import { jobLogPath, loadState } from "./lib/state.mjs";
import { tailLines } from "./lib/fs.mjs";
import { getGitRoot } from "./lib/git.mjs";

function parseArgs(argv) {
  const out = { cwd: null, lines: 80, target: null, follow: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "-f" || a === "--follow") out.follow = true;
    else if (a === "-n" || a === "--lines") out.lines = Number.parseInt(argv[++i], 10);
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!a.startsWith("-")) out.target = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("usage: node oc-logs.mjs [--cwd dir] [-n lines] [-f] [jobId|sessionID]");
  process.exit(0);
}

const cwd = args.cwd ?? process.env.OC_LOGS_CWD ?? (await getGitRoot(process.cwd())) ?? process.cwd();
const jobs = (loadState(cwd).jobs ?? []).filter((j) => j.type === "delegate");

let job = null;
if (args.target) {
  job =
    jobs.find((j) => j.id === args.target) ??
    jobs.find((j) => j.id.startsWith(args.target)) ??
    jobs.find((j) => j.sessionID === args.target) ??
    null;
  if (!job) {
    console.error(`no delegate job matches "${args.target}" in ${cwd}`);
    process.exit(1);
  }
} else {
  job =
    [...jobs].sort(
      (a, b) => new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime()
    )[0] ?? null;
  if (!job) {
    console.error(`no delegate jobs recorded for ${cwd}`);
    process.exit(1);
  }
}

const logFile = jobLogPath(job.directory ?? cwd, job.id);
console.log(`job      ${job.id}`);
console.log(`session  ${job.sessionID ?? "?"}`);
console.log(`status   ${job.status ?? "?"} (${job.model ?? "?"}${job.variant ? `/${job.variant}` : ""})`);
console.log(`log      ${logFile}`);
console.log("─".repeat(72));

let offset = 0;
try {
  const size = fs.statSync(logFile).size;
  // Initial view: last N lines. Track the byte offset so follow mode only
  // prints what lands after this point.
  const initial = tailLines(logFile, Math.min(Math.max(args.lines, 1), 400));
  for (const line of initial) console.log(line);
  offset = size;
} catch {
  console.log("(no activity logged yet — live streaming starts when a session runs)");
}

if (!args.follow) process.exit(0);

// Follow mode: poll from the last byte offset and stream new lines live —
// the same reasoning/output/tool-call feed the OpenCode TUI renders.
console.log("─".repeat(72));
console.log("following… (Ctrl-C to stop)");
let buf = "";
setInterval(() => {
  try {
    const size = fs.statSync(logFile).size;
    if (size < offset) offset = 0; // rotated/truncated
    if (size === offset) return;
    const fd = fs.openSync(logFile, "r");
    const chunk = Buffer.alloc(size - offset);
    fs.readSync(fd, chunk, 0, chunk.length, offset);
    fs.closeSync(fd);
    offset = size;
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.log(line);
  } catch {
    // file not created yet / transient read error: keep polling
  }
}, 400).unref();

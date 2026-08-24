import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import { createPartTracker } from "../plugins/opencode/mcp/lib/part-tracker.mjs";
import { createActivitySink } from "../plugins/opencode/mcp/lib/activity-log.mjs";
import { upsertJob, jobLogPath } from "../plugins/opencode/scripts/lib/state.mjs";
import { handleRpcMessage, activitySink as serverSink } from "../plugins/opencode/mcp/server.mjs";

let tmpDir;
let cwd;

beforeEach(() => {
  tmpDir = createTmpDir();
  setupTestEnv(tmpDir);
  cwd = createTmpDir("oc-logs-ws");
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
  cleanupTmpDir(cwd);
});

function partEvent(sessionID, messageID, id, type, text) {
  return {
    type: "message.part.updated",
    properties: { sessionID, part: { sessionID, messageID, id, type, text } },
  };
}

describe("part-tracker reasoning", () => {
  it("accumulates text and reasoning separately per session", () => {
    const tracker = createPartTracker();
    tracker.handleEvent(partEvent("s1", "m1", "p1", "text", "Hello "));
    tracker.handleEvent(partEvent("s1", "m1", "p1", "text", "Hello world"));
    tracker.handleEvent(partEvent("s1", "m1", "r1", "reasoning", "thinking..."));
    tracker.handleEvent(partEvent("s1", "m1", "r1", "reasoning", "thinking hard..."));
    tracker.handleEvent(partEvent("s2", "m1", "p1", "text", "other session"));
    assert.equal(tracker.assistantText("s1"), "Hello world");
    assert.equal(tracker.reasoningText("s1"), "thinking hard...");
    assert.equal(tracker.assistantText("s2"), "other session");
    assert.equal(tracker.reasoningText("s2"), "");
  });

  it("ignores non-part events and non-text/reasoning part types", () => {
    const tracker = createPartTracker();
    tracker.handleEvent({ type: "session.idle" });
    tracker.handleEvent(partEvent("s1", "m1", "t1", "tool", "{}"));
    assert.equal(tracker.size(), 0);
  });
});

describe("activity sink (in-memory, no files by default)", () => {
  it("streams only the delta of streaming parts into the buffer", () => {
    const job = { id: "task-delta-1", sessionID: "sess-1", directory: cwd };
    upsertJob(cwd, job);
    const sink = createActivitySink();
    sink.handleEvent(partEvent("sess-1", "m1", "p1", "text", "line one."));
    sink.handleEvent(partEvent("sess-1", "m1", "p1", "text", "line one. line two"));
    sink.handleEvent(partEvent("sess-1", "m1", "p9", "reasoning", "pondering"));
    const lines = sink.tail("task-delta-1", 10);
    assert.match(lines[0], /\[assistant\] line one\.$/);
    assert.match(lines[1], /\[assistant\] line two$/); // only the new suffix
    assert.match(lines[2], /\[reasoning\] pondering$/);
    // resolvable by sessionID too (same shared array)
    assert.equal(sink.tail("sess-1", 10).length, 3);
    // nothing hit the disk
    assert.equal(fs.existsSync(jobLogPath(cwd, job.id)), false);
  });

  it("note() buffers lifecycle lines; unknown sessions are ignored silently", () => {
    const job = { id: "task-note-1", sessionID: "sess-2", directory: cwd };
    upsertJob(cwd, job);
    const sink = createActivitySink();
    sink.note(cwd, "sess-none", "wait", "should not land anywhere");
    sink.note(cwd, "sess-2", "wait", "idle — cost=0.5");
    const lines = sink.tail("task-note-1", 10);
    assert.ok(!lines.join("\n").includes("sess-none"));
    assert.match(lines[0], /\[wait\] idle — cost=0\.5$/);
  });

  it("permission asks are buffered with their subject", () => {
    const job = { id: "task-perm-1", sessionID: "sess-3", directory: cwd };
    upsertJob(cwd, job);
    const sink = createActivitySink();
    sink.handleEvent({
      type: "permission.v2.asked",
      properties: { id: "per_9", sessionID: "sess-3", permission: "bash", metadata: { command: "npm test" } },
    });
    const [line] = sink.tail("task-perm-1", 5);
    assert.match(line, /\[permission\] ASKED id=per_9 npm test$/);
  });

  it("tool-call state transitions are buffered once per status with input summary", () => {
    const job = { id: "task-tool-1", sessionID: "sess-5", directory: cwd };
    upsertJob(cwd, job);
    const sink = createActivitySink();
    const toolPart = (status, input) => ({
      type: "message.part.updated",
      properties: {
        sessionID: "sess-5",
        part: { sessionID: "sess-5", messageID: "m1", id: "t1", callID: "c1", type: "tool", tool: "bash", state: { status, input } },
      },
    });
    sink.handleEvent(toolPart("running", { command: "npm test" }));
    sink.handleEvent(toolPart("running", { command: "npm test" })); // same transition: deduped
    sink.handleEvent(toolPart("completed", { command: "npm test" }));
    const lines = sink.tail("task-tool-1", 10);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /\[tool\] bash \(running\) \{"command":"npm test"\}$/);
    assert.match(lines[1], /\[tool\] bash \(completed\) \{"command":"npm test"\}$/);
  });

  it("summary() builds a compact progress line for MCP frames", () => {
    const job = { id: "task-sum-1", sessionID: "sess-6", directory: cwd };
    upsertJob(cwd, job);
    const sink = createActivitySink();
    assert.equal(sink.summary("sess-6"), "");
    sink.handleEvent(partEvent("sess-6", "m1", "r1", "reasoning", "reading auth module first"));
    sink.handleEvent({
      type: "message.part.updated",
      properties: { sessionID: "sess-6", part: { sessionID: "sess-6", messageID: "m1", id: "t1", callID: "c1", type: "tool", tool: "bash", state: { status: "running", input: { command: "ls src" } } } },
    });
    sink.handleEvent(partEvent("sess-6", "m1", "p1", "text", "Found the bug"));
    const s = sink.summary("sess-6");
    assert.match(s, /reading auth module first/);
    assert.match(s, /bash \(running\)/);
    assert.match(s, /Found the bug/);
    assert.ok(!s.includes("[reasoning]")); // tags stripped for display
  });

  it("OPENCODE_ACTIVITY_LOG=1 mirrors the buffer to a per-job file", async () => {
    process.env.OPENCODE_ACTIVITY_LOG = "1";
    try {
      const { createActivitySink: fresh } = await import("../plugins/opencode/mcp/lib/activity-log.mjs?mirror=1");
      const job = { id: "task-mirror-1", sessionID: "sess-7", directory: cwd };
      upsertJob(cwd, job);
      const sink = fresh();
      sink.note(cwd, "sess-7", "delegate", "mirrored line");
      const content = fs.readFileSync(jobLogPath(cwd, job.id), "utf8").trim();
      assert.match(content, /\[delegate\] mirrored line$/);
    } finally {
      delete process.env.OPENCODE_ACTIVITY_LOG;
      cleanupTmpDir(tmpDir);
      setupTestEnv(tmpDir);
    }
  });
});

function rpc(name, args, id) {
  return handleRpcMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

describe("logs tool", () => {
  it("is exposed in tools/list", async () => {
    const res = await handleRpcMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = res.result.tools.map((t) => t.name);
    assert.ok(names.includes("logs"));
  });

  it("errors cleanly when no delegate jobs exist", async () => {
    const raw = await rpc("logs", { cwd }, 2);
    assert.equal(raw.result.isError, true);
    assert.match(raw.result.content[0].text, /LOGS_NO_JOBS/);
  });

  it("tails the latest delegate job from memory and resolves jobId prefixes", async () => {
    const job = { id: "task-tail-1", type: "delegate", status: "completed", sessionID: "sess-4", model: "x-preview-f-free", directory: cwd };
    upsertJob(cwd, job);
    serverSink.note(cwd, "sess-4", "assistant", "did the work");
    serverSink.note(cwd, "sess-4", "reasoning", "why I chose this");

    const def = await rpc("logs", { cwd }, 3);
    const parsed = JSON.parse(def.result.content[0].text);
    assert.equal(parsed.jobId, "task-tail-1");
    assert.equal(parsed.lines.length, 2);
    assert.ok(!("logPath" in parsed)); // no files by default

    const prefixed = await rpc("logs", { cwd, jobId: "task-tail" }, 4);
    const p2 = JSON.parse(prefixed.result.content[0].text);
    assert.equal(p2.jobId, "task-tail-1");
    assert.match(p2.lines[1], /\[reasoning\]/);
  });
});

// Tests for live progress: the SSE part tracker (message.part.updated →
// assistant text) and the MCP notifications/progress emitter used by
// wait/waitAll/fanOut-race when callers pass _meta.progressToken.

import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { createPartTracker } from "../plugins/opencode/mcp/lib/part-tracker.mjs";
import { buildProgressEmitter, setProgressNotifier } from "../plugins/opencode/mcp/server.mjs";

function partEvent(sessionID, messageID, id, text, type = "text") {
  return {
    type: "message.part.updated",
    properties: {
      sessionID,
      part: { type, text, messageID, id, sessionID },
    },
  };
}

test("tracker ignores non-part events and non-text parts", () => {
  const t = createPartTracker();
  t.handleEvent({ type: "session.idle", properties: { sessionID: "s1" } });
  t.handleEvent(partEvent("s1", "m1", "p1", "hello", "step-start"));
  t.handleEvent({ type: "message.part.updated", properties: {} });
  assert.equal(t.assistantText("s1"), "");
});

test("tracker accumulates text in insertion order and replaces same part", () => {
  const t = createPartTracker();
  t.handleEvent(partEvent("s1", "m1", "p1", "Hello"));
  t.handleEvent(partEvent("s1", "m2", "p2", " world"));
  assert.equal(t.assistantText("s1"), "Hello world");
  // streaming update of p1 replaces its stored text
  t.handleEvent(partEvent("s1", "m1", "p1", "HELLO"));
  assert.equal(t.assistantText("s1"), "HELLO world");
});

test("tracker isolates sessions and handles missing ids", () => {
  const t = createPartTracker();
  t.handleEvent(partEvent("s1", "m1", "p1", "one"));
  t.handleEvent({
    type: "message.part.updated",
    properties: { part: { type: "text", text: "no-session" } },
  });
  t.handleEvent(partEvent("s2", "m9", undefined, "two"));
  assert.equal(t.assistantText("s1"), "one");
  assert.equal(t.assistantText("s2"), "two");
  assert.equal(t.assistantText("s3"), "");
  assert.equal(t.size(), 2);
});

test("tracker caps stored parts at 500 dropping oldest", () => {
  const t = createPartTracker();
  for (let i = 0; i < 510; i++) {
    t.handleEvent(partEvent("sX", `m${i}`, `p${i}`, String(i)));
  }
  assert.equal(t.size(), 500);
  assert.ok(!t.assistantText("sX").includes(" 0 "), "oldest dropped");
  assert.ok(t.assistantText("sX").includes("509"), "newest kept");
});

test("emitter is null without token or notifier", () => {
  setProgressNotifier(undefined);
  assert.equal(buildProgressEmitter({}, { totalSec: 60 }), null);
  assert.equal(buildProgressEmitter({ progressToken: "tok" }, { totalSec: 60 }), null);
});

test("emitter emits first frame immediately then throttles", async () => {
  const frames = [];
  setProgressNotifier((msg) => frames.push(msg));
  process.env.OPENCODE_PROGRESS_INTERVAL_MS = "300";
  try {
    const emit = buildProgressEmitter({ progressToken: "tok-1" }, { totalSec: 60 });
    assert.ok(emit);
    assert.equal(emit("first"), true);
    assert.equal(emit("too-soon"), false);
    frames.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(emit("later"), true);
    assert.equal(frames.length, 1);
    const f = frames[0];
    assert.equal(f.jsonrpc, "2.0");
    assert.equal(f.method, "notifications/progress");
    assert.equal(f.params.progressToken, "tok-1");
    assert.equal(f.params.total, 60);
    assert.ok(f.params.progress >= 0 && f.params.progress <= 60);
    assert.equal(f.params.message, "later");
  } finally {
    delete process.env.OPENCODE_PROGRESS_INTERVAL_MS;
    setProgressNotifier(undefined);
  }
});

test("emitter clamps progress to total and truncates messages", () => {
  const frames = [];
  setProgressNotifier((msg) => frames.push(msg));
  try {
    const emit = buildProgressEmitter({ progressToken: "tok-2" }, { totalSec: 1 });
    emit("x".repeat(1000));
    const f = frames[0];
    assert.equal(f.params.progress, Math.min(1, f.params.progress));
    assert.ok(f.params.message.length <= 400);
    assert.equal(frames.length, 1);
  } finally {
    setProgressNotifier(undefined);
  }
});

test("emitter without totalSec omits total/progress bounds", () => {
  const frames = [];
  setProgressNotifier((msg) => frames.push(msg));
  try {
    const emit = buildProgressEmitter({ progressToken: "tok-3" });
    emit("tick");
    const f = frames[0];
    assert.equal(f.params.total, undefined);
    assert.ok(Number.isFinite(f.params.progress));
  } finally {
    setProgressNotifier(undefined);
  }
});

test("notifier throwing never propagates into the supervision loop", () => {
  setProgressNotifier(() => {
    throw new Error("broken stdout");
  });
  try {
    const emit = buildProgressEmitter({ progressToken: "tok-4" });
    assert.equal(emit("boom"), false);
  } finally {
    setProgressNotifier(undefined);
  }
});

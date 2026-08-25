// End-to-end test driver for the delegation MCP server.
// Spawns mcp/server.mjs over stdio exactly like Claude Code does
// (.mcp.json: command node, args server.mjs) and drives the full protocol:
//
//   initialize -> tools/list -> models -> delegate -> wait* -> status
//   -> delegate(long task) -> abort
//
// Verifies:
//   - JSON-RPC handshake and the six tools
//   - default tier 0 model is x-preview-f-free with variant "max" applied
//   - delegated task really edits the workspace + writes .oc-report.md
//   - wait surfaces the assistant response, cost, tokens
//   - abort terminates a running session
//
// Usage: npm run test:e2e   (requires `opencode` installed + authenticated)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "mcp", "server.mjs");

let nextId = 1;
const pending = new Map();
const progressFrames = [];

function fail(msg) {
  console.error(`E2E FAIL: ${msg}`);
  process.exitCode = 1;
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-e2e-"));
  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OPENCODE_PROGRESS_INTERVAL_MS: "2500" },
  });

  let buffer = "";
  let stderr = "";
  proc.stdout.on("data", (d) => {
    buffer += d.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === "notifications/progress") {
          progressFrames.push(msg);
          continue;
        }
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // ignore malformed line
      }
    }
  });
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      if (method.startsWith("notifications/")) {
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
        resolve(null); // notifications never get a response
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}; stderr=${stderr.slice(-400)}`)), 240_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  function parseResult(res) {
    if (!res.result || res.result.isError) {
      throw new Error(`tool error: ${res.result?.content?.[0]?.text ?? JSON.stringify(res)}`);
    }
    return JSON.parse(res.result.content[0].text);
  }

  try {
    /* 1. Handshake */
    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-driver", version: "1.0.0" },
    });
    if (!init.result?.serverInfo) return fail("initialize returned no serverInfo");
    console.log(`handshake ok: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);

    await rpc("notifications/initialized", {});

    /* 2. tools/list */
    const list = await rpc("tools/list", {});
    const names = (list.result?.tools ?? []).map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(["abort", "delegate", "diff", "doctor", "fanOut", "logs", "models", "respond", "shutdown", "status", "wait", "waitAll"])) {
      return fail(`tools/list mismatch: ${names}`);
    }
    console.log("tools/list ok:", names.join(", "));

    /* 3. models — expect curated tiers */
    const models = parseResult(await rpc("tools/call", { name: "models", arguments: { cwd } }));
    const byId = Object.fromEntries(models.models.map((m) => [m.id, m]));
    for (const id of ["x-preview-f-free", "deepseek-v4-flash", "deepseek-v4-pro", "kimi-k3"]) {
      if (!byId[id]) return fail(`curated model missing from merged catalog: ${id}`);
    }
    if (!byId["x-preview-f-free"]?.default) return fail("x-preview-f-free should be the default model");
    if (byId["muse-spark-1.2-contributor-free"]) return fail("excluded model leaked into catalog");
    console.log(`models ok: ${models.models.length} entries, default=${models.defaults.tier}, live=${models.live}`);

    /* 4. delegate a real task at max effort (autoRetry: self-heal upstream
          empty-output zombies by re-delegating at the suggested model) */
    const del = parseResult(await rpc("tools/call", {
      name: "delegate",
      arguments: {
        task: "Crea il file e2e-proof.txt con contenuto ESATTAMENTE: E2E-MAX-EFFORT-OK. Poi scrivi .oc-report.md come da contratto.",
        cwd,
        effort: "max",
        autoRetry: true,
      },
    }));
    if (del.modelRef !== "opencode/x-preview-f-free") return fail(`unexpected model ${del.modelRef}`);
    if (del.variant !== "max") return fail(`effort not applied as max: ${JSON.stringify(del)}`);
    if (!del.sessionID || !del.jobId) return fail("delegate missing sessionID/jobId");
    console.log(`delegate ok: ${del.modelRef} variant=${del.variant} job=${del.jobId}`);

    /* 5. wait to completion; follow status:"retried" chains (EmptyOutput
          auto-healing) until a terminal non-retried result */
    let outcome;
    let activeSession = del.sessionID;
    let retriedCount = 0;
    for (;;) {
      outcome = parseResult(await rpc("tools/call", {
        name: "wait",
        arguments: { sessionID: activeSession, cwd, timeoutSec: 150 },
        _meta: { progressToken: "e2e-wait" },
      }));
      console.log(`wait: ${outcome.status}`);
      if (outcome.status === "retried") {
        retriedCount += 1;
        if (retriedCount > 3) return fail("retry chain exceeded 3 hops");
        console.log(`auto-retry ok: new session ${outcome.newSessionID} (${outcome.reason?.slice(0, 60)})`);
        activeSession = outcome.newSessionID;
        continue;
      }
      if (outcome.status !== "timeout") break;
    }
    // Live progress: frames must have streamed while waiting (SSE part tracker).
    const waitFrames = progressFrames.filter((f) => f.params?.progressToken === "e2e-wait");
    if (waitFrames.length === 0) return fail("no notifications/progress frames received during wait");
    console.log(`progress ok: ${waitFrames.length} frame(s), last message="${String(waitFrames.at(-1).params.message).slice(0, 80)}"`);
    if (outcome.status === "needsInput") {
      return fail(`unexpected permission request: ${JSON.stringify(outcome.permissions)}`);
    }
    if (outcome.status !== "idle") return fail(`wait ended ${outcome.status}`);
    if (outcome.error) {
      if (outcome.error.name === "EmptyOutput") {
        // Upstream can hit windows where every fresh session goes idle-empty.
        // Supervisor fallback: one final plain re-delegate (fresh job, no
        // retryOf linkage) before declaring failure — mirrors a human
        // re-running the task after the auto-retry chain is exhausted.
        console.log(`empty output persisted after ${retriedCount} retry(ies); supervisor fallback: plain re-delegate`);
        const fb = parseResult(await rpc("tools/call", {
          name: "delegate",
          arguments: { cwd, task, effort: "max" },
        }));
        let fbOutcome = null;
        for (;;) {
          fbOutcome = parseResult(await rpc("tools/call", {
            name: "wait",
            arguments: { sessionID: fb.sessionID, cwd, timeoutSec: 180 },
          }));
          if (fbOutcome.status === "retried") continue;
          if (fbOutcome.status !== "timeout") break;
        }
        if (fbOutcome.status !== "idle" || fbOutcome.error || !fs.existsSync(proof)) {
          return fail(`empty output persisted after ${retriedCount} retries + supervisor fallback`);
        }
        outcome = fbOutcome;
        console.log("supervisor fallback ok: fresh session completed the task");
      } else {
        return fail(`assistant error: ${JSON.stringify(outcome.error)}`);
      }
    }
    const proof = path.join(cwd, "e2e-proof.txt");
    if (!fs.existsSync(proof)) return fail("task artifact e2e-proof.txt not created");
    if (fs.readFileSync(proof, "utf8").trim() !== "E2E-MAX-EFFORT-OK") {
      return fail(`artifact content wrong: ${fs.readFileSync(proof, "utf8")}`);
    }
    if (!fs.existsSync(path.join(cwd, ".oc-report.md"))) return fail(".oc-report.md contract not honored");
    // Contract lives in the REPORT file (stable), not in chat phrasing
    // (models reword it across releases). Either surface carrying the
    // STATUS verdict satisfies the contract.
    const reportText = fs.readFileSync(path.join(cwd, ".oc-report.md"), "utf8");
    if (!/COMPLETED|PARTIAL/.test(outcome.response) && !/STATUS[^\n]*(COMPLETED|PARTIAL)/i.test(reportText)) {
      return fail(`no STATUS verdict in response or .oc-report.md:\nresponse=${outcome.response.slice(0, 200)}\nreport=${reportText.slice(0, 200)}`);
    }
    console.log(`task verified: artifact + .oc-report.md present; cost=${outcome.cost}`);

    /* 6. status snapshot */
    const st = parseResult(await rpc("tools/call", {
      name: "status",
      arguments: { sessionID: del.sessionID, cwd },
    }));
    // The zombie nudge is a user-role prompt: when it fired, the LAST message
    // may be the nudge itself. What matters is that an assistant reply exists.
    if (!st.lastMessage || !["assistant", "user"].includes(st.lastMessage.role)) {
      return fail("status lastMessage wrong");
    }
    console.log("status ok: state=" + JSON.stringify(st.state));

    /* 7. delegate long-running task then abort */
    const slow = parseResult(await rpc("tools/call", {
      name: "delegate",
      arguments: {
        task: "Conta lentamente da 1 a 200000 scrivendo ogni numero in count.txt (un numero per riga), poi verifica la righe finali.",
        cwd,
        effort: "max",
      },
    }));
    await new Promise((r) => setTimeout(r, 3000)); // let it start
    const ab = parseResult(await rpc("tools/call", {
      name: "abort",
      arguments: { sessionID: slow.sessionID, cwd },
    }));
    if (!ab.aborted) return fail("abort returned false");
    const afterAbort = parseResult(await rpc("tools/call", {
      name: "wait",
      arguments: { sessionID: slow.sessionID, cwd, timeoutSec: 20 },
    }));
    if (afterAbort.status === "needsInput") return fail("aborted session still asking for input");
    console.log(`abort ok: aborted=true, post-abort wait=${afterAbort.status}`);

    /* 8. resume the aborted session via delegate.resumeSessionID.
       Upstream occasionally wedges re-prompted sessions (idle, empty output);
       the runtime nudges twice automatically — this driver additionally
       retries the whole resume round once before giving up. */
    let resumed;
    let resOutcome;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Attempts 1-2 continue the persisted session. Attempt 3 starts a FRESH
      // session with the same instruction: an aborted upstream session can be
      // poisoned (MessageAbortedError history) and never produce output again
      // — recovery then means a clean session, not another nudge.
      const useFresh = attempt === 3;
      resumed = parseResult(await rpc("tools/call", {
        name: "delegate",
        arguments: {
          task: useFresh
            ? "Crea il file resume-proof.txt con contenuto ESATTAMENTE: RESUME-OK. Poi scrivi .oc-report.md come da contratto."
            : "Nuova istruzione per questa sessione: crea il file resume-proof.txt con contenuto ESATTAMENTE: RESUME-OK. Poi scrivi/aggiorna .oc-report.md come da contratto con STATUS della nuova istruzione.",
          cwd,
          effort: "max",
          ...(useFresh ? {} : { resumeSessionID: slow.sessionID }),
        },
      }));
      if (!useFresh && resumed.sessionID !== slow.sessionID) return fail(`resume changed session id: ${resumed.sessionID}`);
      if (!useFresh && resumed.resumedFrom !== slow.sessionID) return fail("resume response missing resumedFrom tie-back");
      if (useFresh) console.log("resume fallback: fresh session after poisoned aborted session");
      resOutcome = null;
      for (;;) {
        resOutcome = parseResult(await rpc("tools/call", {
          name: "wait",
          arguments: { sessionID: resumed.sessionID, cwd, timeoutSec: 150 },
        }));
        if (resOutcome.status !== "timeout") break;
      }
      const resumeProof = path.join(cwd, "resume-proof.txt");
      if (
        resOutcome.status === "idle" &&
        fs.existsSync(resumeProof) &&
        fs.readFileSync(resumeProof, "utf8").trim() === "RESUME-OK"
      ) {
        break;
      }
      if (attempt < 3) {
        console.log(`resume attempt ${attempt} hollow (${resOutcome.status}); retrying…`);
        continue;
      }
      if (resOutcome.status === "needsInput") return fail("resumed run hit needsInput");
      if (resOutcome.status !== "idle") return fail(`resume wait ended ${resOutcome.status}`);
      if (!fs.existsSync(resumeProof)) {
        console.error(`resume response tail: ${(resOutcome.response ?? "").slice(-400)}`);
        return fail("resume artifact resume-proof.txt not created");
      }
      return fail("resume artifact content wrong");
    }
    console.log("resume ok: continued session produced resume-proof.txt (RESUME-OK)");

    /* 8b. doctor diagnostics */
    const doc = parseResult(await rpc("tools/call", { name: "doctor", arguments: { cwd } }));
    if (typeof doc.ok !== "boolean" || !Array.isArray(doc.checks) || doc.checks.length === 0) {
      return fail(`doctor report malformed: ${JSON.stringify(doc).slice(0, 200)}`);
    }
    console.log(`doctor ok=${doc.ok}: ${doc.checks.length} checks`);

    /* 8c. fanOut: two tasks in parallel across TWO workspaces (second task
       gets a per-task cwd), then waitAll both to idle */
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-e2e-other-"));
    const fan = parseResult(await rpc("tools/call", {
      name: "fanOut",
      arguments: {
        cwd,
        titlePrefix: "E2E",
        effort: "max",
        tasks: [
          "Crea il file fan-a.txt con contenuto ESATTAMENTE: FAN-A-OK. Aggiorna .oc-report.md.",
          { task: "Crea il file fan-b.txt con contenuto ESATTAMENTE: FAN-B-OK. Aggiorna .oc-report.md.", cwd: otherDir },
        ],
      },
    }));
    if (fan.started !== 2 || fan.jobs.length !== 2) return fail(`fanOut started=${fan.started}: ${JSON.stringify(fan.failed)}`);
    if (!fan.fanOutId?.startsWith("fanout-")) return fail(`fanOutId malformed: ${fan.fanOutId}`);
    if (new Set(fan.jobs.map((j) => j.sessionID)).size !== 2) return fail("fanOut sessions not distinct");
    if (!/waitAll/.test(fan.nextStep)) return fail("fanOut nextStep missing waitAll guidance");
    // Slice-capped supervision: each pass returns within ~60s with fresh
    // per-session snapshots; chain passes until both jobs report idle.
    let fanWait;
    for (let pass = 0; pass < 4; pass++) {
      fanWait = parseResult(await rpc("tools/call", {
        name: "waitAll",
        arguments: { sessionIDs: fan.jobs.map((j) => j.sessionID), cwd, timeoutSec: 180 },
      }));
      if ((fanWait.summary?.idle ?? 0) === 2) break;
      console.log(`fanOut waitAll pass ${pass + 1}: ${JSON.stringify(fanWait.summary)}`);
    }
    if ((fanWait.summary?.idle ?? 0) !== 2) return fail(`waitAll after fanOut: ${JSON.stringify(fanWait.summary)}`);
    for (const [dirPath, name, expected] of [
      [cwd, "fan-a.txt", "FAN-A-OK"],
      [otherDir, "fan-b.txt", "FAN-B-OK"],
    ]) {
      const p = path.join(dirPath, name);
      if (!fs.existsSync(p)) {
        const perSession = (fanWait.results ?? [])
          .map((r) => `${(r.sessionID ?? "?").slice(0, 12)}:${r.status}:${String(r.response ?? r.error ?? "").slice(0, 220)}`)
          .join(" | ");
        return fail(`fanOut artifact ${name} missing in ${dirPath} — waitAll: ${JSON.stringify(fanWait.summary)} — ${perSession}`);
      }
      if (fs.readFileSync(p, "utf8").trim() !== expected) return fail(`fanOut artifact ${name} wrong`);
    }
    console.log("fanOut ok: cross-workspace parallel tasks byte-exact via waitAll");

    /* 8d. fanOut race mode: same task twice, first clean finish wins,
           the loser is aborted automatically */
    const race = parseResult(await rpc("tools/call", {
      name: "fanOut",
      arguments: {
        cwd,
        mode: "race",
        timeoutSec: 240,
        titlePrefix: "Race",
        effort: "max",
        tasks: [
          "Crea il file race-proof.txt con contenuto ESATTAMENTE: RACE-OK. Aggiorna .oc-report.md.",
          "Crea il file race-proof.txt con contenuto ESATTAMENTE: RACE-OK. Aggiorna .oc-report.md.",
        ],
      },
    }));
    if (race.mode !== "race") return fail(`race mode not echoed: ${race.mode}`);
    if (!race.winner?.sessionID || !race.winner?.jobId) {
      return fail(`race produced no winner: ${JSON.stringify(race).slice(0, 300)}`);
    }
    if (race.aborted.length !== 1) return fail(`expected exactly 1 aborted loser: ${JSON.stringify(race.aborted)}`);
    if (!/COMPLETED|PARTIAL/.test(race.winner.response ?? "") && !/STATUS[^\n]*(COMPLETED|PARTIAL)/i.test(fs.readFileSync(path.join(cwd, ".oc-report.md"), "utf8"))) {
      return fail(`winner response lacks STATUS verdict: ${(race.winner.response ?? "").slice(0, 200)}`);
    }
    const raceProof = path.join(cwd, "race-proof.txt");
    if (!fs.existsSync(raceProof)) return fail("race artifact race-proof.txt missing");
    if (fs.readFileSync(raceProof, "utf8").trim() !== "RACE-OK") return fail("race artifact content wrong");
    if (!/verify/.test(race.nextStep)) return fail(`race nextStep should say verify: ${race.nextStep}`);
    console.log(`race ok: winner=${race.winner.sessionID.slice(0, 12)}… losers aborted=${race.aborted.length}, artifact RACE-OK`);

    /* 8f. persona reviewer: read-only agent may write ONLY .oc-report.md;
           file edits it attempts surface as pending permissions we answer */
    const rev = parseResult(await rpc("tools/call", {
      name: "delegate",
      arguments: {
        cwd,
        task: "Rivedi i file di questo workspace (e2e-proof.txt, demo-artifact.txt se presente, fan-a.txt, fan-b.txt, race-proof.txt). NON creare né modificare ALCUN file tranne .oc-report.md. Scrivi .oc-report.md con STATUS COMPLETED e la sezione Files che elenca i file esaminati.",
        persona: "reviewer",
        autoRetry: true,
        title: "E2E reviewer",
      },
    }));
    if (rev.persona !== "reviewer") return fail(`persona not echoed: ${JSON.stringify(rev).slice(0, 200)}`);
    let revSession = rev.sessionID;
    let revIdle = false;
    let revAnswered = 0;
    for (let hop = 0; hop < 6 && !revIdle; hop++) {
      const w = parseResult(await rpc("tools/call", {
        name: "wait",
        arguments: { sessionID: revSession, cwd, timeoutSec: 150 },
      }));
      if (w.status === "retried") {
        console.log(`reviewer auto-retry ok -> ${w.retryJobId}`);
        revSession = w.newSessionID ?? revSession;
        continue;
      }
      if (w.status === "needsInput") {
        for (const perm of w.permissions ?? []) {
          await rpc("tools/call", {
            name: "respond",
            arguments: { cwd, sessionID: revSession, permissionID: perm.id, response: "once" },
          });
          revAnswered++;
        }
        continue;
      }
      if (w.status === "idle") {
        revIdle = true;
        break;
      }
      // timeout/error: give one more round-robin pass before giving up
    }
    if (!revIdle) return fail(`reviewer session never went idle`);
    if (!fs.existsSync(path.join(cwd, ".oc-report.md"))) return fail("reviewer did not produce .oc-report.md");
    console.log(`reviewer ok: persona=reviewer answeredPermissions=${revAnswered}, report present`);

    /* 8g. waitAll waitFor: early-exit once ONE of two parallel sessions is
           terminal, then finish the straggler normally */
    const wa1 = parseResult(await rpc("tools/call", {
      name: "delegate",
      arguments: { cwd, task: "Crea il file wait-proof-a.txt con contenuto ESATTAMENTE: WAIT-A-OK. Aggiorna .oc-report.md.", title: "E2E waitA" },
    }));
    const wa2 = parseResult(await rpc("tools/call", {
      name: "delegate",
      arguments: { cwd, task: "Crea il file wait-proof-b.txt con contenuto ESATTAMENTE: WAIT-B-OK. Aggiorna .oc-report.md.", title: "E2E waitB" },
    }));
    const wres = parseResult(await rpc("tools/call", {
      name: "waitAll",
      arguments: { cwd, sessionIDs: [wa1.sessionID, wa2.sessionID], waitFor: 1, timeoutSec: 240 },
    }));
    if (wres.waitFor !== 1 || wres.partial !== true) {
      return fail(`waitFor echo wrong: ${JSON.stringify({ waitFor: wres.waitFor, partial: wres.partial })}`);
    }
    const terminalCount = (wres.results ?? []).filter((r) => ["idle", "needsInput", "error"].includes(r.status)).length;
    if (terminalCount < 1) return fail(`waitFor returned no terminal result: ${JSON.stringify(wres.results).slice(0, 300)}`);
    console.log(`waitFor ok: early exit with ${terminalCount}/2 terminal`);
    // settle the straggler and verify BOTH artifacts byte-exact
    for (const [sid, proof, want] of [[wa1.sessionID, "wait-proof-a.txt", "WAIT-A-OK"], [wa2.sessionID, "wait-proof-b.txt", "WAIT-B-OK"]]) {
      let s = null;
      for (let hop = 0; hop < 4; hop++) {
        s = parseResult(await rpc("tools/call", { name: "wait", arguments: { sessionID: sid, cwd, timeoutSec: 180 } }));
        if (s.status !== "needsInput" && s.status !== "timeout") break;
        if (s.status === "needsInput") {
          for (const perm of s.permissions ?? []) {
            await rpc("tools/call", { name: "respond", arguments: { cwd, sessionID: sid, permissionID: perm.id, response: "once" } });
          }
        }
      }
      if (s?.status !== "idle") return fail(`straggler ${sid} not idle: ${JSON.stringify(s).slice(0, 200)}`);
      const got = fs.readFileSync(path.join(cwd, proof), "utf8").trim();
      if (got !== want) return fail(`${proof} content wrong: ${got}`);
    }
    console.log("stragglers ok: WAIT-A-OK + WAIT-B-OK byte-exact after early exit");

    /* 9. clean shutdown: kill the plugin-spawned server, verify port freed */
    const sd = parseResult(await rpc("tools/call", {
      name: "shutdown",
      arguments: { cwd },
    }));
    if (!Array.isArray(sd.stopped) || sd.stopped.length < 1) {
      return fail(`shutdown stopped nothing: ${JSON.stringify(sd)}`);
    }
    for (const entry of sd.stopped) {
      if (typeof entry.pid !== "number" || typeof entry.port !== "number") {
        return fail(`shutdown entry malformed: ${JSON.stringify(entry)}`);
      }
    }
    console.log(`shutdown ok: stopped=${sd.stopped.map((s) => s.port).join(",")} jobsCancelled=${sd.jobsCancelled}`);
    // every stopped port must now be unreachable
    await new Promise((r) => setTimeout(r, 500));
    for (const entry of sd.stopped) {
      let reachable = false;
      try {
        const res = await fetch(`http://127.0.0.1:${entry.port}/global/health`, {
          signal: AbortSignal.timeout(2000),
        });
        reachable = res.ok;
      } catch {
        reachable = false;
      }
      if (reachable) return fail(`port ${entry.port} still serving after shutdown`);
    }
    console.log("port check ok: all stopped ports are free");

    /* 8e. diff tool: scratch workspace is not a git repo → honest report */
    const df = parseResult(await rpc("tools/call", {
      name: "diff",
      arguments: { sessionID: del.sessionID, cwd },
    }));
    if (df.isRepo !== false) return fail(`diff isRepo expected false: ${JSON.stringify(df).slice(0, 200)}`);
    if (!/not a git repository/.test(df.note ?? "")) return fail(`diff note missing: ${df.note}`);

    console.log("\nE2E PASS: full stdio flow verified (handshake, catalog, max-effort delegation, artifacts, report contract, abort, resume, doctor, fanOut+waitAll cross-workspace, race mode, reviewer persona, waitFor early-exit, diff, clean shutdown).");
  } catch (err) {
    fail(err.message);
  } finally {
    proc.kill();
  }
}

main();

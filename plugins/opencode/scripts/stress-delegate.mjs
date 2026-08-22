#!/usr/bin/env node
// Stress suite: real permission ask/deny flow, concurrent delegates,
// server kill + restart recovery. Uses live opencode models.
// Run: npm run test:stress

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { ensureServer, createClient } from "./lib/opencode-server.mjs";

const MODEL = { providerID: "opencode", modelID: "x-preview-f-free" };
const VARIANT = "max"; // user directive: ALWAYS max effort
let failures = 0;

function ok(name, cond, extra = "") {
  const mark = cond ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(client, sessionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const msgs = await client.getMessages(sessionId, {});
      const assistant = [...msgs].reverse().find((m) => m.info?.role === "assistant");
      const finished =
        assistant &&
        (assistant.parts ?? []).some((p) => p.type === "step-finish") &&
        !msgs.at(-1)?.parts?.some?.((p) => false);
      if (assistant && finished) {
        return {
          text: (assistant.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n"),
          error: assistant.info.error ?? null,
        };
      }
    } catch {}
    await sleep(3000);
  }
  return null;
}

async function waitForPendingPermission(client, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await client.listPermissions();
      if (Array.isArray(list) && list.length > 0) return list;
    } catch {}
    await sleep(2000);
  }
  return null;
}

function text(parts) {
  return (parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oc-stress-"));
  console.log("scratch:", cwd);

  // ---------------- STRESS 1: permission ask → once / reject ----------------
  console.log("\n== STRESS 1: permission flow (bash ask mode) ==");
  const { url } = await ensureServer({
    cwd,
    port: 4321,
    permissions: {
      edit: "allow",
      webfetch: "allow",
      bash: { "*": "ask", "echo *": "allow" },
    },
  });
  const client = createClient(url, { directory: cwd });

  // 1a. allowed pattern (echo *) must NOT generate a permission request
  const sEcho = await client.createSession({});
  await client.sendPromptAsync(sEcho.id, 'Esegui esattamente questo comando bash: echo ECHO-ALLOWED-OK', { model: MODEL, variant: VARIANT });
  await sleep(4000);
  const earlyPerms = await waitForPendingPermission(client, 15_000);
  ok("echo* auto-allowed (no pending)", earlyPerms === null || !earlyPerms.some((p) => p.sessionID === sEcho.id));
  const rEcho = await waitIdle(client, sEcho.id);
  ok("echo task completed", !!rEcho && rEcho.text.includes("ECHO-ALLOWED-OK"), rEcho ? "" : "timeout");

  // 1b. non-matching command → pending permission → respond "once" → executes
  const sOnce = await client.createSession({});
  await client.sendPromptAsync(sOnce.id, "Esegui esattamente questo comando bash: whoami", { model: MODEL, variant: VARIANT });
  let pending = await waitForPendingPermission(client);
  ok("whoami triggers pending permission", !!pending && pending.some((p) => p.sessionID === sOnce.id));
  if (pending) {
    const target = pending.find((p) => p.sessionID === sOnce.id);
    const res = await client.respondPermission(sOnce.id, target.id, "once");
    ok("respond once accepted", res === true || res === "true");
  }
  const rOnce = await waitIdle(client, sOnce.id);
  ok("approved command executed", !!rOnce && rOnce.text.length > 0 && !rOnce.text.includes("cannot"), rOnce ? "" : "timeout");

  // 1c. reject flow → session reaches idle, refuses the action
  const sRej = await client.createSession({});
  await client.sendPromptAsync(sRej.id, "Esegui esattamente questo comando bash: uname -a", { model: MODEL, variant: VARIANT });
  pending = await waitForPendingPermission(client);
  ok("uname triggers pending permission", !!pending && pending.some((p) => p.sessionID === sRej.id));
  if (pending) {
    const target = pending.find((p) => p.sessionID === sRej.id);
    await client.respondPermission(sRej.id, target.id, "reject");
  }
  const rRej = await waitIdle(client, sRej.id);
  ok("rejected task still reaches completion", !!rRej, rRej ? "refusal: " + rRej.text.slice(0, 60) : "timeout");
  ok("rejected command NOT executed", !!rRej && !rRej.text.includes("Darwin"), "");

  // ---------------- STRESS 2: concurrent delegates same cwd ----------------
  console.log("\n== STRESS 2: concurrent delegates ==");
  const tasks = [
    { f: "conc-a.txt", c: "CONCURRENT-A-OK", p: "Primo task" },
    { f: "conc-b.txt", c: "CONCURRENT-B-OK", p: "Secondo task" },
  ];
  const results = await Promise.all(
    tasks.map(async (t) => {
      const s = await client.createSession({});
      await client.sendPromptAsync(
        s.id,
        `Crea il file ${t.f} nella cwd con contenuto ESATTAMENTE: ${t.c}`,
        { model: MODEL, variant: VARIANT }
      );
      const r = await waitIdle(client, s.id);
      return { ...t, r };
    })
  );
  for (const t of results) {
    let content = "";
    try {
      content = fs.readFileSync(path.join(cwd, t.f), "utf8").trim();
    } catch {}
    ok(`${t.p}: artifact ${t.f}`, content === t.c, `got="${content.slice(0, 40)}"`);
    ok(`${t.p}: session finished`, !!t.r);
  }

  // ---------------- STRESS 3: kill server mid-run → restart → recovery ------
  console.log("\n== STRESS 3: kill + restart recovery ==");
  const sKill = await client.createSession({});
  await client.sendPromptAsync(
    sKill.id,
    "Conta lentamente da 1 a 20 (un numero per riga), poi scrivi DONE-KILL-TEST.",
    { model: MODEL, variant: VARIANT }
  );
  await sleep(8000); // let it go busy

  let killed = false;
  try {
    execSync('pkill -f "opencode.*serve.*4321"', { stdio: "pipe" });
    killed = true;
  } catch {}
  ok("server killed mid-run", killed);
  await sleep(1000);

  // Restart on the SAME port: watcher-style recovery expects reconnection
  spawn("opencode", ["serve", "--port", "4321", "--hostname", "127.0.0.1"], {
    detached: true,
    stdio: "ignore",
    cwd,
  }).unref();
  await sleep(6000);

  const rKill = await waitIdle(client, sKill.id, 240_000);
  ok("session recovered after server restart", !!rKill && rKill.text.includes("DONE-KILL-TEST"), rKill ? rKill.text.slice(0, 60) : "timeout");

  console.log(`\n${failures === 0 ? "ALL STRESS TESTS PASSED" : failures + " FAILURES"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("STRESS SUITE ERROR:", err.message);
  process.exit(1);
});

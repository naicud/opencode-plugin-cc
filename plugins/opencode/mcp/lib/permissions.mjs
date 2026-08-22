// Permission watcher: consumes GET /event SSE per active server and
// classifies incoming permission requests using ONLY the rules stored in
// models.json (RF-20). Auto-approvable requests are answered "always",
// blacklisted ones "reject", everything else lands in an in-memory pending
// queue that the `wait` tool surfaces as needsInput (RF-19).
//
// Event shape is the LIVE one (findings P5/P6): the OpenAPI schema
// (action/resources/save/source) does NOT match reality
// (permission/patterns/metadata/always/tool).

import { consumeSseStream } from "../../scripts/lib/opencode-server.mjs";

const RECONNECT_DELAY_MS = 2000; // RF-18

/**
 * Build the subject string matched against allow/deny rules.
 * @param {object} perm - live permission payload
 * @returns {string}
 */
export function permissionSubject(perm) {
  const meta = perm.metadata ?? {};
  if (typeof meta.command === "string") return meta.command;
  if (Array.isArray(perm.patterns) && perm.patterns.length > 0) return perm.patterns.join(" ");
  if (Array.isArray(perm.always) && perm.always.length > 0) return perm.always.join(" ");
  return "";
}

/**
 * Classify a permission request against configured rules.
 * @param {object} perm - live permission payload
 * @param {{ autoApprove?: string[], autoReject?: string[] }} rules - from models.json permissions
 * @returns {"always"|"reject"|null}
 */
export function classifyPermission(perm, rules = {}) {
  const subject = permissionSubject(perm);
  for (const rule of rules.autoReject ?? []) {
    try {
      if (new RegExp(rule).test(subject)) return "reject";
    } catch {}
  }
  for (const rule of rules.autoApprove ?? []) {
    try {
      if (new RegExp(rule).test(subject)) return "always";
    } catch {}
  }
  return null;
}

/**
 * Create an SSE permission watcher bound to a client.
 * @param {object} opts
 * @param {object} opts.client - OpenCode client (subscribeEvents + respondPermission)
 * @param {object} opts.config - models.json content (uses config.permissions)
 * @param {(info: { id: string, sessionID: string, action: string }) => void} [opts.onAuto]
 * @returns {{ start: () => void, stop: () => Promise<void>, pending: (sessionID?: string) => object[] }}
 */
export function createPermissionWatcher(opts) {
  const { client, config, onAuto } = opts;
  const rules = config.permissions ?? {};
  /** @type {Map<string, object>} */
  const pending = new Map();
  let running = false;
  let loopPromise = null;

  function handleEvent(event) {
    if (event?.type !== "permission.v2.asked") return;
    const perm = event.properties ?? event;
    if (!perm?.id || !perm?.sessionID) return;

    const verdict = classifyPermission(perm, rules);
    if (verdict) {
      pending.delete(perm.id);
      onAuto?.({ id: perm.id, sessionID: perm.sessionID, action: verdict });
      client
        .respondPermission(perm.sessionID, perm.id, verdict)
        .catch(() => {}); // never kill the watcher on a failed reply
      return;
    }
    pending.set(perm.id, perm);
  }

  function handleReply(event) {
    if (event?.type !== "permission.v2.replied") return;
    const props = event.properties ?? event;
    if (props?.id) pending.delete(props.id);
  }

  async function loop() {
    while (running) {
      try {
        const stream = await client.subscribeEvents();
        await consumeSseStream(stream, handleEvent);
      } catch {
        // server gone / network error: fall through to retry
      }
      // Drain replies we may have missed before reconnecting
      try {
        const list = await client.listPermissions(); // still-pending across sessions
        for (const p of list ?? []) {
          if (!pending.has(p.id)) pending.set(p.id, p);
        }
      } catch {}
      if (!running) break;
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loopPromise = loop().catch(() => {});
    },
    async stop() {
      running = false;
      await loopPromise;
    },
    /**
     * Pending permission requests, optionally filtered by session.
     * @param {string} [sessionID]
     * @returns {object[]}
     */
    pendingList(sessionID) {
      const all = [...pending.values()];
      return sessionID ? all.filter((p) => p.sessionID === sessionID) : all;
    },
    handleEvent,
    handleReply,
  };
}

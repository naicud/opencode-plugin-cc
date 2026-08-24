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
import { createPartTracker } from "./part-tracker.mjs";

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
 * @param {object|(() => object)} opts.config - models.json content, or a getter
 *   re-read on each event so config edits apply without restarting the MCP server
 * @param {(info: { id: string, sessionID: string, action: string }) => void} [opts.onAuto]
 * @returns {{ start: () => void, stop: () => Promise<void>, pending: (sessionID?: string) => object[] }}
 */
export function createPermissionWatcher(opts) {
  const { client, config: configOrGetter, onAuto, onEvent } = opts;
  const resolveRules =
    typeof configOrGetter === "function"
      ? () => {
          try {
            return configOrGetter()?.permissions ?? {};
          } catch {
            return {}; // unreadable config must not kill the watcher
          }
        }
      : () => configOrGetter?.permissions ?? {};
  /** @type {Map<string, object>} */
  const pending = new Map();
  /** @type {Map<string, Set<() => void>>} sessionID -> idle waiters */
  const idleWaiters = new Map();
  const partTracker = createPartTracker();
  let running = false;
  let loopPromise = null;

  function notifyIdle(sessionID) {
    const set = idleWaiters.get(sessionID);
    if (!set) return;
    idleWaiters.delete(sessionID);
    for (const fn of set) fn();
  }

  function handleIdle(event) {
    // Live event type from findings P6: session.idle fires when a session
    // finishes its turn. Used by the wait tool to wake instantly instead of
    // riding out the full poll interval.
    if (event?.type !== "session.idle") return;
    const sid = event.properties?.sessionID ?? event.properties?.info?.sessionID;
    if (sid) notifyIdle(sid);
  }

  function handleEvent(event) {
    if (event?.type !== "permission.v2.asked") return;
    const perm = event.properties ?? event;
    if (!perm?.id || !perm?.sessionID) return;

    const verdict = classifyPermission(perm, resolveRules());
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

  function dispatchEvent(event) {
    handleEvent(event);
    handleReply(event);
    handleIdle(event);
    partTracker.handleEvent(event);
    try {
      onEvent?.(event);
    } catch {}
  }

  async function loop() {
    while (running) {
      try {
        const stream = await client.subscribeEvents();
        await consumeSseStream(stream, dispatchEvent);
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
      for (const set of idleWaiters.values()) set.clear();
      idleWaiters.clear();
      await loopPromise;
    },
    /**
     * Latest accumulated assistant text for a session, from live
     * message.part.updated SSE events ("" when nothing streamed yet).
     */
    assistantText(sessionID) {
      return partTracker.assistantText(sessionID);
    },
    /**
     * Latest accumulated chain-of-thought reasoning for a session, from live
     * message.part.updated SSE events ("" when nothing streamed yet).
     */
    reasoningText(sessionID) {
      return partTracker.reasoningText(sessionID);
    },
    /**
     * Resolve true as soon as a session.idle SSE event arrives for the given
     * session, false when timeoutMs elapses first. Never throws.
     * @param {string} sessionID
     * @param {number} [timeoutMs]
     * @returns {Promise<boolean>}
     */
    waitForIdle(sessionID, timeoutMs = 5000) {
      return new Promise((resolve) => {
        let settled = false;
        const set = idleWaiters.get(sessionID) ?? new Set();
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          set.delete(finish);
          if (!set.size) idleWaiters.delete(sessionID);
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
        set.add(finish);
        idleWaiters.set(sessionID, set);
      });
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

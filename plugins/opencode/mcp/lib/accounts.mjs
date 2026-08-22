// Multi-account credential routing (quota amplification).
//
// Non-secret account NAMES live in models.json under "accounts"
// ({names[], strategy: "round-robin"|"fixed", default}). The secrets never
// touch the repo: each account resolves its OpenCode Zen API key from an env
// var following the convention OPENCODE_DELEGATE_KEY_<ACCOUNT> (uppercased,
// non-alphanumerics -> "_").
//
// Keys are injected into a per-account spawned server via OPENCODE_AUTH_CONTENT
// ({"<provider>": {"type":"api","key":"..."}}), which OpenCode reads BEFORE the
// shared ~/.local/share/opencode/auth.json (verified against upstream source).

import { loadState, updateState } from "../../scripts/lib/state.mjs";

/**
 * Env var name for an account's API key.
 * @param {string} accountName
 * @returns {string}
 */
export function envKeyName(accountName) {
  return `OPENCODE_DELEGATE_KEY_${String(accountName).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Resolve the API key for one account from the environment.
 * @param {string} accountName
 * @returns {string|undefined}
 */
export function accountKeyFromEnv(accountName) {
  const value = process.env[envKeyName(accountName)];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * List accounts declared in config with their credential availability.
 * @param {object} config - parsed models.json
 * @returns {{ name: string, configured: boolean, envVar: string }[]}
 */
export function listAccounts(config) {
  return (config.accounts?.names ?? []).map((name) => ({
    name,
    configured: accountKeyFromEnv(name) != null,
    envVar: envKeyName(name),
  }));
}

/**
 * Pick the account to use for the next delegation.
 * - No accounts block -> null (single-account legacy path, unchanged behavior)
 * - Explicit request ("acme") -> validated against names + credentials
 * - "auto" / omitted -> strategy resolution:
 *   strategy "fixed"   -> config.accounts.default (must have a key)
 *   strategy "round-robin" -> least-recently-used among accounts WITH keys,
 *     persisted per-workspace in state.json so rotations are stable across calls.
 * @param {object} config
 * @param {string} workspacePath
 * @param {string} [request] - explicit account name or "auto"
 * @returns {string|null} account name
 */
export function pickAccount(config, workspacePath, request) {
  const accountsCfg = config.accounts;
  if (!accountsCfg || !Array.isArray(accountsCfg.names) || accountsCfg.names.length === 0) {
    if (request && request !== "auto") {
      throw Object.assign(new Error(`No accounts configured; cannot honor requested "${request}"`), {
        code: "ACCOUNT_UNKNOWN",
      });
    }
    return null;
  }

  if (request && request !== "auto") {
    if (!accountsCfg.names.includes(request)) {
      throw Object.assign(
        new Error(`Unknown account "${request}". Configured: ${accountsCfg.names.join(", ")}`),
        { code: "ACCOUNT_UNKNOWN" }
      );
    }
    if (accountKeyFromEnv(request) == null) {
      throw Object.assign(
        new Error(`Account "${request}" has no credential. Set ${envKeyName(request)}`),
        { code: "ACCOUNT_NO_CREDENTIALS" }
      );
    }
    markUsed(workspacePath, request);
    return request;
  }

  const available = accountsCfg.names.filter((n) => accountKeyFromEnv(n) != null);
  if (available.length === 0) {
    const expected = accountsCfg.names.map(envKeyName).join(", ");
    throw Object.assign(
      new Error(
        `No credentials for any configured account (${accountsCfg.names.join(", ")}). ` +
          `Set at least one of: ${expected}`
      ),
      { code: "ACCOUNT_NO_CREDENTIALS" }
    );
  }

  if (accountsCfg.strategy === "fixed" || available.length === 1) {
    const def = accountsCfg.default;
    if (def && available.includes(def)) return def;
    return available[0];
  }

  // round-robin: LRU across the whole pool (keys without usage history go first)
  const lastUsed = loadUsage(workspacePath);
  const sorted = [...available].sort((a, b) => (lastUsed[a] ?? 0) - (lastUsed[b] ?? 0));
  const picked = sorted[0];
  markUsed(workspacePath, picked);
  return picked;
}

function loadUsage(workspacePath) {
  return loadStateSafe(workspacePath).config?.accountLastUsed ?? {};
}

function markUsed(workspacePath, accountName) {
  try {
    updateState(workspacePath, (state) => {
      state.config ??= {};
      state.config.accountLastUsed ??= {};
      state.config.accountLastUsed[accountName] = Date.now();
    });
  } catch {}
}

function loadStateSafe(workspacePath) {
  try {
    return loadState(workspacePath);
  } catch {
    return { config: {}, jobs: [] };
  }
}

/**
 * Build the OPENCODE_AUTH_CONTENT payload for a provider key.
 * Shape verified against upstream packages/opencode/src/auth/index.ts:
 * Record<providerID, {type:"api", key}>.
 * @param {string} providerId
 * @param {string} apiKey
 * @returns {string}
 */
export function buildAuthContent(providerId, apiKey) {
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("buildAuthContent requires a non-empty API key string");
  }
  return JSON.stringify({ [providerId]: { type: "api", key: apiKey } });
}

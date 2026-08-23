// Model catalog loader and merger.
// - loads config/models.json with an mtime-based cache (RF-1)
// - malformed JSON yields a structured error with file/line/column (RF-2, CA-5)
// - merges with GET /config/providers: live-only entries become unclassified
//   (RF-4), file-only entries are flagged available:false (RF-5)
// - excluded ids never appear among selectable models (RF-3)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "..", "config", "models.json");

const CONFIG_CACHE_TTL_MS = 10 * 60 * 1000; // RF-8

/** @type {Map<string, { mtimeMs: number, loadedAt: number, config: object }>} */
const caches = new Map();

/**
 * Extract line/column from a JSON syntax error position.
 * @param {string} text
 * @param {number} position
 * @returns {{ line: number, column: number }}
 */
export function locateJsonError(text, position) {
  const upto = text.slice(0, Math.max(0, Math.min(position, text.length)));
  const lines = upto.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Positional JSON syntax scanner. Engine JSON.parse messages do not reliably
 * carry a position (RF-2/CA-5), so we validate the grammar ourselves and
 * report the first offending character.
 * @param {string} text
 * @returns {number|undefined} position of the first syntax violation
 */
export function findJsonErrorPosition(text) {
  let i = 0;
  const fail = () => i;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  const literal = (word) => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return true;
    }
    return false;
  };

  function parseString() {
    if (text[i] !== '"') return false;
    i += 1;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i += 1;
        return true;
      }
      if (c === "\\") {
        const esc = text[i + 1];
        if (!'"\\/bfnrtu'.includes(esc)) return false;
        i += esc === "u" ? 6 : 2;
        continue;
      }
      if (c < " ") return false; // raw control char
      i += 1;
    }
    return false; // unterminated
  }

  function parseNumber() {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m || m[0] === "") return false;
    i += m[0].length;
    return true;
  }

  function parseValue() {
    ws();
    if (i >= text.length) return fail();
    const c = text[i];
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString() ? null : fail();
    if (c === "-" || /[0-9]/.test(c)) return parseNumber() ? null : fail();
    if (literal("true") || literal("false") || literal("null")) return null;
    return fail();
  }

  function parseObject() {
    i += 1; // {
    ws();
    if (text[i] === "}") {
      i += 1;
      return null;
    }
    for (;;) {
      ws();
      if (!parseString()) return fail();
      ws();
      if (text[i] !== ":") return fail();
      i += 1;
      const v = parseValue();
      if (v != null) return v;
      ws();
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] === "}") {
        i += 1;
        return null;
      }
      return fail();
    }
  }

  function parseArray() {
    i += 1; // [
    ws();
    if (text[i] === "]") {
      i += 1;
      return null;
    }
    for (;;) {
      const v = parseValue();
      if (v != null) return v;
      ws();
      if (text[i] === ",") {
        i += 1;
        continue;
      }
      if (text[i] === "]") {
        i += 1;
        return null;
      }
      return fail();
    }
  }

  try {
    const result = parseValue();
    if (result != null) return result;
    ws();
    if (i < text.length) return i; // trailing garbage
    return undefined;
  } catch {
    return i;
  }
}

/**
 * Load and cache the curated config.
 * @param {string} [configPath]
 * @returns {object} parsed config
 * @throws {{ message: string, file?: string, line?: number, column?: number }} structured error
 */
export function loadConfig(configPath = process.env.OC_MODELS_CONFIG ?? DEFAULT_CONFIG_PATH) {
  let stat;
  try {
    stat = fs.statSync(configPath);
  } catch {
    throw Object.assign(new Error(`Catalog config not found: ${configPath}`), { file: configPath });
  }

  const cached = caches.get(configPath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    Date.now() - cached.loadedAt < CONFIG_CACHE_TTL_MS
  ) {
    return cached.config;
  }

  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw Object.assign(new Error(`Cannot read catalog config: ${err.message}`), { file: configPath });
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch {
    const position = findJsonErrorPosition(text);
    const { line, column } = locateJsonError(text, position ?? text.length);
    throw Object.assign(new Error(`Malformed catalog config: invalid JSON at line ${line}, column ${column}`), {
      file: configPath,
      line,
      column,
    });
  }

  caches.set(configPath, { mtimeMs: stat.mtimeMs, loadedAt: Date.now(), config });
  return config;
}

/** Test hook: drop the memoized config(s). */
export function resetCatalogCache() {
  caches.clear();
}

/**
 * Peak windows (UTC) during which DeepSeek-style off-peak pricing does NOT apply.
 * @param {Date} [now]
 * @returns {boolean} true when current UTC time is outside the peak windows
 */
export function isOffPeakNow(now = new Date()) {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const peaks = [
    [60, 240], // 01:00–04:00 UTC
    [360, 600], // 06:00–10:00 UTC
  ];
  return !peaks.some(([from, to]) => minutes >= from && minutes < to);
}

/**
 * Merge the curated file catalog with the live provider catalog.
 * Pure function over data so tests can drive it without a server.
 * @param {object} config - parsed models.json
 * @param {Record<string, { id: string, variants: object|string[], cost?: object }>} liveModels - provider.models map
 * @param {object} [opts]
 * @param {Date} [opts.now]
 * @returns {{ models: object[], excluded: object[] }}
 */
export function mergeCatalogs(config, liveModels, opts = {}) {
  const now = opts.now ?? new Date();
  const excludedIds = new Set((config.excluded ?? []).map((e) => e.id));
  const fileById = new Map((config.models ?? []).map((m) => [m.id, m]));

  const models = [];
  const seen = new Set();

  for (const live of Object.values(liveModels ?? {})) {
    if (excludedIds.has(live.id)) continue; // RF-3
    seen.add(live.id);
    const fileEntry = fileById.get(live.id);
    models.push({
      ...(fileEntry ?? {}),
      id: live.id,
      tier: fileEntry?.tier ?? null,
      unclassified: !fileEntry,
      variants: Array.isArray(live.variants)
        ? live.variants.slice().sort()
        : Object.keys(live.variants ?? {}).sort(),
      cost: {
        input: Number(live.cost?.input ?? fileEntry?.cost?.input ?? 0),
        output: Number(live.cost?.output ?? fileEntry?.cost?.output ?? 0),
        ...(live.cost?.cache ? { cache: live.cost.cache } : {}),
      },
      available: true,
      offPeakNow: isOffPeakNow(now),
    });
  }

  // Present in file but absent from live catalog: keep curated metadata, flag unavailability (RF-5)
  // Entries bound to a DIFFERENT provider than config.provider never appear in this
  // provider's live catalog; keep them selectable and let the runtime validate.
  for (const fileEntry of config.models ?? []) {
    if (seen.has(fileEntry.id)) continue;
    const foreignProvider = fileEntry.provider != null && fileEntry.provider !== config.provider;
    models.push({ ...fileEntry, available: foreignProvider ? true : false });
  }

  return { models, excluded: config.excluded ?? [] };
}

/**
 * Build the full merged catalog using a connected OpenCode client.
 * Falls back to the file catalog alone when the live fetch fails.
 * @param {object} client - OpenCode client with getProviderCatalog()
 * @param {string} [configPath]
 * @returns {Promise<{ models: object[], excluded: object[], live: boolean }>}
 */
export async function getCatalog(client, configPath) {
  const config = loadConfig(configPath);
  try {
    const data = await client.getProviderCatalog();
    const provider = (data.providers ?? []).find((p) => p.id === config.provider);
    const liveModels = provider?.models ?? {};
    return { ...mergeCatalogs(config, liveModels), live: true };
  } catch {
    // Live unavailable: serve file catalog marked unavailable (RF-5 semantics)
    const models = (config.models ?? []).map((m) => ({ ...m, available: false }));
    return { models, excluded: config.excluded ?? [], live: false };
  }
}

/**
 * Human-readable hint describing tiers and budget for the `models` tool.
 * Prefers the merged catalog when provided so unavailable models are never
 * recommended and live-only tiers surface correctly.
 * @param {object} config
 * @param {object[]} [models] - merged catalog entries (from getCatalog)
 * @returns {string}
 */
export function formatHint(config, models) {
  const source = Array.isArray(models) ? models : (config.models ?? []);
  const byTier = {};
  for (const m of source) {
    if (m.tier == null) continue;
    if (m.available === false) continue;
    const t = String(m.tier);
    (byTier[t] ??= []).push(m.id);
  }
  const tiers = Object.keys(byTier)
    .sort()
    .map((t) => `tier ${t}: ${byTier[t].join(", ")}`)
    .join("; ");
  const b = config.budget ?? {};
  const budget = b.perMonth != null ? ` Budget ≈ $${b.perMonth}/mese ($${b.perWeek}/sett, $${b.per5h}/5h).` : "";
  return `${tiers}.${budget} In dubbio scendi di un tier.`;
}

/**
 * Compact per-model cost table (USD per million tokens) for the `models` tool.
 * Only tiered, available entries are listed; free models read as "free".
 * @param {object[]} models - merged catalog entries
 * @returns {string[]}
 */
export function formatCostTable(models) {
  const rows = [];
  for (const m of models ?? []) {
    if (m.tier == null || m.available === false) continue;
    const cin = Number(m.cost?.input ?? 0);
    const cout = Number(m.cost?.output ?? 0);
    const cost =
      cin === 0 && cout === 0 ? "free" : `$${cin}/Mtok in · $${cout}/Mtok out`;
    rows.push(`tier ${m.tier} ${m.id}: ${cost}`);
  }
  return rows.sort((a, b) => a.localeCompare(b));
}

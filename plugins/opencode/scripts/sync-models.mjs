// Sync config/models.json against the live OpenCode model catalog.
//
// Two sources, same data:
//   default  - `opencode models opencode --verbose` CLI output (brace-counting parser)
//   --live   - GET /config/providers on a running/started server (structured JSON, preferred)
//
// Curated fields (tier, use, default, offPeakOnly) are preserved for known ids.
// New ids enter as tier: null + unclassified: true. Excluded ids never appear.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureServer } from "./lib/opencode-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config", "models.json");
const PROVIDER_ID = "opencode";
const CURATED_FIELDS = ["tier", "use", "default", "offPeakOnly", "provider"];

/**
 * Parse `opencode models <provider> --verbose` output.
 * Blocks look like:
 *   opencode/glm-5.2
 *   {
 *     ...pretty JSON...
 *   }
 * Brace counting is required: naive line-splitting breaks on nested objects.
 * @param {string} raw
 * @param {string} providerId
 * @returns {{ id: string, variants: string[], cost: { input: number, output: number } }[]}
 */
export function parseCliCatalog(raw, providerId = PROVIDER_ID) {
  const lines = raw.split("\n");
  const headerRe = new RegExp(`^${providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\S+)\\s*$`);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(headerRe);
    if (!m) {
      i += 1;
      continue;
    }
    // Find the opening brace of the JSON block
    while (i < lines.length && !lines[i].trim().startsWith("{")) i += 1;
    if (i >= lines.length) break;

    let depth = 0;
    const start = i;
    do {
      for (const ch of lines[i]) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      i += 1;
    } while (i < lines.length && depth > 0);

    const block = lines.slice(start, i).join("\n");
    try {
      const parsed = JSON.parse(block);
      out.push({
        id: parsed.id ?? m[1],
        variants: parsed.variants ? Object.keys(parsed.variants).sort() : [],
        cost: {
          input: Number(parsed.cost?.input ?? 0),
          output: Number(parsed.cost?.output ?? 0),
        },
      });
    } catch (err) {
      throw new Error(`Failed to parse catalog block for ${m[1]}: ${err.message}`);
    }
  }
  return out;
}

/**
 * Fetch the live catalog from GET /config/providers.
 * @returns {Promise<{ id: string, variants: string[], cost: { input: number, output: number } }[]>}
 */
export async function fetchLiveCatalog(cwd = process.cwd()) {
  const { url } = await ensureServer({ cwd });
  const res = await fetch(`${url}/config/providers`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`GET /config/providers returned ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  const provider = (data.providers ?? []).find((p) => p.id === PROVIDER_ID);
  if (!provider) {
    throw new Error(`Provider "${PROVIDER_ID}" not found in /config/providers`);
  }
  return Object.values(provider.models ?? {}).map((model) => ({
    id: model.id,
    variants: model.variants ? Object.keys(model.variants).sort() : [],
    cost: {
      input: Number(model.cost?.input ?? 0),
      output: Number(model.cost?.output ?? 0),
    },
  }));
}

/**
 * Merge fresh catalog entries into the existing config, preserving curated fields.
 * @param {object} config - current models.json content
 * @param {{ id: string, variants: string[], cost: object }[]} entries - fresh catalog
 * @returns {object} new config
 */
export function mergeCatalog(config, entries) {
  const excludedIds = new Set((config.excluded ?? []).map((e) => e.id));
  const existing = new Map((config.models ?? []).map((m) => [m.id, m]));

  const models = [];
  const seen = new Set();
  for (const entry of entries) {
    if (excludedIds.has(entry.id)) continue; // RF-3: excluded stay invisible
    seen.add(entry.id);
    const prev = existing.get(entry.id);
    const merged = {
      id: entry.id,
      ...(prev ? Object.fromEntries(CURATED_FIELDS.filter((f) => prev[f] !== undefined).map((f) => [f, prev[f]])) : { tier: null, unclassified: true }),
      variants: entry.variants,
      cost: entry.cost,
    };
    models.push(merged);
  }

  // File entries missing from the live catalog keep their curated data but are flagged
  for (const prev of config.models ?? []) {
    if (seen.has(prev.id)) continue;
    models.push({ ...prev, available: false });
  }

  return { ...config, syncedAt: new Date().toISOString(), models };
}

/**
 * Validate the generated config shape before writing (see findings P8:
 * malformed permission keys degrade the spawned server silently).
 * @param {object} config
 */
export function validateConfig(config) {
  const errors = [];
  if (config.provider !== PROVIDER_ID) errors.push(`provider must be "${PROVIDER_ID}"`);
  if (!Array.isArray(config.models)) errors.push("models must be an array");

  const ids = new Set();
  for (const m of config.models ?? []) {
    if (!m.id) errors.push("model entry without id");
    else if (ids.has(m.id)) errors.push(`duplicate model id "${m.id}"`);
    else ids.add(m.id);
    if (typeof m.cost?.input !== "number" || typeof m.cost?.output !== "number") {
      errors.push(`model "${m.id}": cost.input/cost.output must be numbers`);
    }
  }

  const perms = config.permissions ?? {};
  for (const key of ["spawn", "autoApprove", "autoReject"]) {
    if (!(key in perms)) errors.push(`permissions.${key} missing`);
  }
  if (perms.spawn && typeof perms.spawn !== "object") errors.push("permissions.spawn must be an object");
  for (const key of ["autoApprove", "autoReject"]) {
    if (!Array.isArray(perms[key])) errors.push(`permissions.${key} must be an array`);
  }
  for (const rule of perms.autoApprove ?? []) {
    try {
      new RegExp(rule);
    } catch {
      errors.push(`invalid autoApprove regex: ${rule}`);
    }
  }
  for (const rule of perms.autoReject ?? []) {
    try {
      new RegExp(rule);
    } catch {
      errors.push(`invalid autoReject regex: ${rule}`);
    }
  }

  if (errors.length > 0) throw new Error(`Invalid generated models.json:\n- ${errors.join("\n- ")}`);
}

/**
 * Detect brand-new FREE ids from this sync and (optionally) promote them to
 * tier 0. Free = zero input AND output cost, not excluded, not already tiered.
 * @param {object} config - PREVIOUS config (before merge), to know which ids are new
 * @param {object} merged - POST-merge config
 * @param {{ autoFree?: boolean }} [opts]
 * @returns {{ promoted: string[], suggested: string[] }} promoted when autoFree
 */
export function detectFreeCandidates(config, merged, opts = {}) {
  const knownIds = new Set((config.models ?? []).map((m) => m.id));
  const promoted = [];
  const suggested = [];
  for (const m of merged.models ?? []) {
    if (!knownIds.has(m.id) && m.cost?.input === 0 && m.cost?.output === 0) {
      // A curated default must stay THE default: never steal the flag.
      if (opts.autoFree === true) {
        m.tier = 0;
        m.unclassified = false;
        if (!merged.defaults?.tier) merged.defaults = { ...(merged.defaults ?? {}), tier: 0 };
        promoted.push(m.id);
      } else {
        suggested.push(m.id);
      }
    }
  }
  return { promoted, suggested };
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const autoFree = args.includes("--auto-free");
  const configPathArgIdx = args.indexOf("--config");
  const configPath = configPathArgIdx >= 0 ? args[configPathArgIdx + 1] : CONFIG_PATH;

  const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
  process.stderr.write(live ? "Syncing from /config/providers...\n" : "Syncing from CLI output...\n");

  const entries = live ? await fetchLiveCatalog(process.cwd()) : await runCli();
  const merged = mergeCatalog(current, entries);
  const freeScan = detectFreeCandidates(current, merged, { autoFree });
  validateConfig(merged);

  const tmp = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, configPath);

  const unclassified = merged.models.filter((m) => m.unclassified).length;
  const unavailable = merged.models.filter((m) => m.available === false).length;
  process.stdout.write(
    `Synced ${merged.models.length} models (${unclassified} new/unclassified, ${unavailable} no longer in live catalog) -> ${configPath}\n`
  );
  if (freeScan.promoted.length > 0) {
    process.stdout.write(`Auto-promoted NEW free models to tier 0: ${freeScan.promoted.join(", ")}\n`);
  } else if (freeScan.suggested.length > 0) {
    process.stdout.write(
      `NEW free models detected (add with: model add <id> --tier 0 --variants max --cost-in 0 --cost-out 0): ${freeScan.suggested.join(", ")}\n`
    );
  }
}

function runCli() {
  return import("node:child_process").then(({ execFileSync }) => {
    const raw = execFileSync("opencode", ["models", PROVIDER_ID, "--verbose"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const entries = parseCliCatalog(raw);
    if (entries.length === 0) throw new Error("CLI catalog empty — is `opencode` authenticated?");
    return entries;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

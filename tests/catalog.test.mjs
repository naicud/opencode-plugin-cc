import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  loadConfig,
  resetCatalogCache,
  mergeCatalogs,
  isOffPeakNow,
  locateJsonError,
  formatHint,
} from "../plugins/opencode/mcp/lib/catalog.mjs";

let tmpDir;
let configPath;

const baseConfig = {
  version: 1,
  provider: "opencode",
  defaults: { tier: 1 },
  models: [
    { id: "glm-5.2", tier: 2, use: "workhorse", variants: ["high", "max"], cost: { input: 1.4, output: 4.4 } },
    { id: "kimi-k3", tier: 3, variants: ["max"], cost: { input: 3, output: 15 } },
  ],
  excluded: [{ id: "muse-spark-1.2-contributor-free", reason: "training data" }],
};

function writeConfig(config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

beforeEach(() => {
  tmpDir = createTmpDir();
  configPath = path.join(tmpDir, "models.json");
  writeConfig(baseConfig);
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("catalog", () => {
  it("loadConfig parses a valid config and caches by mtime", () => {
    const config = loadConfig(configPath);
    assert.equal(config.provider, "opencode");
    assert.equal(config.models.length, 2);

    // Mutate WITHOUT changing mtime granularity beyond resolution
    const mutated = { ...baseConfig, defaults: { tier: 3 } };
    writeConfig(mutated);
    fs.utimesSync(configPath, new Date(), new Date(Date.now() + 5000));
    assert.equal(loadConfig(configPath).defaults.tier, 3); // mtime change invalidates cache (CA-4)
  });

  it("malformed JSON yields structured error with file/line/column, not an uncaught throw (CA-5)", () => {
    fs.writeFileSync(
      configPath,
      '{\n  "provider": "opencode",\n  "models": [BROKEN\n}',
      "utf8"
    );
    assert.throws(
      () => loadConfig(configPath),
      (err) => {
        assert.match(err.message, /Malformed catalog config/);
        assert.equal(err.file, configPath);
        assert.equal(err.line, 3);
        assert.ok(err.column >= 13);
        return true;
      }
    );
  });

  it("missing file yields error with file field", () => {
    assert.throws(() => loadConfig(path.join(tmpDir, "nope.json")), /not found/);
  });

  it("loadConfig caches multiple config paths independently (multi-slot)", () => {
    const otherPath = path.join(tmpDir, "other.json");
    fs.writeFileSync(
      otherPath,
      JSON.stringify({ ...baseConfig, provider: "other" }, null, 2),
      "utf8"
    );
    const a = loadConfig(configPath);
    const b = loadConfig(otherPath);
    assert.equal(a.provider, "opencode");
    assert.equal(b.provider, "other");
    // Alternating hits must not thrash: both stay cached
    assert.equal(loadConfig(configPath).provider, "opencode");
    assert.equal(loadConfig(otherPath).provider, "other");
  });

  describe("formatHint", () => {
    it("uses merged models when provided and skips unavailable/unclassified", () => {
      const { models } = mergeCatalogs(baseConfig, {
        "glm-5.2": liveModels()["glm-5.2"],
        "brand-new-model": liveModels()["brand-new-model"],
      });
      const hint = formatHint(baseConfig, models);
      assert.match(hint, /tier 2: glm-5\.2/);
      assert.doesNotMatch(hint, /kimi-k3/); // available:false dropped
      assert.doesNotMatch(hint, /brand-new-model/); // tier null skipped
    });

    it("falls back to file catalog when no models array passed", () => {
      const hint = formatHint(baseConfig);
      assert.match(hint, /glm-5\.2/);
      assert.match(hint, /kimi-k3/);
      assert.match(hint, /In dubbio scendi di un tier/);
    });
  });

  function liveModels() {
    return {
      "glm-5.2": {
        id: "glm-5.2",
        variants: { max: {}, high: {} },
        cost: { input: 1.4, output: 4.4, cache: 0.7 },
      },
      "brand-new-model": {
        id: "brand-new-model",
        variants: {},
        cost: { input: 0.5, output: 1 },
      },
    };
  }

  describe("mergeCatalogs", () => {
    const liveModels = {
      "glm-5.2": {
        id: "glm-5.2",
        variants: { max: {}, high: {} },
        cost: { input: 1.4, output: 4.4, cache: 0.7 },
      },
      "brand-new-model": {
        id: "brand-new-model",
        variants: {},
        cost: { input: 0.5, output: 1 },
      },
      "muse-spark-1.2-contributor-free": {
        id: "muse-spark-1.2-contributor-free",
        variants: {},
        cost: { input: 0, output: 0 },
      },
    };

    it("merges live + file preserving curated fields (RF-4)", () => {
      const { models, excluded } = mergeCatalogs(baseConfig, liveModels);
      const glm = models.find((m) => m.id === "glm-5.2");
      assert.equal(glm.tier, 2);
      assert.equal(glm.use, "workhorse"); // curated preserved
      assert.deepEqual(glm.variants, ["high", "max"]);
      assert.equal(glm.available, true);
      assert.ok(excluded.some((e) => e.id === "muse-spark-1.2-contributor-free"));
    });

    it("live-only entries enter as unclassified with tier null", () => {
      const { models } = mergeCatalogs(baseConfig, liveModels);
      const fresh = models.find((m) => m.id === "brand-new-model");
      assert.equal(fresh.tier, null);
      assert.equal(fresh.unclassified, true);
      assert.equal(fresh.available, true);
    });

    it("file-only entries are flagged available:false (RF-5)", () => {
      const { models } = mergeCatalogs(baseConfig, {});
      const kimi = models.find((m) => m.id === "kimi-k3");
      assert.equal(kimi.available, false);
      assert.equal(kimi.tier, 3); // curated data kept
    });

    it("excluded ids never appear among selectable models (RF-3)", () => {
      const { models } = mergeCatalogs(baseConfig, liveModels);
      assert.equal(models.some((m) => m.id.includes("muse")), false);
    });
  });

  describe("isOffPeakNow", () => {
    it("is false during peak windows 01:00-04:00 UTC", () => {
      assert.equal(isOffPeakNow(new Date("2026-08-22T02:30:00Z")), false);
      assert.equal(isOffPeakNow(new Date("2026-08-22T07:00:00Z")), false);
    });

    it("is true outside peak windows", () => {
      assert.equal(isOffPeakNow(new Date("2026-08-22T00:00:00Z")), true);
      assert.equal(isOffPeakNow(new Date("2026-08-22T05:00:00Z")), true);
      assert.equal(isOffPeakNow(new Date("2026-08-22T23:00:00Z")), true);
    });
  });

  it("locateJsonError maps position to line/column", () => {
    const text = 'a: 1\nb: {\n  bad';
    const { line, column } = locateJsonError(text, text.length - 1);
    assert.equal(line, 3);
  });
});

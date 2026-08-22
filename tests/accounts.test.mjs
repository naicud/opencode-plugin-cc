import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import {
  envKeyName,
  accountKeyFromEnv,
  listAccounts,
  pickAccount,
  buildAuthContent,
} from "../plugins/opencode/mcp/lib/accounts.mjs";

let tmpDir;
const workspace = "/test/workspace";

beforeEach(() => {
  tmpDir = createTmpDir();
  setupTestEnv(tmpDir);
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
  delete process.env.OPENCODE_DELEGATE_KEY_A;
  delete process.env.OPENCODE_DELEGATE_KEY_B;
});

describe("accounts", () => {
  it("envKeyName maps names to OPENCODE_DELEGATE_KEY_<UPPER>", () => {
    assert.equal(envKeyName("acme"), "OPENCODE_DELEGATE_KEY_ACME");
    assert.equal(envKeyName("Team-2"), "OPENCODE_DELEGATE_KEY_TEAM_2");
    assert.equal(envKeyName("a.b/c"), "OPENCODE_DELEGATE_KEY_A_B_C");
  });

  it("accountKeyFromEnv resolves set keys, ignores unset/empty", () => {
    assert.equal(accountKeyFromEnv("A"), undefined);
    process.env.OPENCODE_DELEGATE_KEY_A = "";
    assert.equal(accountKeyFromEnv("A"), undefined);
    process.env.OPENCODE_DELEGATE_KEY_A = " zen-key-123 ";
    assert.equal(accountKeyFromEnv("A"), "zen-key-123");
  });

  it("listAccounts reports configured flags", () => {
    process.env.OPENCODE_DELEGATE_KEY_A = "k1";
    const list = listAccounts({ accounts: { names: ["A", "B"] } });
    assert.deepEqual(list, [
      { name: "A", configured: true, envVar: "OPENCODE_DELEGATE_KEY_A" },
      { name: "B", configured: false, envVar: "OPENCODE_DELEGATE_KEY_B" },
    ]);
  });

  describe("pickAccount", () => {
    const noBlock = {};

    it("returns null (legacy path) when no accounts block", () => {
      assert.equal(pickAccount(noBlock, workspace), null);
      assert.equal(pickAccount({ accounts: { names: [] } }, workspace), null);
    });

    it("explicit request without accounts block throws ACCOUNT_UNKNOWN", () => {
      assert.throws(() => pickAccount(noBlock, workspace, "x"), (e) => e.code === "ACCOUNT_UNKNOWN");
    });

    it("throws ACCOUNT_NO_CREDENTIALS listing env vars when none configured", () => {
      assert.throws(
        () => pickAccount({ accounts: { names: ["A", "B"], strategy: "round-robin" } }, workspace),
        (err) => err.code === "ACCOUNT_NO_CREDENTIALS" && /OPENCODE_DELEGATE_KEY_A/.test(err.message)
      );
    });

    it("honors explicit valid request and marks usage", () => {
      process.env.OPENCODE_DELEGATE_KEY_A = "k1";
      assert.equal(pickAccount({ accounts: { names: ["A"] } }, workspace, "A"), "A");
    });

    it("rejects unknown or uncredentialed explicit requests", () => {
      process.env.OPENCODE_DELEGATE_KEY_A = "k1";
      const cfg = { accounts: { names: ["A", "B"] } };
      assert.throws(() => pickAccount(cfg, workspace, "Z"), (e) => e.code === "ACCOUNT_UNKNOWN");
      assert.throws(() => pickAccount(cfg, workspace, "B"), (e) => e.code === "ACCOUNT_NO_CREDENTIALS");
    });

    it('treats "auto" like omitted', () => {
      process.env.OPENCODE_DELEGATE_KEY_A = "k1";
      const cfg = { accounts: { names: ["A"], strategy: "fixed" } };
      assert.equal(pickAccount(cfg, workspace, "auto"), "A");
    });

    it("fixed strategy prefers default then first available", () => {
      process.env.OPENCODE_DELEGATE_KEY_A = "k1";
      process.env.OPENCODE_DELEGATE_KEY_B = "k2";
      const cfgDefault = { accounts: { names: ["A", "B"], strategy: "fixed", default: "B" } };
      assert.equal(pickAccount(cfgDefault, workspace), "B");
      const cfgNoDef = { accounts: { names: ["A", "B"], strategy: "fixed" } };
      assert.equal(pickAccount(cfgNoDef, workspace), "A"); // first available
    });

    it("round-robin rotates LRU across available accounts", () => {
      process.env.OPENCODE_DELEGATE_KEY_A = "k1";
      process.env.OPENCODE_DELEGATE_KEY_B = "k2";
      // B has no key in this sub-case? It does; rotate A -> B -> A
      const cfg = { accounts: { names: ["A", "B"], strategy: "round-robin" } };
      const first = pickAccount(cfg, workspace);
      const second = pickAccount(cfg, workspace);
      const third = pickAccount(cfg, workspace);
      assert.notEqual(first, second);
      assert.equal(third, first); // full rotation
    });

    it("round-robin skips accounts without credentials", () => {
      process.env.OPENCODE_DELEGATE_KEY_A = "k1"; // only A has a key
      const cfg = { accounts: { names: ["A", "B"], strategy: "round-robin" } };
      assert.equal(pickAccount(cfg, workspace), "A");
      assert.equal(pickAccount(cfg, workspace), "A");
    });
  });

  describe("buildAuthContent", () => {
    it("produces upstream auth shape Record<provider,{type:'api',key}>", () => {
      const payload = JSON.parse(buildAuthContent("opencode", "sk-test"));
      assert.deepEqual(payload, { opencode: { type: "api", key: "sk-test" } });
    });

    it("rejects empty/missing keys", () => {
      assert.throws(() => buildAuthContent("opencode", ""));
      assert.throws(() => buildAuthContent("opencode", undefined));
    });
  });
});

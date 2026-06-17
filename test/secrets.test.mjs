import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveApiKey, readKeychainPassword } from "../lib/secrets.mjs";

test("resolveApiKey returns AGENTMEM_API_KEY when set, without touching the keychain", async () => {
  let keychainCalled = false;
  const env = { AGENTMEM_API_KEY: "sk-ant-from-env" };
  const keychainReader = async () => {
    keychainCalled = true;
    return "sk-ant-should-not-be-used";
  };
  const key = await resolveApiKey({ env, keychainReader });
  assert.equal(key, "sk-ant-from-env");
  assert.equal(keychainCalled, false);
});

test("resolveApiKey falls back to the keychain when AGENTMEM_API_KEY is unset", async () => {
  const env = {};
  const keychainReader = async (service, account) => {
    assert.equal(service, "agentmem");
    assert.equal(account, "anthropic");
    return "sk-ant-from-keychain";
  };
  const key = await resolveApiKey({ env, keychainReader });
  assert.equal(key, "sk-ant-from-keychain");
});

test("resolveApiKey ignores empty AGENTMEM_API_KEY and tries the keychain", async () => {
  const env = { AGENTMEM_API_KEY: "" };
  const keychainReader = async () => "sk-ant-from-keychain";
  const key = await resolveApiKey({ env, keychainReader });
  assert.equal(key, "sk-ant-from-keychain");
});

test("resolveApiKey throws a clear error including the setup command when no source is available", async () => {
  const env = {};
  const keychainReader = async () => null;
  await assert.rejects(
    () => resolveApiKey({ env, keychainReader }),
    (err) => {
      assert.match(err.message, /no Anthropic API key/i);
      assert.match(err.message, /security add-generic-password/);
      assert.match(err.message, /-s agentmem -a anthropic/);
      return true;
    },
  );
});

test("resolveApiKey throws the same clear error when the keychain reader rejects", async () => {
  const env = {};
  const keychainReader = async () => {
    throw new Error("keychain unavailable");
  };
  await assert.rejects(
    () => resolveApiKey({ env, keychainReader }),
    /no Anthropic API key/i,
  );
});

test("readKeychainPassword silently returns null when the entry is missing (exit 44)", async () => {
  const errors = [];
  const runSecurity = async () => {
    const err = new Error("The specified item could not be found in the keychain.");
    err.code = 44;
    throw err;
  };
  const result = await readKeychainPassword("agentmem", "anthropic", {
    runSecurity,
    onError: (e) => errors.push(e),
  });
  assert.equal(result, null);
  assert.equal(errors.length, 0);
});

test("readKeychainPassword surfaces non-44 errors via onError (still returns null)", async () => {
  const errors = [];
  const runSecurity = async () => {
    const err = new Error("security: spawn ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  const result = await readKeychainPassword("agentmem", "anthropic", {
    runSecurity,
    onError: (e) => errors.push(e),
  });
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ENOENT/);
});

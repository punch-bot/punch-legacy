import test from "node:test";
import assert from "node:assert/strict";
import {
  loadSpectrumConfig,
  parseProviders,
  parseUserMap,
  formatConfigError,
  SpectrumConfigError,
  SAFE_STARTUP_ERROR,
} from "../src/spectrum/config.js";

test("parseProviders defaults to imessage", () => {
  assert.deepEqual(parseProviders(""), ["imessage"]);
  assert.deepEqual(parseProviders(undefined), ["imessage"]);
});

test("parseProviders accepts imessage and terminal", () => {
  assert.deepEqual(parseProviders("imessage, terminal"), ["imessage", "terminal"]);
});

test("parseProviders rejects unknown providers", () => {
  assert.throws(() => parseProviders("discord"), /Unknown Spectrum provider/);
});

test("parseUserMap parses JSON object", () => {
  const map = parseUserMap('{"+15551234567":"99","a@b.com":"88"}');
  assert.equal(map["+15551234567"], "99");
  assert.equal(map["a@b.com"], "88");
});

test("parseUserMap rejects invalid JSON", () => {
  assert.throws(() => parseUserMap("{nope}"), /valid JSON/);
});

test("loadSpectrumConfig agent+imessage requires credentials and user map", () => {
  assert.throws(
    () =>
      loadSpectrumConfig({
        SPECTRUM_MODE: "agent",
        SPECTRUM_PROVIDERS: "imessage",
      }),
    (err) =>
      err instanceof SpectrumConfigError &&
      /SPECTRUM_PROJECT_ID/.test(err.message) &&
      !/supersecret/i.test(err.message),
  );
});

test("loadSpectrumConfig missing secret mentions secret env name without leaking values", () => {
  const secret = "super-secret-value-do-not-leak";
  assert.throws(
    () =>
      loadSpectrumConfig({
        SPECTRUM_MODE: "agent",
        SPECTRUM_PROVIDERS: "imessage",
        SPECTRUM_PROJECT_ID: "proj_123",
        SPECTRUM_USER_MAP: '{"+1":"1"}',
      }),
    (err) =>
      err instanceof SpectrumConfigError &&
      /SPECTRUM_PROJECT_SECRET/.test(err.message) &&
      !err.message.includes(secret),
  );
});

test("loadSpectrumConfig agent+imessage allows empty user map (pairing flow)", () => {
  const cfg = loadSpectrumConfig({
    SPECTRUM_MODE: "agent",
    SPECTRUM_PROVIDERS: "imessage",
    SPECTRUM_PROJECT_ID: "proj_abc",
    SPECTRUM_PROJECT_SECRET: "sec_abc",
  });
  assert.equal(cfg.mode, "agent");
  assert.deepEqual(cfg.userMap, {});
});

test("loadSpectrumConfig accepts SPECTRUM_* credentials with user map", () => {
  const cfg = loadSpectrumConfig({
    SPECTRUM_MODE: "agent",
    SPECTRUM_PROVIDERS: "imessage",
    SPECTRUM_PROJECT_ID: "proj_abc",
    SPECTRUM_PROJECT_SECRET: "sec_abc",
    SPECTRUM_USER_MAP: '{"+15551234567":"123"}',
  });
  assert.equal(cfg.mode, "agent");
  assert.deepEqual(cfg.providers, ["imessage"]);
  assert.equal(cfg.projectId, "proj_abc");
  assert.equal(cfg.projectSecret, "sec_abc");
  assert.equal(cfg.userMap["+15551234567"], "123");
  assert.equal(cfg.hasProjectCredentials, true);
});

test("loadSpectrumConfig accepts PROJECT_ID / PROJECT_SECRET aliases", () => {
  const cfg = loadSpectrumConfig({
    SPECTRUM_PROVIDERS: "imessage",
    PROJECT_ID: "proj_alias",
    PROJECT_SECRET: "sec_alias",
    SPECTRUM_USER_MAP: '{"+1":"123"}',
  });
  assert.equal(cfg.projectId, "proj_alias");
  assert.equal(cfg.projectSecret, "sec_alias");
});

test("loadSpectrumConfig terminal-only echo needs no cloud credentials", () => {
  const cfg = loadSpectrumConfig({
    SPECTRUM_MODE: "echo",
    SPECTRUM_PROVIDERS: "terminal",
  });
  assert.equal(cfg.mode, "echo");
  assert.deepEqual(cfg.providers, ["terminal"]);
  assert.equal(cfg.hasProjectCredentials, false);
});

test("loadSpectrumConfig agent+terminal requires default user or map", () => {
  assert.throws(
    () =>
      loadSpectrumConfig({
        SPECTRUM_MODE: "agent",
        SPECTRUM_PROVIDERS: "terminal",
      }),
    /SPECTRUM_DEFAULT_USER_ID or SPECTRUM_USER_MAP/,
  );
  const cfg = loadSpectrumConfig({
    SPECTRUM_MODE: "agent",
    SPECTRUM_PROVIDERS: "terminal",
    SPECTRUM_DEFAULT_USER_ID: "123",
  });
  assert.equal(cfg.defaultUserId, "123");
});

test("formatConfigError uses SpectrumConfigError message", () => {
  assert.equal(
    formatConfigError(new SpectrumConfigError("missing stuff")),
    "missing stuff",
  );
});

test("formatConfigError does not leak unknown Error messages", () => {
  const secret = "super-secret-value-do-not-leak";
  const out = formatConfigError(new Error(`boom ${secret}`));
  assert.equal(out, SAFE_STARTUP_ERROR);
  assert.equal(out.includes(secret), false);
});

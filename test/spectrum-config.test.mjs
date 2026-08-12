import test from "node:test";
import assert from "node:assert/strict";
import {
  loadSpectrumConfig,
  parseProviders,
  parseUserMap,
  formatConfigError,
  SpectrumConfigError,
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

test("loadSpectrumConfig agent+imessage requires credentials and default user", () => {
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
        SPECTRUM_DEFAULT_USER_ID: "1",
      }),
    (err) =>
      err instanceof SpectrumConfigError &&
      /SPECTRUM_PROJECT_SECRET/.test(err.message) &&
      !err.message.includes(secret),
  );
  assert.throws(
    () =>
      loadSpectrumConfig({
        SPECTRUM_MODE: "agent",
        SPECTRUM_PROVIDERS: "imessage",
        SPECTRUM_PROJECT_ID: "proj_123",
        SPECTRUM_PROJECT_SECRET: secret,
      }),
    (err) =>
      err instanceof SpectrumConfigError &&
      /SPECTRUM_DEFAULT_USER_ID/.test(err.message) &&
      !err.message.includes(secret),
  );
});

test("loadSpectrumConfig accepts SPECTRUM_* credentials", () => {
  const cfg = loadSpectrumConfig({
    SPECTRUM_MODE: "agent",
    SPECTRUM_PROVIDERS: "imessage",
    SPECTRUM_PROJECT_ID: "proj_abc",
    SPECTRUM_PROJECT_SECRET: "sec_abc",
    SPECTRUM_DEFAULT_USER_ID: "123",
  });
  assert.equal(cfg.mode, "agent");
  assert.deepEqual(cfg.providers, ["imessage"]);
  assert.equal(cfg.projectId, "proj_abc");
  assert.equal(cfg.projectSecret, "sec_abc");
  assert.equal(cfg.defaultUserId, "123");
  assert.equal(cfg.hasProjectCredentials, true);
});

test("loadSpectrumConfig accepts PROJECT_ID / PROJECT_SECRET aliases", () => {
  const cfg = loadSpectrumConfig({
    SPECTRUM_PROVIDERS: "imessage",
    PROJECT_ID: "proj_alias",
    PROJECT_SECRET: "sec_alias",
    SPECTRUM_DEFAULT_USER_ID: "123",
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

test("formatConfigError uses SpectrumConfigError message", () => {
  assert.equal(
    formatConfigError(new SpectrumConfigError("missing stuff")),
    "missing stuff",
  );
});

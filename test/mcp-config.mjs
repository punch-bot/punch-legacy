import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPunchEntry,
  isMcpApiKeyConfigured,
  legacyMcpApiKeyEnvVar,
  migrateMcpApiKeyEnvVars,
  mcpApiKeyEnvVar,
  mcpApiKeyEnvVarCandidates,
  mcpApiKeyEnvVarsToClear,
  punchEntryToAdapter,
  punchRegistryToAdapterConfig,
  punchRegistryToMcpServers,
  redactMcpKeysFromEnvView,
  sanitizeMcpEntryForDisplay,
  splitCommandString,
  usesMcpApiKeyAuth,
} from "../docker/mcp-config.mjs";

test("mcpApiKeyEnvVar uses collision-free base64url encoding", () => {
  assert.equal(mcpApiKeyEnvVar("linear"), "MCP_bGluZWFy_API_KEY");
  assert.equal(mcpApiKeyEnvVar("my-server"), "MCP_bXktc2VydmVy_API_KEY");
  assert.notEqual(mcpApiKeyEnvVar("foo-bar"), mcpApiKeyEnvVar("foo_bar"));
  assert.notEqual(mcpApiKeyEnvVar("foo_bar"), mcpApiKeyEnvVar("foo__bar"));
  assert.notEqual(mcpApiKeyEnvVar("Foo"), mcpApiKeyEnvVar("foo"));
  assert.equal(mcpApiKeyEnvVar(" linear "), mcpApiKeyEnvVar("linear"));
  assert.match(mcpApiKeyEnvVar("ab~"), /^MCP_[A-Za-z0-9_-]+_API_KEY$/);
  assert.notEqual(mcpApiKeyEnvVar("ab~"), mcpApiKeyEnvVar("ab"));
});

test("legacy and new env var names differ for hyphen vs underscore", () => {
  assert.equal(legacyMcpApiKeyEnvVar("foo-bar"), legacyMcpApiKeyEnvVar("foo_bar"));
  assert.notEqual(mcpApiKeyEnvVar("foo-bar"), mcpApiKeyEnvVar("foo_bar"));
  assert.deepEqual(mcpApiKeyEnvVarCandidates("foo-bar"), [
    mcpApiKeyEnvVar("foo-bar"),
    legacyMcpApiKeyEnvVar("foo-bar"),
  ]);
});

test("migrateMcpApiKeyEnvVars moves legacy keys to collision-free names", () => {
  const registry = { "foo-bar": { type: "remote", url: "https://x.test/mcp", auth: "api_key" } };
  const legacyVar = legacyMcpApiKeyEnvVar("foo-bar");
  const env = { [legacyVar]: "secret-key" };
  const { env: migrated, changed } = migrateMcpApiKeyEnvVars(registry, env);
  assert.equal(changed, true);
  assert.equal(migrated[mcpApiKeyEnvVar("foo-bar")], "secret-key");
  assert.equal(migrated[legacyVar], undefined);
});

test("migrateMcpApiKeyEnvVars skips ambiguous legacy collisions", () => {
  const registry = {
    "foo-bar": { type: "remote", url: "https://a.test/mcp", auth: "api_key" },
    foo_bar: { type: "remote", url: "https://b.test/mcp", auth: "api_key" },
  };
  const legacyVar = legacyMcpApiKeyEnvVar("foo-bar");
  const env = { [legacyVar]: "shared-secret" };
  const { env: migrated, changed } = migrateMcpApiKeyEnvVars(registry, env);
  assert.equal(changed, false);
  assert.equal(migrated[legacyVar], "shared-secret");
  assert.equal(migrated[mcpApiKeyEnvVar("foo-bar")], undefined);
  assert.equal(migrated[mcpApiKeyEnvVar("foo_bar")], undefined);
});

test("mcpApiKeyEnvVarsToClear preserves ambiguous legacy keys", () => {
  const registry = {
    "foo-bar": { type: "remote", url: "https://a.test/mcp", auth: "api_key" },
    foo_bar: { type: "remote", url: "https://b.test/mcp", auth: "api_key" },
  };
  const legacyVar = legacyMcpApiKeyEnvVar("foo-bar");
  assert.deepEqual(mcpApiKeyEnvVarsToClear("foo-bar", registry), [mcpApiKeyEnvVar("foo-bar")]);
  assert.deepEqual(mcpApiKeyEnvVarsToClear("foo_bar", registry), [mcpApiKeyEnvVar("foo_bar")]);
  const sole = { linear: { type: "remote", url: "https://x.test/mcp", auth: "api_key" } };
  assert.deepEqual(
    mcpApiKeyEnvVarsToClear("linear", sole).sort(),
    [mcpApiKeyEnvVar("linear"), legacyMcpApiKeyEnvVar("linear")].sort(),
  );
});

test("splitCommandString handles spaces and quotes", () => {
  assert.deepEqual(splitCommandString("npx -y foo"), ["npx", "-y", "foo"]);
  assert.deepEqual(splitCommandString(`npx -y "my pkg"`), ["npx", "-y", "my pkg"]);
  assert.deepEqual(splitCommandString(`bash -c 'echo hi'`), ["bash", "-c", "echo hi"]);
  assert.deepEqual(splitCommandString(""), []);
});

test("splitCommandString rejects unclosed quotes", () => {
  assert.throws(() => splitCommandString(`npx "oops`), /Unclosed quote/);
});

test("converts remote Punch entries", () => {
  assert.deepEqual(
    punchEntryToAdapter({
      type: "remote",
      enabled: true,
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    }),
    {
      url: "https://mcp.example.com/mcp",
      auth: false,
      headers: { Authorization: "Bearer x" },
    },
  );
  assert.deepEqual(
    punchEntryToAdapter({ type: "remote", enabled: false, url: "https://x.test/mcp" }),
    { url: "https://x.test/mcp", auth: false, disabled: true },
  );
});

test("api_key auth wires bearer tokens for remote MCP", () => {
  assert.equal(usesMcpApiKeyAuth({ auth: "api_key" }), true);
  assert.deepEqual(
    punchEntryToAdapter({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      auth: "api_key",
    }, "linear"),
    {
      url: "https://mcp.example.com/mcp",
      auth: "bearer",
      bearerTokenEnv: "MCP_bGluZWFy_API_KEY",
    },
  );
  assert.deepEqual(
    punchEntryToAdapter({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      auth: "api_key",
      apiKeyHeader: "X-API-Key",
    }, "docs"),
    {
      url: "https://mcp.example.com/mcp",
      headers: { "X-API-Key": "${MCP_ZG9jcw_API_KEY}" },
    },
  );
});

test("api_key auth wires env interpolation for local MCP", () => {
  assert.deepEqual(
    punchEntryToAdapter({
      type: "local",
      command: ["npx", "-y", "some-mcp"],
      auth: "api_key",
      apiKeyEnv: "LINEAR_API_KEY",
    }, "linear"),
    {
      command: "npx",
      args: ["-y", "some-mcp"],
      cwd: "/work",
      env: { LINEAR_API_KEY: "${MCP_bGluZWFy_API_KEY}" },
    },
  );
});

test("api_key auth without serverName does not wire adapter credentials", () => {
  assert.deepEqual(
    punchEntryToAdapter({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      auth: "api_key",
    }),
    { url: "https://mcp.example.com/mcp" },
  );
});

test("punchRegistryToMcpServers wires api_key auth with server names", () => {
  const servers = punchRegistryToMcpServers({
    linear: { type: "remote", url: "https://linear.test/mcp", auth: "api_key" },
    worker: {
      type: "local",
      command: ["node", "mcp.js"],
      auth: "api_key",
      apiKeyEnv: "TOKEN",
    },
  });
  assert.equal(servers.linear.auth, "bearer");
  assert.equal(servers.linear.bearerTokenEnv, mcpApiKeyEnvVar("linear"));
  assert.equal(servers.worker.env.TOKEN, `\${${mcpApiKeyEnvVar("worker")}}`);
});

test("api_key auth strips inline credential headers before bearer wiring", () => {
  assert.deepEqual(
    punchEntryToAdapter({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      auth: "api_key",
      headers: { Authorization: "Bearer inline", "X-Custom": "ok" },
    }, "linear"),
    {
      url: "https://mcp.example.com/mcp",
      auth: "bearer",
      bearerTokenEnv: "MCP_bGluZWFy_API_KEY",
      headers: { "X-Custom": "ok" },
    },
  );
});

test("converts local Punch entries", () => {
  assert.deepEqual(
    punchEntryToAdapter({
      type: "local",
      enabled: true,
      command: ["npx", "-y", "chrome-devtools-mcp@latest"],
      environment: { FOO: "bar" },
    }),
    {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest"],
      cwd: "/work",
      env: { FOO: "bar" },
    },
  );
  assert.deepEqual(
    punchEntryToAdapter({
      type: "local",
      command: "npx -y somepkg",
    }),
    {
      command: "npx",
      args: ["-y", "somepkg"],
      cwd: "/work",
    },
  );
});

test("registry conversion skips invalid and maps names", () => {
  const servers = punchRegistryToMcpServers({
    good: { type: "remote", url: "https://ok.example/mcp" },
    bad: { type: "remote" },
    "no spaces": { type: "local", command: ["echo"] },
    off: { type: "local", enabled: false, command: ["node", "srv.js"] },
  });
  assert.deepEqual(Object.keys(servers).sort(), ["good", "off"]);
  assert.equal(servers.good.url, "https://ok.example/mcp");
  assert.equal(servers.off.disabled, true);
  assert.equal(servers.off.command, "node");
});

test("registry conversion ignores arrays", () => {
  assert.deepEqual(punchRegistryToMcpServers([{ type: "remote", url: "https://x.test/mcp" }]), {});
});

test("rejects credentialed http remote MCP; allows https and plain http", () => {
  assert.equal(
    punchEntryToAdapter({
      type: "remote",
      url: "http://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    }),
    null,
  );
  assert.throws(
    () => assertPunchEntry({
      type: "remote",
      url: "http://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    }),
    /https:\/\//,
  );
  assert.ok(
    punchEntryToAdapter({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x" },
    }),
  );
  assert.deepEqual(
    punchEntryToAdapter({ type: "remote", url: "http://intranet.local/mcp" }),
    { url: "http://intranet.local/mcp", auth: false },
  );
});

test("rejects api_key auth on http remote URLs", () => {
  assert.throws(
    () => assertPunchEntry({
      type: "remote",
      url: "http://mcp.example.com/mcp",
      auth: "api_key",
    }),
    /https:\/\//,
  );
});

test("rejects malformed and non-http remote URLs", () => {
  assert.throws(
    () => assertPunchEntry({ type: "remote", url: "not a URL" }),
    /Invalid remote MCP url/,
  );
  assert.throws(
    () => assertPunchEntry({ type: "remote", url: "ftp://files.example/mcp" }),
    /http:\/\/ or https:\/\//,
  );
  assert.equal(punchEntryToAdapter({ type: "remote", url: "not a URL" }), null);
});

test("assertPunchEntry rejects bad headers and command shapes", () => {
  assert.throws(
    () => assertPunchEntry({ type: "remote", url: "https://x.test/mcp", headers: ["nope"] }),
    /headers must be a JSON object/,
  );
  assert.throws(
    () => assertPunchEntry({ type: "remote", url: "https://x.test/mcp", headers: { Authorization: 1 } }),
    /headers.Authorization must be a string/,
  );
  assert.throws(
    () => assertPunchEntry({ type: "local", command: ["npx", 2] }),
    /non-empty strings/,
  );
  assert.throws(
    () => assertPunchEntry({ type: "local", command: [] }),
    /non-empty command/,
  );
});

test("sanitizeMcpEntryForDisplay redacts all header values", () => {
  const view = sanitizeMcpEntryForDisplay({
    type: "remote",
    url: "https://x.test/mcp",
    headers: { Authorization: "Bearer secret", "X-Custom-Credential": "tok", "X-Custom": "ok" },
    apiKey: "inline-secret",
  });
  assert.equal(view.headers.Authorization, "(set)");
  assert.equal(view.headers["X-Custom-Credential"], "(set)");
  assert.equal(view.headers["X-Custom"], "(set)");
  assert.equal(view.apiKey, undefined);
});

test("redactMcpKeysFromEnvView hides MCP key values", () => {
  const legacyVar = legacyMcpApiKeyEnvVar("foo-bar");
  const view = redactMcpKeysFromEnvView({
    POOLSIDE_API_KEY: "pool",
    MCP_bGluZWFy_API_KEY: "mcp-secret",
    [legacyVar]: "legacy-secret",
    FOO: "bar",
  });
  assert.equal(view.POOLSIDE_API_KEY, "pool");
  assert.equal(view.MCP_bGluZWFy_API_KEY, "(set)");
  assert.equal(view[legacyVar], "(set)");
  assert.equal(view.FOO, "bar");
});

test("isMcpApiKeyConfigured checks new env vars and ignores ambiguous legacy keys", () => {
  const legacyVar = legacyMcpApiKeyEnvVar("foo-bar");
  const registry = {
    "foo-bar": { type: "remote", url: "https://a.test/mcp", auth: "api_key" },
    foo_bar: { type: "remote", url: "https://b.test/mcp", auth: "api_key" },
  };
  assert.equal(isMcpApiKeyConfigured({ [mcpApiKeyEnvVar("foo-bar")]: "x" }, "foo-bar"), true);
  assert.equal(isMcpApiKeyConfigured({ [legacyVar]: "x" }, "foo-bar"), true);
  assert.equal(isMcpApiKeyConfigured({ [legacyVar]: "x" }, "foo-bar", registry), false);
  assert.equal(isMcpApiKeyConfigured({ [legacyVar]: "x" }, "foo_bar", registry), false);
  assert.equal(isMcpApiKeyConfigured({}, "foo-bar"), false);
});

test("adapter root config includes headless settings", () => {
  const cfg = punchRegistryToAdapterConfig({
    docs: { type: "remote", url: "https://docs.example/mcp" },
  });
  assert.equal(cfg.settings.autoAuth, false);
  assert.equal(cfg.settings.hostConfigDiscovery, "off");
  assert.equal(cfg.mcpServers.docs.url, "https://docs.example/mcp");
});

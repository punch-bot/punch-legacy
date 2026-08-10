import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPunchEntry,
  mcpApiKeyEnvVar,
  punchEntryToAdapter,
  punchRegistryToAdapterConfig,
  punchRegistryToMcpServers,
  sanitizeMcpEntryForDisplay,
  splitCommandString,
  usesMcpApiKeyAuth,
} from "../docker/mcp-config.mjs";

test("mcpApiKeyEnvVar normalizes server names", () => {
  assert.equal(mcpApiKeyEnvVar("linear"), "MCP_LINEAR_API_KEY");
  assert.equal(mcpApiKeyEnvVar("my-server"), "MCP_MY_SERVER_API_KEY");
  assert.equal(mcpApiKeyEnvVar("foo__bar"), "MCP_FOO_BAR_API_KEY");
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
      bearerTokenEnv: "MCP_LINEAR_API_KEY",
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
      headers: { "X-API-Key": "${MCP_DOCS_API_KEY}" },
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
      env: { LINEAR_API_KEY: "${MCP_LINEAR_API_KEY}" },
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

test("sanitizeMcpEntryForDisplay redacts sensitive headers", () => {
  const view = sanitizeMcpEntryForDisplay({
    type: "remote",
    url: "https://x.test/mcp",
    headers: { Authorization: "Bearer secret", "X-Custom": "ok" },
  });
  assert.equal(view.headers.Authorization, "(set)");
  assert.equal(view.headers["X-Custom"], "ok");
});

test("adapter root config includes headless settings", () => {
  const cfg = punchRegistryToAdapterConfig({
    docs: { type: "remote", url: "https://docs.example/mcp" },
  });
  assert.equal(cfg.settings.autoAuth, false);
  assert.equal(cfg.settings.hostConfigDiscovery, "off");
  assert.equal(cfg.mcpServers.docs.url, "https://docs.example/mcp");
});

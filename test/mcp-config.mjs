import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPunchEntry,
  punchEntryToAdapter,
  punchRegistryToAdapterConfig,
  punchRegistryToMcpServers,
  splitCommandString,
} from "../docker/mcp-config.mjs";

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

test("adapter root config includes headless settings", () => {
  const cfg = punchRegistryToAdapterConfig({
    docs: { type: "remote", url: "https://docs.example/mcp" },
  });
  assert.equal(cfg.settings.autoAuth, false);
  assert.equal(cfg.settings.hostConfigDiscovery, "off");
  assert.equal(cfg.mcpServers.docs.url, "https://docs.example/mcp");
});

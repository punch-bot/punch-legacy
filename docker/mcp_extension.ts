/**
 * Punch MCP bridge: load /data/mcp.json into pi-mcp-adapter.
 * Discord /mcp owns the registry; this extension injects it as an isolated config.
 */
import { readFileSync } from "node:fs";
import { createMcpAdapter } from "pi-mcp-adapter";
import { punchRegistryToMcpServers } from "/opt/pi/mcp-config.mjs";

const MCP_FILE = "/data/mcp.json";

function loadPunchMcpServers() {
  try {
    const raw = JSON.parse(readFileSync(MCP_FILE, "utf8"));
    return punchRegistryToMcpServers(raw);
  } catch {
    return {};
  }
}

export default createMcpAdapter({
  config: {
    mcpServers: loadPunchMcpServers(),
    settings: {
      autoAuth: false,
      hostConfigDiscovery: "off",
    },
  },
});

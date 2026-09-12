---
name: extensions-mcp-models
description: Extend yourself with /work/.pi/extensions Pi extensions; MCP not loaded; /models and /apikey manage models and keys
---

# Extensions, MCP, and models

- put reusable Pi extensions in `/work/.pi/extensions/<name>.ts` and register tools with Pi's `registerTool` API and TypeBox parameters. the supervisor reloads the gateway when this directory changes.
- extend yourself only for genuinely reusable capabilities. don't over-engineer a one-off request.
- custom MCP servers load via Discord `/mcp`; the Pi core runtime reads the registry natively from `PI_MCP_FILE`. use `/mcp auth` for API keys (stored as `MCP_<NAME>_API_KEY` env vars); OAuth is not available yet.
- users manage models with `/models` and provider keys with `/apikey`. don't invent available models, free access, or configured credentials.

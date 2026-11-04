import * as settings from "../settings.js";

export function buildSlashCommands() {
  return [{
    name: "pair",
    description: "Link your iMessage number to Punch using a pairing code",
    options: [
      { type: 3, name: "code", description: "9-digit code from Punch iMessage", required: true },
    ],
  }, {
    name: "unpair",
    description: "Unlink a paired phone number from your Discord account",
    options: [
      { type: 3, name: "phone", description: "Phone number or email to unpair (omit to unpair all yours)", required: false },
    ],
  }, {
    name: "env",
    description: "Manage sandbox environment variables (hidden from others)",
    options: [
      { type: 1, name: "set", description: "Set an env var",
        options: [
          { type: 3, name: "key", description: "Variable name", required: true },
          { type: 3, name: "value", description: "Variable value", required: true },
        ] },
      { type: 1, name: "list", description: "List all env var keys" },
      { type: 1, name: "delete", description: "Delete an env var",
        options: [
          { type: 3, name: "key", description: "Variable name", required: true },
        ] },
    ],
  }, {
    name: "sandbox",
    description: "Manage sandbox users (create/list/remove)",
    default_member_permissions: "0",
    options: [
      { type: 1, name: "create", description: "Create a new sandbox for a user",
        options: [
          { type: 3, name: "name", description: "Short name (e.g. ember)", required: true },
          { type: 3, name: "userid", description: "Discord user ID (defaults to you)", required: false },
        ] },
      { type: 1, name: "list", description: "List all sandbox users" },
      { type: 1, name: "remove", description: "Remove a sandbox user",
        options: [
          { type: 3, name: "name", description: "User name to remove", required: true },
        ] },
      { type: 1, name: "restart-all", description: "Restart every sandbox container at once (volumes kept)",
        options: [
          { type: 5, name: "recreate", description: "Recreate containers from the current image instead of just restarting (default false)", required: false },
        ] },
    ],
  }, {
    name: "collab",
    description: "Create and inspect two-agent code reviews",
    options: [
      { type: 1, name: "create", description: "Create a shared Git review flow",
        options: [
          { type: 3, name: "reviewer", description: "Other sandbox name", required: true },
          { type: 3, name: "workspace", description: "Your existing Git repo under /work", required: true },
        ] },
      { type: 1, name: "start", description: "Initialize Git and start a two-agent coding task",
        options: [
          { type: 3, name: "reviewer", description: "Other sandbox name", required: true },
          { type: 3, name: "workspace", description: "Project directory under /work", required: true },
          { type: 3, name: "task", description: "Task sent to other agent", required: true },
        ] },
      { type: 1, name: "status", description: "List your collaborations" },
    ],
  }, {
    name: "skills",
    description: "Manage Markdown instruction skills in your sandbox",
    options: [
      { type: 1, name: "list", description: "List instruction skills and requirements" },
      { type: 1, name: "inspect", description: "Inspect a skill",
        options: [{ type: 3, name: "name", description: "Skill name", required: true }] },
      { type: 1, name: "enable", description: "Enable a skill",
        options: [{ type: 3, name: "name", description: "Skill name", required: true }] },
      { type: 1, name: "disable", description: "Disable a skill",
        options: [{ type: 3, name: "name", description: "Skill name", required: true }] },
      { type: 1, name: "proposals", description: "List pending generated-skill proposals" },
      { type: 1, name: "approve", description: "Review and install a proposed skill",
        options: [{ type: 3, name: "id", description: "Proposal id", required: true }] },
      { type: 1, name: "reject", description: "Reject a proposed skill",
        options: [{ type: 3, name: "id", description: "Proposal id", required: true }] },
    ],
  }, {
    name: "extensions",
    description: "Manage Pi extensions (code tools) in your sandbox",
    options: [
      { type: 1, name: "list", description: "List all extensions with status" },
      { type: 1, name: "disable", description: "Disable an extension (requires restart)",
        options: [{ type: 3, name: "name", description: "Extension filename", required: true }] },
      { type: 1, name: "enable", description: "Re-enable a disabled extension (requires restart)",
        options: [{ type: 3, name: "name", description: "Extension filename", required: true }] },
    ],
  }, {
    name: "workers",
    description: "Manage isolated Pi background workers",
    options: [
      { type: 1, name: "start", description: "Start isolated research, coding, or browser worker",
        options: [
          { type: 3, name: "kind", description: "Worker capability", required: true, choices: [{ name: "research", value: "research" }, { name: "coding", value: "coding" }, { name: "browser", value: "browser" }] },
          { type: 3, name: "prompt", description: "Worker task", required: true },
          { type: 3, name: "model", description: "Optional cheaper model" },
          { type: 4, name: "timeout_minutes", description: "1-30; default 10" },
        ] },
      { type: 1, name: "list", description: "List worker runs" },
      { type: 1, name: "stop", description: "Stop a worker", options: [{ type: 3, name: "id", description: "Worker id", required: true }] },
      { type: 1, name: "logs", description: "View worker log", options: [{ type: 3, name: "id", description: "Worker id", required: true }]     },
      { type: 1, name: "cap", description: "Show or set max concurrent workers",
        options: [{ type: 4, name: "value", description: "Max concurrent workers (1-10)", min_value: 1, max_value: 10 }] },
    ],
  }, {
    name: "models",
    description: "View or change your sandbox's AI model and reasoning level",
  }, {
    name: "apikey",
    description: "Set or remove an API key for an AI provider in your sandbox",
    options: [
      { type: 3, name: "provider", description: "Provider: anthropic, openai, google, opencode (Zen), etc.", required: true },
      { type: 3, name: "key", description: "API key (omit to remove the key)" },
    ],
  }, {
    name: "chatgpt",
    description: "Use your ChatGPT Plus/Pro subscription as your sandbox's AI provider",
    options: [
      { type: 1, name: "signin", description: "Sign in with ChatGPT using a one-time code" },
      { type: 1, name: "signout", description: "Sign out of ChatGPT in your sandbox" },
    ],
  }, {
    name: "trigger",
    description: "Set a personal trigger word so Punch responds when you say it",
    options: [
      { type: 1, name: "set", description: "Set your personal trigger word",
        options: [{ type: 3, name: "word", description: "The word that summons Punch for you", required: true }] },
      { type: 1, name: "clear", description: "Remove your personal trigger word" },
    ],
  }, {
    name: "routine",
    description: "Schedule reminders and automations",
    options: [
      { type: 1, name: "add", description: "Add a routine",
        options: [
          { type: 3, name: "type", description: "Reminder message or LLM automation", required: true,
            choices: [{ name: "message", value: "message" }, { name: "llm", value: "llm" }, { name: "heartbeat", value: "heartbeat" }] },
          { type: 3, name: "when", description: "When to run (e.g. 30m, tomorrow 9am)", required: true },
          { type: 3, name: "text", description: "Reminder text or LLM prompt", required: true },
          { type: 3, name: "recurrence", description: "Recurrence pattern",
            choices: [
              { name: "once", value: "once" },
              { name: "daily", value: "daily" },
              { name: "weekly", value: "weekly" },
            ] },
          { type: 3, name: "timezone", description: "IANA timezone, e.g. America/New_York" },
          { type: 4, name: "active_start", description: "Optional active hour start (0-23)" },
          { type: 4, name: "active_end", description: "Optional active hour end (0-23)" },
          { type: 5, name: "isolated_session", description: "LLM routine starts fresh Pi session" },
        ] },
      { type: 1, name: "history", description: "View recent routine runs and errors",
        options: [{ type: 3, name: "id", description: "Optional routine id" }] },
      { type: 1, name: "remove", description: "Remove a routine",
        options: [{ type: 3, name: "id", description: "Routine id", required: true }] },
      { type: 1, name: "pause", description: "Pause a routine",
        options: [{ type: 3, name: "id", description: "Routine id", required: true }] },
      { type: 1, name: "resume", description: "Resume a routine",
        options: [{ type: 3, name: "id", description: "Routine id", required: true }] },
    ],
  }, {
    name: "remind",
    description: "Quick one-shot reminder in this channel",
    options: [
      { type: 3, name: "when", description: "When to remind (e.g. 30m, tomorrow 9am)", required: true },
      { type: 3, name: "message", description: "Reminder text", required: true },
    ],
  }, {
    name: "memory",
    description: "Search, view, export, or compact your Punch memory",
    options: [
      { type: 1, name: "view", description: "Show your sandbox's .punch-memory.md contents" },
      { type: 1, name: "search", description: "Find relevant stored memory",
        options: [{ type: 3, name: "query", description: "What to remember", required: true }] },
      { type: 1, name: "explain", description: "Show why memories matched",
        options: [{ type: 3, name: "query", description: "Search query", required: true }] },
      { type: 1, name: "compact", description: "Remove duplicate durable memories" },
      { type: 1, name: "export", description: "Download your durable user memories" },
      { type: 1, name: "import", description: "Import your durable memories from Punch export",
        options: [{ type: 11, name: "file", description: "JSON file from /memory export", required: true }] },
    ],
  }, {
    name: "doctor",
    description: "Diagnose your Punch sandbox and connected services",
    options: [
      { type: 3, name: "sandbox", description: "Sandbox name (Discord administrators only)" },
      { type: 5, name: "deep", description: "Run browser and filesystem probes" },
    ],
  }, {
    name: "logs",
    description: "View your sandbox and Pi gateway logs (ephemeral)",
    options: [
      { type: 1, name: "tail", description: "Show recent log lines",
        options: [
          { type: 3, name: "source", description: "Which logs to show",
            choices: [
              { name: "all (supervisor + serve)", value: "all" },
              { name: "supervisor", value: "supervisor" },
              { name: "Pi gateway", value: "serve" },
              { name: "turn activity", value: "activity" },
            ] },
          { type: 4, name: "lines", description: "Lines to show (default 30, max 100)" },
        ] },
      { type: 1, name: "status", description: "Sandbox health and recent events" },
    ],
  }, {
    name: "timeout",
    description: "Toggle idle/stale timeouts that abort hung Pi turns",
    options: [
      { type: 1, name: "disable", description: "Disable idle/stale timeouts for your turns (hard ceiling still applies)" },
      { type: 1, name: "enable", description: "Re-enable idle/stale timeouts (default)" },
      { type: 1, name: "status", description: "Show whether idle/stale timeouts are disabled" },
    ],
  }, {
    name: "reset",
    description: "Start a fresh Pi session in this channel (drops prior context)",
  }, {
    name: "botmode",
    description: "Experimental toggles: let bots trigger Punch, disable thinking message, or toggle git co-author",
    options: [
      { type: 1, name: "allow-bots", description: "Allow messages authored by bots to trigger Punch",
        options: [
          { type: 3, name: "state", description: "on / off / status", required: true,
            choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }, { name: "status", value: "status" }] },
        ] },
      { type: 1, name: "no-thinking", description: "Disable the rotating 🤔 thinking message for your turns",
        options: [
          { type: 3, name: "state", description: "on / off / status", required: true,
            choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }, { name: "status", value: "status" }] },
        ] },
      { type: 1, name: "show-context", description: "Always show a context-window % indicator under each reply",
        options: [
          { type: 3, name: "state", description: "on / off / status", required: true,
            choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }, { name: "status", value: "status" }] },
        ] },
      { type: 1, name: "git-co-author", description: "Add Co-Authored-By: Punch trailer to git commits",
        options: [
          { type: 3, name: "state", description: "on / off / status", required: true,
            choices: [{ name: "on", value: "on" }, { name: "off", value: "off" }, { name: "status", value: "status" }] },
        ] },
      { type: 1, name: "auto-compress", description: "Prompt selective context pruning at a threshold (50-75%, 0 to disable)",
        options: [
          { type: 4, name: "threshold", description: "Context % threshold (50-75, 0=off)", required: false, min_value: 0, max_value: 75 },
        ] },
    ],
  }, {
    name: "compress",
    description: "Compress (summarize) the conversation in this channel to free up context",
  }, {
    name: "mcp",
    description: "Manage MCP servers loaded into Pi",
    options: [
      { type: 1, name: "list", description: "List configured MCP servers" },
      { type: 1, name: "add", description: "Add a local or remote MCP server",
        options: [
          { type: 3, name: "name", description: "Unique MCP server name", required: true },
          { type: 3, name: "type", description: "local (command) or remote (URL)", required: true,
            choices: [{ name: "local", value: "local" }, { name: "remote", value: "remote" }] },
          { type: 3, name: "url", description: "Remote MCP URL (required for remote)" },
          { type: 3, name: "command", description: "Local command, space-separated (required for local, e.g. 'npx -y <pkg>')" },
          { type: 3, name: "key", description: "API key (Bearer auth for remote; env for local — use api_key_env to name it)" },
          { type: 3, name: "api_key_env", description: "Local env var name the MCP reads (default API_KEY)" },
          { type: 3, name: "api_key_header", description: "Remote header name for the key (default Authorization Bearer)" },
          { type: 3, name: "headers", description: "Remote headers JSON (non-auth headers only; use key for API keys)" },
          { type: 3, name: "environment", description: "Local env JSON (non-secret vars only)" },
        ] },
      { type: 1, name: "remove", description: "Remove an MCP server",
        options: [{ type: 3, name: "name", description: "MCP server name", required: true }] },
      { type: 1, name: "auth", description: "Set or rotate an MCP server's API key",
        options: [
          { type: 3, name: "name", description: "MCP server name", required: true },
          { type: 3, name: "key", description: "API key", required: true },
        ] },
      { type: 1, name: "logout", description: "Remove stored API key for an MCP server",
        options: [{ type: 3, name: "name", description: "MCP server name", required: true }] },
    ],
  }, {
    name: "heartbeat",
    description: "Schedule autonomous heartbeat automations (run in your sandbox, DM you results)",
    options: [
      { type: 1, name: "add", description: "Add a heartbeat automation",
        options: [
          { type: 3, name: "when", description: "Schedule (e.g. every 6h, daily 9am, every 30m)", required: true },
          { type: 3, name: "prompt", description: "What the agent should do each time", required: true },
        ] },
      { type: 1, name: "list", description: "List your heartbeat automations" },
      { type: 1, name: "remove", description: "Remove a heartbeat",
        options: [{ type: 3, name: "id", description: "Heartbeat ID", required: true }] },
      { type: 1, name: "pause", description: "Pause a heartbeat",
        options: [{ type: 3, name: "id", description: "Heartbeat ID", required: true }] },
      { type: 1, name: "resume", description: "Resume a heartbeat",
        options: [{ type: 3, name: "id", description: "Heartbeat ID", required: true }] },
      { type: 1, name: "history", description: "View recent autonomous activity" },
    ],
  }, {
    name: "statistics",
    description: "View your Punch usage analytics (messages, tokens, and more)",
  }, {
    name: "tailscale",
    description: "Manage your sandbox's Tailscale connection",
    options: [
      { type: 1, name: "key", description: "Set a Tailscale auth key and connect",
        options: [{ type: 3, name: "authkey", description: "Tailscale auth key (tskey-...)", required: true }] },
      { type: 1, name: "login", description: "Authenticate interactively via browser link" },
      { type: 1, name: "reauth", description: "Force re-authentication" },
      { type: 1, name: "status", description: "Check Tailscale connection status" },
      { type: 1, name: "down", description: "Disconnect Tailscale" },
    ],
  }, {
    name: "provider",
    description: "Manage custom LLM providers",
    options: [
      { type: 1, name: "add", description: "Add a custom provider",
        options: [
          { type: 3, name: "name", description: "Provider name (used for /apikey set <name>)", required: true },
          { type: 3, name: "endpoint", description: "Base URL (e.g. https://api.my-llm.com/v1)", required: true },
          { type: 3, name: "api", description: "API format",
            choices: [
              { name: "OpenAI Completions", value: "openai-completions" },
              { name: "OpenAI Chat", value: "openai-chat" },
            ] },
        ] },
      { type: 1, name: "edit", description: "Edit a custom provider's endpoint or API format",
        options: [
          { type: 3, name: "name", description: "Provider name", required: true },
          { type: 3, name: "endpoint", description: "New base URL" },
          { type: 3, name: "api", description: "New API format",
            choices: [
              { name: "OpenAI Completions", value: "openai-completions" },
              { name: "OpenAI Chat", value: "openai-chat" },
            ] },
        ] },
      { type: 1, name: "remove", description: "Remove a custom provider and its models",
        options: [{ type: 3, name: "name", description: "Provider name", required: true }] },
      { type: 1, name: "list", description: "List providers (built-in and custom)" },
      {
        type: 2, name: "model", description: "Manage models for a custom provider",
        options: [
          { type: 1, name: "add", description: "Add a model to a custom provider",
            options: [
              { type: 3, name: "provider", description: "Provider name", required: true },
              { type: 3, name: "model", description: "Model ID (e.g. my-model-v1)", required: true },
              { type: 3, name: "name", description: "Display name (defaults to prettified model ID)" },
              { type: 4, name: "context", description: "Context window size (default 128000)" },
              { type: 4, name: "max_tokens", description: "Max output tokens (default 4096)" },
              { type: 5, name: "reasoning", description: "Supports reasoning/thinking (default No)" },
            ] },
          { type: 1, name: "edit", description: "Edit a model's details via modal",
            options: [
              { type: 3, name: "provider", description: "Provider name", required: true },
              { type: 3, name: "model", description: "Model ID", required: true },
            ] },
          { type: 1, name: "remove", description: "Remove a model from a custom provider",
            options: [
              { type: 3, name: "provider", description: "Provider name", required: true },
              { type: 3, name: "model", description: "Model ID to remove", required: true },
            ] },
          { type: 1, name: "list", description: "List models for a custom provider",
            options: [
              { type: 3, name: "provider", description: "Provider name", required: true },
            ] },
        ],
      },
    ],
  }, settings.getSlashCommandDefinition()];
}

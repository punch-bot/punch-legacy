// Punch Nightly bootstrap. Thin entrypoint — all real logic lives in
// src/core, src/chat, src/commands, src/gateway, and the top-level
// module files this imports.

import "dotenv/config";
import { REST, Routes, Events } from "discord.js";
import * as sandbox from "./sandbox-manager.js";
import * as routines from "./routines.js";
import { reloadSandboxMap } from "./agent.js";
import { TOKEN } from "./core/config.js";
import { createClient } from "./core/discord.js";
import { registry } from "./core/registry.js";
import { registerMessageCreate } from "./chat/message-create.js";
import { registerReactionAdd } from "./chat/reaction-add.js";
import { registerInteractions } from "./commands/interactions.js";
import { buildSlashCommands } from "./commands/slash.js";
import { fireRoutine } from "./chat/routines-fire.js";
import { startBotHttpServer } from "./gateway/bot-server.js";

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const client = createClient();
registry.client = client;

registerMessageCreate(client);
registerReactionAdd(client);
registerInteractions(client);

client.once(Events.ClientReady, async (c) => {
  console.log(`punch online as ${c.user.tag}`);
  reloadSandboxMap();

  // Boot all dynamic sandboxes on startup
  for (const u of sandbox.loadUsers()) {
    const up = await sandbox.composeUp(u.name);
    if (up.ok) {
      console.log(`[sandbox] booted sandbox-${u.name}`);
    } else {
      console.error(`[sandbox] failed to boot sandbox-${u.name}: ${up.error}`);
    }
  }

  const slashCmd = buildSlashCommands();
  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    // Guild-only registration updates instantly (global can lag ~1h). Clear global
    // copies so Discord does not show each command twice.
    await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
    for (const g of c.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(c.user.id, g.id), { body: slashCmd });
    }
    console.log(`Registered ${slashCmd.length} slash commands in ${c.guilds.cache.size} guild(s)`);
  } catch (err) {
    console.error("Failed to register slash commands:", err.message);
  }

  routines.startScheduler(fireRoutine);
});

startBotHttpServer();

client.login(TOKEN);

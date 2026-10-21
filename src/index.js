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
import { fireRoutine, syncMemoryAuditRoutines } from "./chat/routines-fire.js";
import { startBotHttpServer } from "./gateway/bot-server.js";
import { initializeMemory } from "./memory.js";

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const memoryStatus = initializeMemory({ strict: false });
if (!memoryStatus.available) console.error(`${memoryStatus.error} Memory is disabled; inspect /doctor and restore the source/backup before retrying.`);

const client = createClient();
registry.client = client;

registerMessageCreate(client);
registerReactionAdd(client);
registerInteractions(client);

client.once(Events.ClientReady, async (c) => {
  console.log(`punch online as ${c.user.tag}`);
  reloadSandboxMap();

  try {
    const { startSpectrumAlongsideBot } = await import("./spectrum/boot.js");
    registry.spectrumHandle = await startSpectrumAlongsideBot();
    if (registry.spectrumHandle && !registry.spectrumSignalsBound) {
      registry.spectrumSignalsBound = true;
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
          void shutdownSpectrum(signal);
        });
      }
    }
  } catch (err) {
    console.error(
      "[spectrum] failed to boot alongside Discord:",
      err && err.message ? err.message : String(err),
    );
  }

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
    await rest.put(Routes.applicationCommands(c.user.id), { body: [] });
    for (const g of c.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(c.user.id, g.id), { body: slashCmd });
    }
    console.log(`Registered ${slashCmd.length} slash commands in ${c.guilds.cache.size} guild(s)`);
  } catch (err) {
    console.error("Failed to register slash commands:", err.message);
  }

  syncMemoryAuditRoutines();
  routines.startScheduler(fireRoutine);
});

startBotHttpServer();

async function shutdownSpectrum(signal) {
  if (registry.spectrumShuttingDown || !registry.spectrumHandle) return;
  registry.spectrumShuttingDown = true;
  const handle = registry.spectrumHandle;
  registry.spectrumHandle = null;
  try {
    await handle.stop();
    console.log(`[spectrum] stopped on ${signal}`);
  } catch (err) {
    console.error("[spectrum] stop failed:", err && err.message ? err.message : String(err));
  }
}

client.login(TOKEN);

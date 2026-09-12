// Punch Nightly bootstrap. Thin entrypoint — all real logic lives in
// src/core, src/chat, src/commands, src/gateway, and the top-level
// module files this imports.

import "dotenv/config";
import { REST, Routes, Events } from "discord.js";
import * as routines from "./routines.js";
import { listSandboxes, restartSandbox, sandboxProviderEnabled } from "./core/sandbox-provider.js";
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

  // Photon / Spectrum: auto-start when SPECTRUM_* is configured (same process as Discord).
  try {
    const { startSpectrumAlongsideBot } = await import("./spectrum/boot.js");
    registry.spectrumHandle = await startSpectrumAlongsideBot();
    if (registry.spectrumHandle && !registry.spectrumSignalsBound) {
      registry.spectrumSignalsBound = true;
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
          // Discord owns process lifetime; only sync-stop Spectrum here.
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

  // Photon / Spectrum: auto-start when SPECTRUM_* is configured (same process as Discord).
  try {
    const { startSpectrumAlongsideBot } = await import("./spectrum/boot.js");
    spectrumHandle = await startSpectrumAlongsideBot();
    if (spectrumHandle && !spectrumSignalsBound) {
      spectrumSignalsBound = true;
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
          // Discord owns process lifetime; only sync-stop Spectrum here.
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

  // Ensure all dynamic sandboxes are running (lifecycle owned by the sandbox host)
  if (sandboxProviderEnabled) {
    try {
      for (const entry of await listSandboxes()) {
        if (entry.running) {
          console.log(`[sandbox] sandbox-${entry.name} running`);
          continue;
        }
        try {
          await restartSandbox(entry.name);
          console.log(`[sandbox] started sandbox-${entry.name}`);
        } catch (err) {
          console.error(`[sandbox] failed to start sandbox-${entry.name}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[sandbox] sandbox provider unreachable: ${err.message}`);
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

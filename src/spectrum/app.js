// @ts-nocheck
/**
 * Spectrum app factory and inbound message loop for Punch.
 * Official APIs: Spectrum(), imessage.config(), terminal.config(), app.messages, space.responding, message.reply.
 * Integrates with untyped Punch turn helpers; skip checkJs for this module.
 */

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { buildProviderConfigs, buildSpectrumOptions } from "./providers.js";
import { resolvePunchUserId } from "./identity.js";
import { issuePairingCode, mergeUserMaps } from "./pairing.js";
import { runPunchTurn } from "../punch-turn.js";

/**
 * Extract plain text from a Spectrum message content union.
 * @param {any} content
 */
export function extractInboundText(content) {
  if (!content || typeof content !== "object") return "";
  if (content.type === "text" && content.text) return String(content.text).trim();
  if (content.type === "markdown" && content.markdown) return String(content.markdown).trim();
  // Nested reply/edit wrappers
  if ((content.type === "reply" || content.type === "edit") && content.content) {
    return extractInboundText(content.content);
  }
  return "";
}

/**
 * Create a Spectrum app instance from validated Punch Spectrum config.
 * @param {ReturnType<import("./config.js").loadSpectrumConfig>} config
 * @param {{ Spectrum?: typeof Spectrum, imessage?: typeof imessage, terminal?: typeof terminal }} [deps]
 */
export async function createSpectrumApp(config, deps = {}) {
  const SpectrumFn = deps.Spectrum || Spectrum;
  const imessageMod = deps.imessage || imessage;
  const terminalMod = deps.terminal || terminal;

  const providers = buildProviderConfigs(config.providers, {
    imessage: imessageMod,
    terminal: terminalMod,
  });

  const options = buildSpectrumOptions({
    providers,
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    logLevel: process.env.SPECTRUM_LOG_LEVEL || process.env.LOG_LEVEL,
  });

  // Spectrum's overloads distinguish credentialed vs projectless; Punch builds either at runtime.
  return SpectrumFn(/** @type {any} */ (options));
}

/**
 * @param {unknown} space
 * @param {unknown} message
 * @param {ReturnType<import("./config.js").loadSpectrumConfig>} config
 */
export async function handleSpectrumMessage(space, message, config) {
  if (!message || typeof message !== "object") return;
  const msg = /** @type {{ direction?: string, content?: object, sender?: object, platform?: string }} */ (
    message
  );
  if (msg.direction === "outbound") return;

  const text = extractInboundText(msg.content);
  if (!text) return;

  const sp = /** @type {{ id?: string, responding?: Function, send?: Function }} */ (space);
  const reply = async (body) => {
    const m = /** @type {{ reply?: Function }} */ (message);
    if (typeof m.reply === "function") {
      await m.reply(body);
      return;
    }
    if (typeof sp.send === "function") {
      await sp.send(body);
    }
  };

  const run = async () => {
    if (config.mode === "echo") {
      await reply(text);
      return;
    }

    const sender = msg.sender || null;
    // Default-user fallback is only for the trusted local terminal provider.
    // iMessage uses SPECTRUM_USER_MAP + durable /pair bindings; unknown numbers get a code.
    const allowDefault = msg.platform === "terminal";
    const userMap = mergeUserMaps(config.userMap);
    const userId = resolvePunchUserId(sender, { ...config, userMap }, null, { allowDefault });
    if (!userId) {
      if (allowDefault) {
        await reply(
          "Punch could not map this Spectrum sender to a sandbox user. " +
            "Set SPECTRUM_DEFAULT_USER_ID for the terminal provider, or /pair from Discord.",
        );
        return;
      }

      const address =
        (sender && (sender.address || sender.id)) ||
        "";
      try {
        const issued = issuePairingCode(String(address));
        await reply(issued.message);
      } catch {
        await reply(
          "Hey, i don't know who you are! Text again in a moment, or run /pair in discord once you have a code.",
        );
      }
      return;
    }

    // Scope sessions per Punch user so shared spaces cannot reuse another user's Pi session.
    const sessionKey = `spectrum:${userId}:${sp.id || "unknown"}`;
    const speaker =
      (sender && (sender.address || sender.id)) ||
      `${msg.platform || "spectrum"}-user`;

    const result = await runPunchTurn({
      userId,
      sessionKey,
      text,
      speaker: String(speaker),
    });

    if (!result.ok) {
      await reply(/** @type {{ error: string }} */ (result).error);
      return;
    }
    await reply(/** @type {{ text: string }} */ (result).text);
  };

  if (typeof sp.responding === "function") {
    await sp.responding(run);
  } else {
    await run();
  }
}

/**
 * Run the inbound message loop until the app stops.
 * @param {Awaited<ReturnType<typeof createSpectrumApp>>} app
 * @param {ReturnType<import("./config.js").loadSpectrumConfig>} config
 */
export async function runSpectrumLoop(app, config) {
  console.log(
    `[spectrum] listening mode=${config.mode} providers=${config.providers.join(",")} ` +
      `(project credentials ${config.hasProjectCredentials ? "set" : "not required"})`,
  );
  for await (const [space, message] of app.messages) {
    try {
      await handleSpectrumMessage(space, message, config);
    } catch {
      // Avoid logging raw SDK/agent errors — they may embed request options or secrets.
      console.error("[spectrum] turn failed (details omitted)");
    }
  }
}

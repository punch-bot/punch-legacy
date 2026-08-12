// @ts-nocheck
/**
 * Spectrum app factory and inbound message loop for Punch.
 * Official APIs: Spectrum(), imessage.config(), terminal.config(), app.messages, space.responding, message.reply.
 * Integrates with untyped Punch turn helpers; skip checkJs for this module.
 */

import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { buildProviderConfigs, buildSpectrumOptions } from "./providers.js";
import { resolvePunchUserId } from "./identity.js";
import { issuePairingCode, mergeUserMaps } from "./pairing.js";
import { runPunchTurn } from "../punch-turn.js";

/**
 * @param {string} value
 */
function maskAddress(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 4) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} [fields]
 */
function logSpectrum(message, fields = {}) {
  const suffix = Object.keys(fields).length
    ? ` ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`
    : "";
  console.log(`[spectrum] ${message}${suffix}`);
}

/**
 * @param {unknown} err
 */
function safeErrorMessage(err) {
  const message = err && typeof err === "object" && "message" in err
    ? String(/** @type {{ message: unknown }} */ (err).message)
    : String(err);
  return message.replace(/\b(sk_[a-zA-Z0-9_-]{8,}|sec_[a-zA-Z0-9_-]{8,})\b/g, "[redacted]");
}

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
  const msg = /** @type {{ direction?: string, content?: { type?: string }, sender?: { address?: string, id?: string, service?: string }, platform?: string }} */ (
    message
  );
  if (msg.direction === "outbound") return;

  const inboundText = extractInboundText(msg.content);
  const sender = msg.sender || null;
  const senderLabel = maskAddress(sender?.address || sender?.id || "");
  const service = sender?.service || "unknown";

  if (!inboundText) {
    logSpectrum("skip inbound without text", {
      platform: msg.platform || "unknown",
      content: msg.content?.type || "unknown",
      service,
      sender: senderLabel || "unknown",
    });
    return;
  }

  logSpectrum("inbound", {
    platform: msg.platform || "unknown",
    service,
    sender: senderLabel || "unknown",
    len: inboundText.length,
  });

  const sp = /** @type {{ id?: string, responding?: Function, send?: Function }} */ (space);
  const reply = async (body) => {
    const payload = String(body || "").trim();
    if (!payload) return;
    if (typeof sp.send === "function") {
      const sent = await sp.send(text(payload));
      logSpectrum("outbound", {
        delivered: sent ? "yes" : "no",
        len: payload.length,
      });
      if (!sent) {
        throw new Error("Spectrum outbound send returned no message (check Photon user allowlist)");
      }
      return;
    }
    const m = /** @type {{ reply?: Function }} */ (message);
    if (typeof m.reply === "function") {
      await m.reply(payload);
    }
  };

  const allowDefault = msg.platform === "terminal";
  const userMap = mergeUserMaps(config.userMap);
  const userId = resolvePunchUserId(sender, { ...config, userMap }, null, { allowDefault });
  const pairingOnly = config.mode === "agent" && !userId;

  const run = async () => {
    if (config.mode === "echo") {
      await reply(inboundText);
      return;
    }

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
      text: inboundText,
      speaker: String(speaker),
    });

    if (!result.ok) {
      await reply(/** @type {{ error: string }} */ (result).error);
      return;
    }
    await reply(/** @type {{ text: string }} */ (result).text);
  };

  // Pairing/echo replies must not wait on typing indicators (RCS can hang there).
  if (pairingOnly || config.mode === "echo" || typeof sp.responding !== "function") {
    await run();
    return;
  }

  await sp.responding(run);
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
    } catch (err) {
      console.error(`[spectrum] turn failed: ${safeErrorMessage(err)}`);
    }
  }
}

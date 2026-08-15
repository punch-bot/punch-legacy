// @ts-nocheck
/**
 * Outbound Spectrum (Photon) messages from the Discord bot process.
 */

import { text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

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
 * Send a plain-text DM to a phone number or email via Spectrum iMessage.
 * @param {unknown} app Spectrum app instance from startSpectrumAlongsideBot()
 * @param {string} address E.164 phone or email
 * @param {string} body
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function sendSpectrumText(app, address, body) {
  const to = String(address || "").trim();
  const payload = String(body || "").trim();
  if (!app) return { ok: false, error: "Spectrum is not running." };
  if (!to) return { ok: false, error: "Missing recipient address." };
  if (!payload) return { ok: false, error: "Missing message body." };

  try {
    const im = imessage(app);
    const user = await im.user(to);
    const space = await im.space.create(user);
    const sent = await space.send(text(payload));
    if (!sent) {
      return { ok: false, error: "Spectrum outbound send returned no message." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: safeErrorMessage(err) };
  }
}

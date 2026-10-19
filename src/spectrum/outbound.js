import { text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

function safeErrorMessage(err) {
  const message = err && typeof err === "object" && "message" in err
    ? String(err.message)
    : String(err);
  return message.replace(/\b(sk_[a-zA-Z0-9_-]{8,}|sec_[a-zA-Z0-9_-]{8,})\b/g, "[redacted]");
}

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

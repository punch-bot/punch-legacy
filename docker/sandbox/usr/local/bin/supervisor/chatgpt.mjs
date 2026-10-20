import { createDeviceSignin } from "/usr/local/lib/device-signin.mjs";
import { AUTH_FILE, loadJSON, log } from "./state.mjs";
import { forceRestart } from "./gateway.mjs";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_PROVIDER_MODULE = "/opt/pi/node_modules/@punch-bot/ai/dist/providers/openai-codex.js";
const PI_AUTH_STORAGE_MODULE = "/opt/pi/node_modules/@punch-bot/cli/dist/core/auth-storage.js";

async function codexLogin(interaction) {
  const { openaiCodexProvider } = await import(CODEX_PROVIDER_MODULE);
  return openaiCodexProvider().auth.oauth.login(interaction);
}

async function piAuthStorage() {
  const { AuthStorage } = await import(PI_AUTH_STORAGE_MODULE);
  return AuthStorage.create(AUTH_FILE);
}

async function saveCodexCredential(credential, signal) {
  await (await piAuthStorage()).modify(CODEX_PROVIDER_ID, async () => credential, { signal });
  log("chatgpt sign-in saved");
  forceRestart();
}

async function removeCodexCredential() {
  if (!loadJSON(AUTH_FILE)[CODEX_PROVIDER_ID]) return false;
  await (await piAuthStorage()).delete(CODEX_PROVIDER_ID);
  log("chatgpt signed out");
  forceRestart();
  return true;
}

const signin = createDeviceSignin({ login: codexLogin, save: saveCodexCredential });

function reply(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function signedIn() {
  return loadJSON(AUTH_FILE)[CODEX_PROVIDER_ID]?.type === "oauth";
}

export function handleChatgptRoutes(req, res, url) {
  if (req.method === "GET" && url.pathname === "/chatgpt") {
    reply(res, 200, { ...signin.status(), signedIn: signedIn() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/chatgpt/login") {
    signin.start().then((flow) => {
      if (flow.status === "error") log("chatgpt sign-in:", flow.error);
      reply(res, flow.status === "error" ? 502 : 200, { ...flow, signedIn: signedIn() });
    });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/chatgpt") {
    signin.cancel();
    removeCodexCredential()
      .then((removed) => reply(res, 200, { success: true, removed }))
      .catch((error) => {
        log("chatgpt sign-out:", error.message);
        reply(res, 500, { error: error.message });
      });
    return true;
  }

  return false;
}

import { createDeviceSignin } from "/usr/local/lib/device-signin.mjs";
import { AUTH_FILE, loadJSON, log, saveJSON } from "./state.mjs";
import { forceRestart } from "./gateway.mjs";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_PROVIDER_MODULE = "/opt/pi/node_modules/@punch-bot/ai/dist/providers/openai-codex.js";

async function codexLogin(interaction) {
  const { openaiCodexProvider } = await import(CODEX_PROVIDER_MODULE);
  return openaiCodexProvider().auth.oauth.login(interaction);
}

function saveCodexCredential(credential) {
  const auth = loadJSON(AUTH_FILE);
  auth[CODEX_PROVIDER_ID] = credential;
  saveJSON(AUTH_FILE, auth);
  log("chatgpt sign-in saved");
  forceRestart();
}

function removeCodexCredential() {
  const auth = loadJSON(AUTH_FILE);
  if (!auth[CODEX_PROVIDER_ID]) return false;
  delete auth[CODEX_PROVIDER_ID];
  saveJSON(AUTH_FILE, auth);
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
    reply(res, 200, { success: true, removed: removeCodexCredential() });
    return true;
  }

  return false;
}

import { apiUrlFor } from "../agent.js";
import { supervisorAuth } from "./config.js";

export async function ensureUserSandbox(userId) {
  const apiUrl = apiUrlFor(userId);
  if (!apiUrl || !userId) return null;
  try {
    const res = await fetch(`${apiUrl}/env`, {
      headers: {
        authorization: supervisorAuth(),
      },
    });
    if (!res.ok) throw new Error(`sandbox reachability check failed: ${res.status}`);
    return apiUrl;
  } catch (err) {
    console.error(`[sandbox] cannot reach sandbox for ${userId} at ${apiUrl}:`, err.message);
    return null;
  }
}

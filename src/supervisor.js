import * as sandbox from "./sandbox-manager.js";

const BASE = (process.env.PUNCH_SUPERVISOR_URL || "http://supervisor:4100").replace(/\/+$/, "");
const TOKEN = process.env.PUNCH_SUPERVISOR_TOKEN || "";
const ENABLED = process.env.PUNCH_SUPERVISOR_URL !== "0" && process.env.PUNCH_SUPERVISOR_URL !== "";

function headers(extra = {}) {
	const result = { "content-type": "application/json", ...extra };
	if (TOKEN) result.authorization = `Bearer ${TOKEN}`;
	return result;
}

async function request(method, path, { body, sandboxName } = {}) {
	const extra = {};
	if (sandboxName) extra["x-punch-sandbox"] = sandboxName;
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: headers(extra),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { raw: text };
	}
	if (!response.ok) throw new Error(data?.error || `${response.status} ${text}`);
	return data;
}

export const supervisorEnabled = ENABLED;

export const routines = {
	list: (userId) => request("GET", `/routines?userId=${encodeURIComponent(userId)}`),
	create: (payload) => request("POST", "/routines", { body: payload }),
	remove: (id, userId) => request("DELETE", `/routines/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`),
	pause: (id, userId) => request("POST", `/routines/${encodeURIComponent(id)}/pause?userId=${encodeURIComponent(userId)}`),
	resume: (id, userId) => request("POST", `/routines/${encodeURIComponent(id)}/resume?userId=${encodeURIComponent(userId)}`),
	history: (id, userId, limit = 20) =>
		request(
			"GET",
			`/routines/${encodeURIComponent(id)}/history?userId=${encodeURIComponent(userId)}&limit=${limit}`,
		),
};

export const collabs = {
	listFor: async (actor) => (await request("GET", "/collabs", { sandboxName: actor })).collabs,
	getFor: async (id, actor) => (await request("GET", `/collabs/${encodeURIComponent(id)}`, { sandboxName: actor })).collab,
	create: async ({ owner, reviewer, workspace, task }) =>
		(await request("POST", "/collabs/create", { sandboxName: owner, body: { reviewer, workspace, task } })).collab,
	propose: async ({ id, actor, head }) =>
		(await request("POST", `/collabs/${encodeURIComponent(id)}/propose`, { sandboxName: actor, body: { head } })).collab,
	review: async ({ id, actor, approve, notes }) =>
		(await request("POST", `/collabs/${encodeURIComponent(id)}/review`, { sandboxName: actor, body: { approve, notes } })).collab,
};

/**
 * Host registration. A host is wherever participant workspaces live: this bot's
 * Docker sandboxes, a Desktop app's local worktrees, a remote worker. The
 * supervisor routes collab exec calls to whichever live host serves a
 * participant, so each host advertises its base URL and participant names.
 */
export const hosts = {
	register: (payload) => request("POST", "/hosts/register", { body: payload }),
	unregister: (name) => request("POST", "/hosts/unregister", { body: { name } }),
	list: async () => (await request("GET", "/hosts")).hosts,
};

/**
 * Advertise this host to the supervisor and keep the registration fresh.
 * Returns a stop function. No-op when the supervisor is disabled.
 */
export function registerHost({ name, url, participants, token, intervalMs = 30000 } = {}) {
	if (!ENABLED) return () => {};
	let stopped = false;
	const tick = async () => {
		if (stopped) return;
		try {
			const names = typeof participants === "function" ? await participants() : participants;
			await hosts.register({
				name: name || process.env.PUNCH_HOST_NAME || "discord-bot",
				url: url || process.env.PUNCH_HOST_URL || "",
				participants: names || [],
				token: token || process.env.PUNCH_SUPERVISOR_TOKEN || "",
				kind: "sandbox",
			});
		} catch (err) {
			console.warn(`[supervisor] host registration failed: ${err.message}`);
		}
	};
	void tick();
	const timer = setInterval(tick, intervalMs);
	timer.unref?.();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}


/**
 * Git runner the supervisor uses for collab work. The supervisor owns the state
 * machine; hosts own execution, so each git call names the participant whose
 * host should run it. Kept for in-process use (tests); the supervisor service
 * routes to hosts over HTTP via ../supervisor/src/exec.js.
 */
export function collabGitRunner() {
	return async (args, sandboxName) => {
		if (!sandboxName) throw new Error("collab git call requires a sandbox name");
		const result = await sandbox.gitInSandbox(sandboxName, args);
		return result.stdout.trim();
	};
}

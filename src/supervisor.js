const RAW_URL = process.env.PUNCH_SUPERVISOR_URL || "";
const BASE = (RAW_URL || "http://supervisor:4100").replace(/\/+$/, "");
const TOKEN = process.env.PUNCH_SUPERVISOR_TOKEN || "";
const ENABLED = RAW_URL !== "0" && RAW_URL !== "";
const RAW_TIMEOUT_MS = Number(process.env.PUNCH_SUPERVISOR_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(RAW_TIMEOUT_MS) && RAW_TIMEOUT_MS > 0 ? RAW_TIMEOUT_MS : 15000;

function headers(extra = {}) {
	const result = { "content-type": "application/json", ...extra };
	if (TOKEN) result.authorization = `Bearer ${TOKEN}`;
	return result;
}

async function request(method, path, { body, sandboxName } = {}) {
	if (!ENABLED) {
		throw new Error('Supervisor is disabled (PUNCH_SUPERVISOR_URL is empty or "0").');
	}
	const extra = {};
	if (sandboxName) extra["x-punch-sandbox"] = sandboxName;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`${BASE}${path}`, {
			method,
			headers: headers(extra),
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
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
	} catch (err) {
		if (err?.name === "AbortError") throw new Error(`Supervisor request timed out after ${TIMEOUT_MS}ms: ${method} ${path}`);
		throw err;
	} finally {
		clearTimeout(timer);
	}
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
	historyAll: (userId, limit = 20) =>
		request(
			"GET",
			`/routines/history?userId=${encodeURIComponent(userId)}&limit=${limit}`,
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


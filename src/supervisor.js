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
 * Git runner the supervisor uses for collab work. The supervisor owns the state
 * machine; the bot owns Docker, so each git call names the sandbox it must run in.
 * `git(args, sandboxName)` executes inside that participant's container.
 */
export function collabGitRunner() {
	return async (args, sandboxName) => {
		if (!sandboxName) throw new Error("collab git call requires a sandbox name");
		const result = await sandbox.gitInSandbox(sandboxName, args);
		return result.stdout.trim();
	};
}

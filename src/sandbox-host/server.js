import { createServer } from "node:http";

import * as sandbox from "../sandbox-manager.js";

const PORT = Number(process.env.SANDBOX_HOST_PORT) || 4110;
const HOST = process.env.SANDBOX_HOST_HOST || "0.0.0.0";
const TOKEN = process.env.SANDBOX_HOST_TOKEN || "";
const NAME = process.env.SANDBOX_HOST_NAME || `${process.env.PUNCH_STACK_NAME || "punch"}-sandbox-host`;
const HOST_URL = (process.env.SANDBOX_HOST_URL || "").replace(/\/+$/, "");
const SUPERVISOR_URL = (process.env.SUPERVISOR_URL || "").replace(/\/+$/, "");
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || "";
const REFRESH_MS = Number(process.env.SANDBOX_HOST_REFRESH_MS) || 30_000;
const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	return parsed && typeof parsed === "object" ? parsed : {};
}

function sendJson(res, status, data) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(data));
}

function authorized(req) {
	if (!TOKEN) return true;
	return (req.headers.authorization ?? "") === `Bearer ${TOKEN}`;
}

function sandboxInfo(user) {
	return {
		name: user.name,
		userId: user.userId,
		running: sandbox.isContainerRunning(user.name),
		url: `http://sandbox-${user.name}:4096`,
		apiUrl: `http://sandbox-${user.name}:4097`,
	};
}

async function createSandbox(body) {
	const name = String(body.name ?? "").toLowerCase();
	const userId = String(body.userId ?? "");
	if (!sandbox.isValidSandboxName(name)) throw new Error("Invalid sandbox name.");
	if (!userId) throw new Error("userId is required.");

	const existing = sandbox.loadUsers().find((u) => u.name === name);
	let added = false;
	if (!existing) {
		const add = sandbox.addUser(name, userId);
		if (!add.ok) throw new Error(add.error);
		added = true;
	}

	const up = await sandbox.composeUp(name);
	if (!up.ok) {
		if (added) sandbox.removeUser(name);
		throw new Error(up.error || "sandbox creation failed");
	}

	return { ok: true, name, userId, url: `http://sandbox-${name}:4096`, apiUrl: `http://sandbox-${name}:4097` };
}

async function removeSandbox(name) {
	const down = await sandbox.composeDown(name);
	const del = sandbox.removeUser(name);
	if (!down.ok) throw new Error(down.error || "sandbox removal failed");
	return { ok: true, removed: del.removed ?? null, output: down.output ?? "" };
}

async function handle(req, res) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname;
	const method = req.method ?? "GET";

	try {
		if (method === "GET" && path === "/health") {
			return sendJson(res, 200, { ok: true, host: NAME, sandboxes: sandbox.loadUsers().length });
		}
		if (!authorized(req)) {
			return sendJson(res, 401, { error: "Unauthorized" });
		}

		if (method === "GET" && path === "/sandboxes") {
			return sendJson(res, 200, { host: NAME, sandboxes: sandbox.loadUsers().map(sandboxInfo) });
		}

		if (method === "POST" && path === "/sandboxes") {
			const body = await readJson(req);
			return sendJson(res, 200, await createSandbox(body));
		}

		const match = /^\/sandboxes\/([^/]+)(?:\/(restart|logs))?$/.exec(path);
		if (match) {
			const name = decodeURIComponent(match[1]);
			const action = match[2];

			if (method === "DELETE" && !action) {
				return sendJson(res, 200, await removeSandbox(name));
			}
			if (method === "GET" && !action) {
				const user = sandbox.loadUsers().find((u) => u.name === name);
				if (!user) return sendJson(res, 404, { error: `Sandbox "${name}" not found.` });
				return sendJson(res, 200, { sandbox: sandboxInfo(user) });
			}
			if (method === "POST" && action === "restart") {
				const body = await readJson(req).catch(() => ({}));
				const result = body.recreate ? await sandbox.composeUp(name) : await sandbox.restartContainer(name);
				return sendJson(res, result.ok ? 200 : 400, result);
			}
			if (method === "GET" && action === "logs") {
				const tail = Math.max(1, Math.min(Number(url.searchParams.get("tail")) || 100, 500));
				try {
					return sendJson(res, 200, { name, logs: sandbox.getContainerLogs(name, tail) });
				} catch (err) {
					return sendJson(res, 404, { error: err.message });
				}
			}
		}

		if (method === "POST" && path === "/internal/exec") {
			const body = await readJson(req);
			const participant = String(body.participant ?? "");
			const argv = body.argv;
			if (!participant) throw new Error("participant is required");
			if (!Array.isArray(argv) || argv[0] !== "git" || argv.some((arg) => typeof arg !== "string")) {
				throw new Error("Only git commands are supported.");
			}
			try {
				const out = await sandbox.gitInSandbox(participant, argv.slice(1), {
					cwd: body.cwd ? String(body.cwd) : undefined,
				});
				return sendJson(res, 200, { code: 0, stdout: out.stdout, stderr: out.stderr });
			} catch (err) {
				return sendJson(res, 400, { error: err.message });
			}
		}

		return sendJson(res, 404, { error: "Not found" });
	} catch (error) {
		return sendJson(res, 400, { error: error.message });
	}
}

async function register() {
	if (!SUPERVISOR_URL || !HOST_URL) return;
	try {
		const participants = sandbox.loadUsers().map((u) => u.name);
		const response = await fetch(`${SUPERVISOR_URL}/hosts/register`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(SUPERVISOR_TOKEN ? { authorization: `Bearer ${SUPERVISOR_TOKEN}` } : {}),
			},
			body: JSON.stringify({ name: NAME, url: HOST_URL, participants, token: TOKEN, kind: "sandbox" }),
		});
		if (!response.ok) {
			console.warn(`[sandbox-host] host registration failed: ${response.status} ${await response.text()}`);
		}
	} catch (err) {
		console.warn(`[sandbox-host] host registration error: ${err.message}`);
	}
}

const server = createServer((req, res) => {
	void handle(req, res);
});
server.listen(PORT, HOST, () => {
	console.log(`[sandbox-host] ${NAME} listening on http://${HOST}:${PORT}`);
	void register();
});

const timer = setInterval(() => void register(), REFRESH_MS);

function shutdown(signal) {
	console.log(`[sandbox-host] ${signal} received, shutting down`);
	clearInterval(timer);
	server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

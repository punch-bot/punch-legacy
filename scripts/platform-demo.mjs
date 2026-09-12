const SUPERVISOR_URL = (process.env.SUPERVISOR_URL || "http://supervisor:4100").replace(/\/+$/, "");
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || "";
const SANDBOX_NAME = (process.env.SANDBOX_NAME || "demo1").toLowerCase();
const OWNER_USER_ID = process.env.OWNER_USER_ID || "cli-user";
const PROMPT = process.env.PROMPT || "Reply with exactly: cross-platform-ok";
const PROVIDER = process.env.SANDBOX_PROVIDER || "opencode";
const API_KEY = process.env.SANDBOX_API_KEY || "";
const USER = process.env.PI_SERVER_USERNAME || "opencode";
const PASS = process.env.PI_SERVER_PASSWORD || "";

function supHeaders() {
	const headers = { "content-type": "application/json" };
	if (SUPERVISOR_TOKEN) headers.authorization = `Bearer ${SUPERVISOR_TOKEN}`;
	return headers;
}

function basic() {
	return "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
}

async function sup(method, path, body) {
	const res = await fetch(`${SUPERVISOR_URL}${path}`, {
		method,
		headers: supHeaders(),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { raw: text };
	}
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
	return data;
}

async function gateway(base, method, path, body) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { "content-type": "application/json", authorization: basic() },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { raw: text };
	}
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
	return data;
}

function assistantText(message) {
	const parts = Array.isArray(message?.parts) ? message.parts : [];
	return parts
		.filter((p) => p?.type === "text")
		.map((p) => p.text)
		.join("")
		.trim();
}

async function main() {
	console.log(`[demo] supervisor: ${SUPERVISOR_URL}`);

	const initial = await sup("GET", "/sandboxes");
	const existing = (initial.sandboxes || []).find((s) => s.name === SANDBOX_NAME);
	if (existing?.running) {
		console.log(`[demo] sandbox "${SANDBOX_NAME}" already running; reusing`);
	} else {
		console.log(`[demo] creating sandbox "${SANDBOX_NAME}" for owner "${OWNER_USER_ID}" ...`);
		const created = await sup("POST", "/sandboxes", { name: SANDBOX_NAME, userId: OWNER_USER_ID });
		console.log(`[demo] sandbox host said: ${JSON.stringify(created)}`);
	}

	let running = existing?.running === true;
	for (let attempt = 0; attempt < 60 && !running; attempt += 1) {
		const { sandboxes = [] } = await sup("GET", "/sandboxes");
		const found = sandboxes.find((s) => s.name === SANDBOX_NAME);
		if (found?.running) {
			running = true;
			console.log(`[demo] sandbox running: ${JSON.stringify(found)}`);
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	if (!running) throw new Error("sandbox did not become running in time");

	if (API_KEY) {
		const api = `http://sandbox-${SANDBOX_NAME}:4097`;
		console.log(`[demo] setting ${PROVIDER} key on ${api} ...`);
		const res = await fetch(`${api}/apikey`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: basic() },
			body: JSON.stringify({ provider: PROVIDER, key: API_KEY }),
		});
		if (!res.ok) console.warn(`[demo] apikey set failed: ${res.status} ${await res.text()}`);
	}

	const gatewayBase = `http://sandbox-${SANDBOX_NAME}:4096`;
	console.log("[demo] opening a gateway session ...");
	const { id } = await gateway(gatewayBase, "POST", "/session", {});
	console.log(`[demo] session ${id}; prompting: ${PROMPT}`);
	const message = await gateway(gatewayBase, "POST", `/session/${id}/message`, {
		parts: [{ type: "text", text: PROMPT }],
	});
	console.log(`[demo] AGENT REPLY: ${assistantText(message) || JSON.stringify(message)}`);
}

main().catch((err) => {
	console.error(`[demo] FAILED: ${err.message}`);
	process.exit(1);
});

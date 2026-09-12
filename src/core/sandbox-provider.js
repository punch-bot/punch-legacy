const RAW_URL = process.env.PUNCH_SUPERVISOR_URL || "";
const BASE = (RAW_URL || "http://supervisor:4100").replace(/\/+$/, "");
const TOKEN = process.env.PUNCH_SUPERVISOR_TOKEN || "";
const ENABLED = RAW_URL !== "0" && RAW_URL !== "";
const RAW_TIMEOUT_MS = Number(process.env.PUNCH_SUPERVISOR_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(RAW_TIMEOUT_MS) && RAW_TIMEOUT_MS > 0 ? RAW_TIMEOUT_MS : 15000;

export const sandboxProviderEnabled = ENABLED;

async function request(method, path, body) {
	if (!ENABLED) throw new Error('Sandbox provider disabled (PUNCH_SUPERVISOR_URL is empty or "0").');
	const headers = {};
	if (body !== undefined) headers["content-type"] = "application/json";
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`${BASE}${path}`, {
			method,
			headers,
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
		if (err?.name === "AbortError") throw new Error(`Sandbox provider timed out after ${TIMEOUT_MS}ms: ${method} ${path}`);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

export async function listSandboxes() {
	const data = await request("GET", "/sandboxes");
	return Array.isArray(data.sandboxes) ? data.sandboxes : [];
}

export function createSandbox(name, userId) {
	return request("POST", "/sandboxes", { name, userId });
}

export function removeSandbox(name) {
	return request("DELETE", `/sandboxes/${encodeURIComponent(name)}`);
}

export function restartSandbox(name, { recreate = false } = {}) {
	return request("POST", `/sandboxes/${encodeURIComponent(name)}/restart`, { recreate });
}

export async function restartAllSandboxes({ recreate = false } = {}) {
	const list = await listSandboxes();
	const results = [];
	let failures = 0;
	for (const entry of list) {
		try {
			const result = await restartSandbox(entry.name, { recreate });
			results.push({ name: entry.name, ok: true, output: result.output || "" });
		} catch (err) {
			failures += 1;
			results.push({ name: entry.name, ok: false, error: err.message });
		}
	}
	return { ok: failures === 0, results };
}

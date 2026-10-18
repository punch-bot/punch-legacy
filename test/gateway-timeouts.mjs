import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

async function gateway(t, hardSeconds) {
  const dir = mkdtempSync(join(tmpdir(), "punch-gateway-timeouts-"));
  const lib = resolve("docker/sandbox/usr/local/lib");
  const source = readFileSync("docker/sandbox/usr/local/bin/pi-gateway.mjs", "utf8")
    .replaceAll('from "/usr/local/lib/', `from "${lib}/`)
    .replace('const PORT = Number(process.env.PI_GATEWAY_PORT || 4096);', 'const PORT = 0;')
    .replace('${PORT} (model', '${server.address().port} (model');
  writeFileSync(join(dir, "gateway.mjs"), source);
  mkdirSync(join(dir, "bin"));
  copyFileSync("test/helpers/fake-pi-timeouts.mjs", join(dir, "bin/pi"));
  chmodSync(join(dir, "bin/pi"), 0o755);
  const child = spawn(process.execPath, [join(dir, "gateway.mjs")], { env: {
    ...process.env, PATH: `${dir}/bin:${process.env.PATH}`,
    PI_REMOTE_DIR: dir, PI_SESSION_DIR: join(dir, "sessions"), PI_SESSION_MAP: join(dir, "map.json"),
    PI_CODING_AGENT_DIR: join(dir, "agent"), PI_EXTENSIONS_DIR: join(dir, "extensions"),
    PI_SERVER_USERNAME: "pi", PI_SERVER_PASSWORD: "fixture", PI_HARD_TIMEOUT: String(hardSeconds), PI_IDLE_TIMEOUT: "0.2",
    PI_GATEWAY_ABORT_GRACE_MS: "100", PI_GATEWAY_TURN_MAX_MS: "", PI_GATEWAY_TURN_IDLE_MS: "",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway did not start: ${logs}`)), 5000);
    child.stdout.on("data", (chunk) => {
      logs += chunk;
      const match = logs.match(/listening on [^:]+:(\d+)/);
      if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${logs}`)); });
  });
  t.after(async () => {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (path, body = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from("pi:fixture").toString("base64")}` }, body: JSON.stringify(body),
  });
  const session = await (await post("/session")).json();
  return {
    post, path: `/session/${session.id}`, logs: () => logs,
    events: () => fetch(`http://127.0.0.1:${port}/event`, {
      headers: { authorization: `Basic ${Buffer.from("pi:fixture").toString("base64")}` },
    }),
  };
}

test("gateway turn cap preserves Pi and allows the next turn", async (t) => {
  const g = await gateway(t, 0.08);
  const capped = await g.post(`${g.path}/message`, { parts: [{ type: "text", text: "forever" }] });
  assert.equal(capped.status, 504, await capped.text());
  const next = await g.post(`${g.path}/message`, { parts: [{ type: "text", text: "fast" }] });
  assert.equal(next.status, 200, await next.text());
  assert.doesNotMatch(g.logs(), /force-kill pi|pi exited/);
});

async function waitForTool(g, t) {
  const reader = (await g.events()).body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  return async () => {
    let frames = "";
    while (!frames.includes('"phase":"tool"')) {
      const { value, done } = await reader.read();
      assert.equal(done, false, "SSE closed before the tool started");
      frames += new TextDecoder().decode(value);
    }
    await reader.cancel();
  };
}

test("explicit abort cancels a live tool and preserves Pi for the next turn", { timeout: 5000 }, async (t) => {
  const g = await gateway(t, 30);
  const toolStarted = await waitForTool(g, t);
  let completed = false;
  const message = g.post(`${g.path}/message`, { parts: [{ type: "text", text: "forever" }] })
    .then((response) => { completed = true; return response; });
  await toolStarted();
  assert.equal(completed, false);
  assert.equal((await g.post(`${g.path}/abort`)).status, 200);
  const aborted = await message;
  assert.equal(aborted.status, 200, await aborted.text());
  const next = await g.post(`${g.path}/message`, { parts: [{ type: "text", text: "fast" }] });
  assert.equal(next.status, 200, await next.text());
  assert.doesNotMatch(g.logs(), /force-kill pi|pi exited/);
});

test("Pi exit during abort uses only the exit handler's scheduled replacement", { timeout: 5000 }, async (t) => {
  const g = await gateway(t, 30);
  const toolStarted = await waitForTool(g, t);
  const message = g.post(`${g.path}/message`, { parts: [{ type: "text", text: "forever exit-on-abort" }] });
  await toolStarted();
  assert.equal((await g.post(`${g.path}/abort`)).status, 200);
  const aborted = await message;
  assert.equal(aborted.status, 500, await aborted.text());
  // ensureSession waits for the scheduled respawn; a duplicate replacement
  // gets killed while this next turn is running and cannot pass these checks.
  const next = await g.post(`${g.path}/message`, { parts: [{ type: "text", text: "fast" }] });
  assert.equal(next.status, 200, await next.text());
  assert.doesNotMatch(g.logs(), /force-kill pi/);
  assert.equal((g.logs().match(/starting: pi/g) || []).length, 2);
  assert.equal((g.logs().match(/pi exited code=/g) || []).length, 1);
});

test("a quiet running tool survives idle probing and emits a verified heartbeat", async (t) => {
  const g = await gateway(t, 10);
  const reader = (await g.events()).body.getReader();
  const events = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      events.push(decoder.decode(value));
    }
  })();
  const result = await g.post(`${g.path}/message`, { parts: [{ type: "text", text: "quiet" }] });
  assert.equal(result.status, 200, await result.text());
  await reader.cancel();
  await reading;
  assert.match(events.join(""), /"heartbeat":true/);
  assert.ok(events.join("").includes(g.path.slice("/session/".length)));
  assert.doesNotMatch(g.logs(), /force-kill pi|pi exited/);
});

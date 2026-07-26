import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("runAgent opens SSE before POST, forwards progress, returns activity, and logs metadata only", async () => {
  let eventResponse;
  let eventReady = false;
  let postSawReady = false;
  const sid = "session-progress-test";
  const activity = {
    status: "completed",
    durationMs: 8_000,
    thinkingMs: 2_000,
    toolCalls: 1,
    current: "Complete",
    actions: ["Reading a file src/a\\.js"],
    milestones: [{ goal: "Verify safe progress", next: "Return answer" }],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      eventResponse = res;
      eventReady = true;
      return;
    }

    if (req.method === "POST" && url.pathname === `/session/${sid}/message`) {
      postSawReady = eventReady;
      for (const event of [
        {
          type: "session.progress",
          properties: {
            sessionID: sid,
            phase: "tool",
            status: "running",
            current: "Reading a file src/a\\.js",
            elapsedMs: 1_000,
            thinkingMs: 500,
            toolCalls: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: { sessionID: sid, delta: { text: "private model delta" } },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: sid,
            part: {
              type: "tool",
              tool: "read",
              state: {
                status: "done",
                title: "Reading a file src/a\\.js",
                input: { token: "private tool input" },
                output: "private tool output",
              },
            },
          },
        },
      ]) {
        eventResponse.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        info: {
          role: "assistant",
          cost: 0.01,
          tokens: { input: 10, output: 5, reasoning: 2 },
          activity,
        },
        parts: [{ type: "text", text: "Safe answer" }],
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === `/session/${sid}/message`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        { info: { role: "user" }, parts: [{ type: "text", text: "request" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Safe answer" }] },
      ]));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const userId = "progress-test-user";
  process.env.SANDBOX_MAP = JSON.stringify({ [userId]: `http://127.0.0.1:${port}` });
  process.env.OPENCODE_SERVER_URL = "";
  process.env.OPENCODE_SERVER_PASSWORD = "";

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));

  try {
    const agent = await import(`../src/agent.js?agent-progress=${Date.now()}`);
    const events = [];
    const result = await agent.runAgent(
      "test prompt",
      sid,
      (event) => events.push(event),
      null,
      userId,
    );

    assert.equal(postSawReady, true);
    assert.equal(result.text, "Safe answer");
    assert.deepEqual(result.activity, activity);
    assert.deepEqual(result.attachments, []);
    assert.ok(events.some((event) => event.type === "session.progress"));

    const allLogs = [...logs, ...agent.getActivityLogs(userId)].join("\n");
    assert.match(allLogs, /tool read is done: Reading a file/);
    for (const hidden of ["private model delta", "private tool input", "private tool output"]) {
      assert.equal(allLogs.includes(hidden), false, hidden);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    eventResponse?.end();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("progress fingerprints ignore unchanged snapshots but accept explicit heartbeats", async () => {
  const agent = await import(`../src/agent.js?fingerprint=${Date.now()}`);
  const base = {
    type: "session.progress",
    properties: {
      sessionID: "s1",
      phase: "thinking",
      status: "running",
      current: "Thinking",
      toolCalls: 0,
      elapsedMs: 1_000,
      thinkingMs: 1_000,
    },
  };
  const later = {
    ...base,
    properties: { ...base.properties, elapsedMs: 20_000, thinkingMs: 20_000 },
  };
  assert.equal(agent.progressEventFingerprint(base), agent.progressEventFingerprint(later));
  assert.equal(
    agent.progressEventFingerprint({
      ...later,
      properties: { ...later.properties, heartbeat: true },
    }),
    null,
  );
});

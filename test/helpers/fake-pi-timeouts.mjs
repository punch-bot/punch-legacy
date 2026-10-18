#!/usr/bin/env node
import { createInterface } from "node:readline";
let streaming = false;
let timer;
let exitOnAbort = false;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
send({ type: "ready" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  let data = {};
  if (request.type === "get_state") data = { isStreaming: streaming };
  if (request.type === "get_messages") data = { messages: [{ role: "assistant", content: [{ type: "text", text: "Complete" }] }] };
  if (request.type === "prompt") {
    exitOnAbort = request.message.includes("exit-on-abort");
    streaming = true;
    send({ type: "tool_execution_start", toolCallId: "quiet-tool", toolName: "bash", args: {} });
    const delay = request.message.includes("quiet") ? 6000 : request.message.includes("forever") ? 60000 : 10;
    timer = setTimeout(() => {
      streaming = false;
      send({ type: "agent_settled" });
    }, delay);
  }
  if (request.type === "abort") {
    if (exitOnAbort) process.exit(0);
    clearTimeout(timer);
    streaming = false;
    send({ type: "agent_settled" });
  }
  send({ type: "response", command: request.type, id: request.id, success: true, data });
});

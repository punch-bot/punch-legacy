import { isTurnSettledEvent } from "../docker/pi-turn-completion.mjs";

if (!isTurnSettledEvent({ type: "agent_settled" })) {
  throw new Error("agent_settled must complete turn");
}

for (const type of ["agent_end", "turn_end", "agent_start", "message_update", "tool_execution_end"]) {
  if (isTurnSettledEvent({ type })) {
    throw new Error(`${type} must not complete turn`);
  }
}

if (isTurnSettledEvent(null) || isTurnSettledEvent({})) {
  throw new Error("invalid events must not complete turn");
}

console.log("ok: gateway completion requires agent_settled");

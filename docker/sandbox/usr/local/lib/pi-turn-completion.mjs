export function isTurnSettledEvent(message) {
  return message?.type === "agent_settled";
}

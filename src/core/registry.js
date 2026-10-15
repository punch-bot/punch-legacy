// Shared mutable state + client reference for the bot process. Indexed
// modules import this instead of re-creating their own Maps or a client.

export const registry = {
  client: null,
  doctorRepairTokens: new Map(),
  workerProgressSent: new Map(),
  activeTurns: new Map(),
  recentReactionKeys: new Map(),
  userQueues: new Map(),
  userRunChains: new Map(),
  userQueueDraining: new Set(),
  questionState: new Map(),
  spectrumHandle: null,
  spectrumShuttingDown: false,
  spectrumSignalsBound: false,
};

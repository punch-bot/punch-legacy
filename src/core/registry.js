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
  // channelId:userId -> { messageId, answeredAt }: the newest cv2 card, so the
  // next spec can edit it in place even if the click state was lost
  recentV2Cards: new Map(),
  spectrumHandle: null,
  spectrumShuttingDown: false,
  spectrumSignalsBound: false,
};

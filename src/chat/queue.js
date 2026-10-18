// Per-user FIFO chat queue. All runAgent calls for a user are serialized so the
// shared Pi gateway (chat + routines/heartbeat) never sees concurrent turns.

import { writeFileSync } from "node:fs";
import { sandboxNameForUser } from "../agent.js";
import { registry } from "../core/registry.js";
import { shouldSteerTurn, trySteerTurn } from "./steer.js";
import { handleChat } from "./chat.js";

async function withUserRunLock(uid, fn) {
  const prev = registry.userRunChains.get(uid) || Promise.resolve();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  registry.userRunChains.set(
    uid,
    prev.catch(() => {}).then(() => gate),
  );
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function enqueueChat(message, text, contextMessages = [], opts = {}) {
  const uid = opts.userId ?? message.author.id;

  // A message sent while a turn is running in this channel steers that turn
  // instead of queueing behind it.
  if (shouldSteerTurn(uid, message, opts)) {
    const steered = await trySteerTurn(message, text, opts);
    if (steered) return;
  }

  if (!registry.userQueues.has(uid)) {
    registry.userQueues.set(uid, []);
  }
  const queue = registry.userQueues.get(uid);

  let resolveQueue;
  const queuedPromise = new Promise((resolve) => {
    resolveQueue = resolve;
  });

  const abortController = new AbortController();

  const task = {
    message,
    text,
    contextMessages,
    opts,
    resolve: resolveQueue,
    thinking: null,
    abortController,
  };

  queue.push(task);
  const depth = queue.length;
  console.log(`[queue] uid=${uid} enqueue depth=${depth}`);

  if (depth > 1) {
    // N = how many requests are ahead (in-flight + earlier queued).
    const ahead = depth - 1;
    task.thinking = await message
      .reply({
        content: `⏳ queued (${ahead})`,
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(() => null);
  }

  // Ensure a single FIFO drain is running (or will re-check after the current one).
  void processQueue(uid);

  await queuedPromise;
}

async function processQueue(uid) {
  if (registry.userQueueDraining.has(uid)) return;
  registry.userQueueDraining.add(uid);

  try {
    // Drain FIFO one turn at a time. Chat holds the queue slot for the full
    // handleChat; withUserRunLock inside still serializes with routines/heartbeat.
    for (;;) {
      const queue = registry.userQueues.get(uid);
      if (!queue || queue.length === 0) break;

      const task = queue[0];
      console.log(`[queue] uid=${uid} run depth=${queue.length}`);
      try {
        await handleChat(
          task.message,
          task.text,
          task.contextMessages || [],
          task.thinking,
          task.abortController.signal,
          task.opts || {},
        );
      } catch (err) {
        console.error(`[queue] Error running task for user ${uid}:`, err);
      } finally {
        queue.shift();
        task.resolve();
      }
    }
  } finally {
    registry.userQueueDraining.delete(uid);
    // Sync section: if something enqueued after the loop emptied, restart drain.
    const queue = registry.userQueues.get(uid);
    if (queue && queue.length > 0) {
      void processQueue(uid);
    } else if (queue) {
      registry.userQueues.delete(uid);
    }
  }
}

function setCurrentUserId(uid) {
  try {
    writeFileSync("/state/current_user", String(uid));
  } catch (err) {
    console.error(`Failed to set current user: ${err.message}`);
  }
}

// Returns the attribution subtext for a punch reply, e.g. "\n\n-# from sandbox:ember".
// Applied at the OUTPUT layer so it survives message chunking and pigeon routing.
function labelLineFor(userId) {
  const name = sandboxNameForUser(userId);
  return name ? `\n\n-# from sandbox:${name}` : "";
}

export {
  withUserRunLock,
  enqueueChat,
  processQueue,
  setCurrentUserId,
  labelLineFor,
};

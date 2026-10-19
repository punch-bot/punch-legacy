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
    const ahead = depth - 1;
    task.thinking = await message
      .reply({
        content: `⏳ queued (${ahead})`,
        allowedMentions: { parse: [], repliedUser: false },
      })
      .catch(() => null);
  }

  void processQueue(uid);

  await queuedPromise;
}

async function processQueue(uid) {
  if (registry.userQueueDraining.has(uid)) return;
  registry.userQueueDraining.add(uid);

  try {
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

# Parallel tool batches (PNCH-39)

Punch's deployment prompt directs the agent to issue independent tools in one
assistant message: unrelated file reads, independent searches, and memory recall
can share a batch. Search tool guidance makes this explicit. Calls that need
earlier results, edits/tests, and operations on shared state stay ordered.
Context compression runs separately because its tools require sequential execution.

The shipped `@punch-bot/cli` 1.3.0 runtime already defaults to parallel execution.
`packages/agent/src/agent.ts` sets `toolExecution` to `parallel`, and
`agent-loop.ts` executes an assistant message's calls with `Promise.all` unless
the caller or a tool explicitly requires sequential execution. Neither the bot
nor its HTTP adapter splits an assistant tool batch into separate turns. The
deployment tools do not force sequential execution. The runtime's compression
tools intentionally do; removing that guard would risk changing context while
another tool is using it.

Verification in the core checkout:

```sh
cd packages/agent
node ../../node_modules/vitest/dist/cli.js --run test/agent-loop.test.ts
```

The suite verifies overlapping tool execution, completion-order events with
source-order results, queued messages after the whole batch, and sequential
overrides. These tests use mock model responses. They prove concurrency of
emitted batches; actual model batching frequency and Discord latency still need
deployment measurements. A batch pays one model round trip before its tools,
so independent calls avoid the per-call model round trips of a serial turn.

Rebuild the sandbox image and recreate existing sandboxes to distribute the
updated bundled prompt and search extension. Preserve any intentional user prompt
customizations when updating their workspace `.pi/SYSTEM.md`.

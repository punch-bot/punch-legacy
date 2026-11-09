# Prompt retry deduplication

A network failure does not prove that Pi rejected a prompt. Previously the bot could resend the same POST up to eight times, and each copy could enqueue another turn.

The bot now serializes one request body, including a generated request ID, before entering its retry loop. Each transport retry reuses those bytes.

The sandbox gateway keeps a SQLite request ledger next to its session map (`<session-map>.requests.sqlite`). The file is private (0600). The ledger records the session-scoped request ID and a SHA-256 fingerprint of the prompt inputs before work is queued.

- Concurrent copies share the original in-flight promise.
- Completed copies return the saved assistant response without calling Pi again, including after a gateway restart.
- Reusing an ID for different inputs returns HTTP 409.
- Failed requests return the recorded failure without replaying the prompt.
- A request recorded as running before a gateway crash fails closed with HTTP 409 after restart. Its execution cannot safely be inferred, so it is never automatically resubmitted. A genuinely new user turn gets a new ID.
- Completed and failed records are retained for seven days without a count-based eviction cap. Interrupted running records are kept to prevent unsafe replay.
- SQLite lock acquisition fails immediately (`busy_timeout=0`) rather than blocking the gateway event loop. Result updates are retried three times with asynchronous 50/100 ms backoffs on storage errors. If storage remains unavailable, completed results and failures stay replayable in memory and persistence is retried on the next lookup. After a process crash without a successful durable result update, the original running marker still fails closed; completion cannot be recovered from lost memory.
- Routine occurrences persist their request ID, session and original request body before submission. Scheduler retries reuse that snapshot. Successful completion, terminal failure, restart interruption, and explicit resume of a paused/failed routine clear it; explicit resume also resets the retry count. The next execution therefore gets a fresh request ID. Missing saved sessions are recovered using the effective session ID and the replacement session is saved before submission.
- Weekly audits retain their authorized context separately from the saved body for the whole logical occurrence, including automatic retries. Success, terminal failure, restart interruption and explicit resume revoke it. A lost or expired context is not silently recreated under the old ID; the routine must fail/stop and be explicitly resumed as a new audit. An unavailable memory store prevents audit submission.

An identified request is not cancelled merely because one HTTP response socket closes. The existing stop command owns explicit cancellation and calls the session abort endpoint once; the transport abort listener does not issue a second gateway abort. Older callers without request IDs retain disconnect cancellation; that listener is attached to the response socket rather than the already-read request stream.

## Deployment

Both sides must be deployed: the bot needs to send stable IDs and the sandbox image needs to include the ledger module and updated gateway. Rebuild the sandbox image and recreate sandboxes; a bot-only deploy or a plain sandbox restart is insufficient. This patch does not deploy itself.

## Verification

Temporary fault-injection checks exercised concurrent duplicates, changed payloads, cached failures, interrupted requests, and completed-response replay after reopening the database. A real local HTTP server executing the patched gateway route was disconnected after accepting a prompt; its retry and a retry after reopening the ledger both returned the original result, with exactly one prompt invocation. Syntax checks and `git diff --check` passed.

After installing the locked dependencies, all 72 existing tests passed. `npm run typecheck`, `npm run lint`, syntax checks for the gateway and ledger, and `git diff --check` also passed. No existing tests or checker configuration were changed.

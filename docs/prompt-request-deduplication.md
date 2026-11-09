# Prompt retry deduplication

A network failure does not prove that Pi rejected a prompt. Previously the bot could resend the same POST up to eight times, and each copy could enqueue another turn.

The bot now serializes one request body, including a generated request ID, before entering its retry loop. Each transport retry reuses those bytes.

The sandbox gateway keeps a SQLite request ledger next to its session map (`<session-map>.requests.sqlite`). The file is private (0600). The ledger records the session-scoped request ID and a SHA-256 fingerprint of the prompt inputs before work is queued.

- Concurrent copies share the original in-flight promise.
- Completed copies return the saved assistant response without calling Pi again, including after a gateway restart.
- Reusing an ID for different inputs returns HTTP 409.
- Failed requests return the recorded failure without replaying the prompt.
- A request recorded as running before a gateway crash fails closed with HTTP 409 after restart. Its execution cannot safely be inferred, so it is never automatically resubmitted. A genuinely new user turn gets a new ID.
- Completed records are retained for seven days, capped at approximately 512 recent results. Interrupted running records are kept to prevent unsafe replay.

An identified request is not cancelled merely because one HTTP response socket closes. Explicit cancellation still aborts the client request and calls the session abort endpoint. Older callers without request IDs retain disconnect cancellation; that listener is attached to the response socket rather than the already-read request stream.

## Deployment

Both sides must be deployed: the bot needs to send stable IDs and the sandbox image needs to include the ledger module and updated gateway. Rebuild the sandbox image and recreate sandboxes; a bot-only deploy or a plain sandbox restart is insufficient. This patch does not deploy itself.

## Verification

Temporary fault-injection checks exercised concurrent duplicates, changed payloads, cached failures, interrupted requests, and completed-response replay after reopening the database. A real local HTTP server executing the patched gateway route was disconnected after accepting a prompt; its retry and a retry after reopening the ledger both returned the original result, with exactly one prompt invocation. Syntax checks and `git diff --check` passed.

After installing the locked dependencies, all 72 existing tests passed. `npm run typecheck`, `npm run lint`, syntax checks for the gateway and ledger, and `git diff --check` also passed. No existing tests or checker configuration were changed.

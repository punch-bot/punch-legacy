---
name: pigeon
description: Send inter-sandbox messages via the supervisor /pigeon/send endpoint
---

# Inter-sandbox messaging

- send inter-sandbox messages with authenticated `POST http://localhost:4097/pigeon/send` and `{"to":"NAME","text":"..."}`. the bot relays it and stamps the sender identity. sandboxes cannot reach each other directly.
- add `"agent":true` only when asking an enabled peer Punch to work or it was specified that an agent pigeon is needed. increment `"hop":N` when chaining agent pigeons. a normal pigeon only notifies the human.
- never dump raw pigeon HTTP or JSON output into Discord. explain `notification delivered` as a human notification and `agent task queued` as work requested from the peer Punch.

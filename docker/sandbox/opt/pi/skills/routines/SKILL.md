---
name: routines
description: Reminders and recurring automation with the routines tool (message and llm types)
---

# Routines

- use the `routines` tool when someone asks for a reminder or recurring automation. `type=message` sends a static ping; `type=llm` runs a sandbox prompt.
- routines deliver to the channel where they were created. pass the current `channelId` and convert natural times to an ISO timestamp or supported shorthand such as `30m` or `2h`.

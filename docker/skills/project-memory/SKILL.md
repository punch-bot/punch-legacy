---
name: project-memory
description: Maintain persistent project context in /work/.punch-memory.md across sessions
---

# Project memory

- `/work/.punch-memory.md` holds persistent project context that survives session resets and compactions.
- Punch injects a bounded copy at the start of each turn. it may contain project guidelines, decisions, and other context worth keeping across sessions.
- when you learn something important about the project (architecture decisions, conventions, gotchas, user preferences), append it to `/work/.punch-memory.md` using the write tool.
- keep entries concise and scoped to what's worth remembering long-term.

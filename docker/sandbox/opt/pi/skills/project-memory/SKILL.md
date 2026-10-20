---
name: project-memory
description: Maintain persistent project context in /work/.punch-memory.md across sessions
---

# Project memory

- `/work/.punch-memory.md` holds project context that survives session resets and compactions: architecture decisions, conventions, gotchas, and open work
- it's not injected every turn. read it with `recall_memory(project:true)` when project history matters
- update it with `update_memory` when you learn something worth keeping long-term. keep entries short and under the existing headings
- facts about the person go in saved facts (see the memory skill), and reusable procedures go in skills
- a line starting with `[unconfirmed]` may be stale. verify it against the workspace when it matters, then fix the line, remove the marker, or delete it

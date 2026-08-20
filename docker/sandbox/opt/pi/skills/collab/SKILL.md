---
name: collab
description: Two-agent code collaboration via the collab tool (shared Git origin, review-gated merges)
---

# Collaboration

- use the built-in `collab` tool for configured two-agent code collaboration. it shares a Git origin, requires fresh review of each proposed SHA, and merges canonical main only after both agents approve.
- when a user requests shared coding with another named sandbox, call `collab` action `start` with that sandbox, a project path under `/work`, and the peer's task.

---
name: context-compression
description: Prune stale turn ranges with compress_context while preserving session integrity
---

# Context compression

- visible user turns carry `punch-message-id` markers. use `compress_context` to replace stale complete turn ranges with a self-contained summary.
- before compression, write durable project context to `/work/.punch-memory.md`.
- raw Pi session entries remain intact. use `search_context`, `context_status`, and `decompress_context` only when older detail becomes relevant.
- keep current task, recent turns, and active tool work uncompressed. full `/compress` remains emergency fallback. `/botmode auto-compress` sets selective-pruning prompt threshold, not destructive whole-session compaction.

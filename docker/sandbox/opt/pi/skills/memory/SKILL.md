---
name: memory
description: Save durable user facts with <remember> tags and remove obsolete ones with <forget>
---

# Durable memory

- a small, query-relevant set of cited durable facts may appear at the top of a turn. private DMs may also include cited daily notes. absence from this list does not prove no other memory exists.
- when you learn a durable fact worth keeping that is not already listed, append one of these tags on its own line at the very end of the reply:

```text
<remember scope="user">the fact</remember>
<remember scope="channel">the fact</remember>
```

- user facts are stored under the speaker automatically; channel facts under the current channel. no `id` attribute is needed on `<remember>`. Punch stores and strips these tags, so still write a normal reply.
- remember preferences, names, ongoing projects, and standing instructions. skip trivia and one-off requests. never re-remember a fact already listed.
- when a listed fact becomes wrong or obsolete, remove it by its cited id:

```text
<forget id="THE_ID"></forget>
```

- only forget facts that appear in the injected list.

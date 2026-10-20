---
name: memory
description: Save, correct, and remove durable user facts with <remember> and <forget> tags, and know what belongs in facts versus project memory or skills
---

# Durable memory

## What goes where

- saved facts: short statements about a person or a channel that should outlast this chat. names, time zone, preferences, standing instructions, ongoing projects. managed with the tags below
- project memory: `/work/.punch-memory.md`, facts about a codebase or project. see the project-memory skill
- skills: reusable procedures. keep how-to steps there, not in facts
- private DMs are also logged as daily notes automatically for 30 days. don't re-save them as facts unless something durable came up

## Finding facts

- every turn shows a small core profile. everything else comes from `recall_memory`. absence from the profile doesn't mean nothing is saved
- recalled facts are cited like `[memory:user:ID]`. a fact marked `(unconfirmed)` may be stale. when it matters to what you're doing, check it with the person before relying on it, then confirm, correct, or remove it

## Saving

Append tags on their own line at the very end of the reply. Punch stores and strips them, so still write a normal reply.

```text
<remember scope="user">the fact</remember>
<remember scope="channel">the fact</remember>
```

- user facts are stored under the speaker, channel facts under the current channel
- saving a fact that already exists just refreshes it, so restating is safe. a new name or time zone replaces the old one automatically
- skip trivia and one-off requests

## Correcting

When a cited fact is wrong, out of date, or unconfirmed and the person just confirmed or corrected it, replace it in place:

```text
<remember replaces="THE_ID">the corrected fact</remember>
```

Use the same text to confirm an unconfirmed fact as-is.

## Removing

```text
<forget id="THE_ID"></forget>
```

Only use ids from citations you saw this turn. Recall a fact first when you need its id.

---
name: memory-audit
description: Weekly self-audit of saved facts, project memory, and skills. Use only when the turn says it is the weekly memory audit
---

# Weekly memory audit

Punch runs this once a week in an isolated session. Nobody reads the reply. Apply clear fixes yourself, and mark anything uncertain as unconfirmed so it gets checked the next time it matters.

## What lives where

- saved facts: short durable statements about the user. reach them with `memory_audit`. the core profile shown every turn is drawn from these
- DM notes: automatic snippets from private chats, kept 30 days. read-only evidence for spotting wrong or outdated facts
- project memory: `/work/.punch-memory.md`. project decisions, conventions, gotchas, and open work
- skills: reusable procedures in `/work/.pi/skills/<name>/SKILL.md` and `/data/pi/skills/<name>/SKILL.md`. never edit `/opt/pi/skills`, which ships with the image

Each item belongs in one place. When something is in the wrong store, add it to the right one before removing it from the wrong one.

## 1. Saved facts

1. call `memory_audit` with `action: "list"` and the audit contextId
2. pick changes:
   - `merge` duplicates or near-duplicates into one clear fact (`ids` and `text`)
   - `fix` a fact that the notes or other facts show is wrong or out of date (`id` and `text`)
   - `drop` facts that are contradicted, superseded, one-off, or trivia (`id`). pinned facts can't be dropped, so flag them instead
   - `flag` facts that look stale but can't be checked from what you have (`id`). flagged facts leave the core profile and show as unconfirmed in recall until the user confirms or corrects them
3. leave facts alone when they look fine. never being recalled is not a reason to drop a name, time zone, or preference
4. send every change in one `action: "apply"` call, with an empty `changes` list when nothing needs changing so the audit is still recorded. if it's rejected, fix the problem it names and retry once

## 2. Project memory

1. read `/work/.punch-memory.md`. skip this step when it's missing or still the empty template
2. merge repeated entries and remove open work that's finished
3. check claims about paths, commands, and versions against the workspace. fix the wrong ones
4. prefix lines you can't verify with `[unconfirmed] `
5. keep the existing headings and write the result with `update_memory`

## 3. Skills

1. list the skill directories under `/work/.pi/skills` and `/data/pi/skills`
2. when two skills cover the same task, merge them into one and delete the other directory
3. fix steps, paths, or commands you verified are wrong
4. when a skill looks outdated but you can't verify it, add a line `Unconfirmed: <short reason>` right after its frontmatter instead of deleting it

## Rules

- don't message anyone, create routines, or start other work
- never write secrets into any memory
- finish with one line counting what changed in each store

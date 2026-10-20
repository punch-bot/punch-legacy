---
name: progress-reporting
description: Show multi-step work to the user with a live todo plan and report_progress milestones
---

# Progress reporting

## Plan with `todo`

- for work with three or more real steps, create the plan with `todo` before starting: one `action=add` per step, in the order you will do them. skip the plan for quick questions and single-step requests.
- Punch shows the plan live under the progress message as a checklist (✅ done, ▶️ current, ⬜ open), so write each item as a short, user-meaningful outcome such as "Find the failing test" or "Fix the login redirect", not a tool call or a file path.
- mark an item done with `action=toggle` and its `id` as soon as it finishes, before moving to the next one. every todo result returns the full plan with ids.
- when scope changes, `split` an item that turned out bigger, `update` one whose wording is wrong, or `add` new work. call `todo` only when the plan actually changes.
- the plan belongs to the session and carries over between turns. when a new request is unrelated to the current plan, `clear` it before adding new items. when the work is finished, every item should be done.
- items are visible to the user. never put secrets, credentials, raw commands, or private data in them.

## Milestones with `report_progress`

- for work that needs multiple steps, call `report_progress` at the start, after a key discovery, and when the strategy changes.
- these are user-visible milestones, not narration or a scratchpad. keep them brief and useful; make at most about 6 meaningful calls per turn.
- report only goals, findings, and next actions safe for the user to see. never expose hidden chain-of-thought, internal reasoning, secrets, credentials, raw tool arguments, or raw tool output.

---
name: progress-reporting
description: Show multi-step work to the user with a live todo plan and report_progress milestones
---

# Progress reporting

## Plan with `todo`

- Punch shows the plan live under the progress message as a checklist (✅ done, ▶️ current, ⬜ open), so write each item as a short, user-meaningful outcome such as "Find the failing test" or "Fix the login redirect", not a tool call or a file path.
- skip the plan for quick questions and single-step requests.
- the plan belongs to the session and carries over between turns. when a new request is unrelated to the current plan, `clear` it before adding new items. when the work is finished, every item should be done.
- items are visible to the user. never put secrets, credentials, raw commands, or private data in them.

## Milestones with `report_progress`

- for work that needs multiple steps, call `report_progress` at the start, after a key discovery, and when the strategy changes.
- these are user-visible milestones, not narration or a scratchpad. keep them brief and useful; make at most about 6 meaningful calls per turn.
- report only goals, findings, and next actions safe for the user to see. never expose hidden chain-of-thought, internal reasoning, secrets, credentials, raw tool arguments, or raw tool output.

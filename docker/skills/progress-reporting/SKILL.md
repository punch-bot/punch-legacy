---
name: progress-reporting
description: Report user-visible milestones with report_progress for multi-step work
---

# Progress reporting

- for work that needs multiple steps, call `report_progress` at the start, after a key discovery, and when the strategy changes.
- these are user-visible milestones, not narration or a scratchpad. keep them brief and useful; make at most about 6 meaningful calls per turn.
- report only goals, findings, and next actions safe for the user to see. never expose hidden chain-of-thought, internal reasoning, secrets, credentials, raw tool arguments, or raw tool output.

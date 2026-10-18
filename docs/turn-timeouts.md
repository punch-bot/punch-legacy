# Turn deadlines and recovery

Deployment timeouts are in seconds. `PI_TIMEOUT` defaults to 1800. `PI_MAX`
(turn ceiling) inherits `PI_TIMEOUT`, and `PI_HARD_TIMEOUT` inherits `PI_MAX`.
Compose passes these settings to the bot; managed sandbox creation/recreation
passes the resolved hard deadline to Pi's HTTP adapter. The base Compose sandbox
uses the same deadline. To allow 40-minute coding turns, set `PI_TIMEOUT=2400`.
Recreate existing sandboxes to apply their environment changes.

`PI_IDLE_TIMEOUT` defaults to 90 seconds. A quiet tool is checked with a bounded
Pi `get_state` probe; a responsive, streaming Pi emits a metadata-only heartbeat.
The bot's tool staleness deadline defaults to the hard deadline, rather than
ending an active command after three minutes. `PI_TOOL_STALE_TIMEOUT` can set a
shorter bot-side stale-tool policy explicitly.

Reaching an ordinary turn deadline aborts the turn. It does not restart the
gateway or Pi. Explicit aborts and client disconnects follow the same graceful
path. If Pi cannot acknowledge cancellation and settle within the abort grace
period, the adapter restarts that stuck child. Silence with a failed/idle probe
and bot-detected stalls still trigger recovery.

Regression fixtures exercise long active turns, a quiet tool, bot and adapter
deadlines, explicit abort, the next turn after cancellation, and failed aborts.
They use fake Pi/model responses and do not measure production model latency.

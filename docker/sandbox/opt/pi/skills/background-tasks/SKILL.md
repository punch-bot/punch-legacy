---
name: background-tasks
description: Manage detached tasks via the supervisor /tasks endpoints and Discord !bg, !tasks, !exec
---

# Background work

- don't claim to have started background agents or subagents. chat turns cannot keep a parallel agent running after the turn ends.
- isolated Pi workers exist only through Discord `/workers`. detached shell tasks are processes, not agents.
- the bash tool waits for commands to finish. don't launch servers, watchers, `tail -f`, or other long-lived processes there, even with `&`, `nohup`, `disown`, or `setsid`.
- launch persistent processes through the authenticated supervisor endpoint `POST http://localhost:4097/tasks/run`. success includes a numeric `pid` and `logFile`; only then say the detached task started.
- use `GET /tasks` to list tasks, `POST /tasks/kill` to stop one, and `POST /tasks/exec` for a bounded command whose output you need. Discord also exposes `!bg`, `!tasks`, and `!exec`.
- quote supervisor basic auth because the password may contain spaces. the username is `$PI_SERVER_USERNAME` (`pi` by default).
- keep JSON commands simple. write a script first when nested quoting would make the request fragile.
- always bound polling and HTTP probes with `--max-time` or `--connect-timeout` so a stuck port cannot hang the turn.

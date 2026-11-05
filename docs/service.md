# The service

Skill Academy runs as one process on one port: the API and the built interface from
`http://127.0.0.1:10008`.

## Start and stop

```
npm run service     # start it hidden, no console, no focus steal
npm run stop        # stop it (pid file first, then whatever owns the port)
```

`npm run service` runs `scripts/service.mjs`, which writes `~/.skill-academy/start-app.vbs` and launches
`scripts/app.mjs` windowless. `app.mjs` builds the interface only when `web/dist/index.html` is missing
(or `SKILL_ACADEMY_BUILD=1`), then hands the server to `scripts/serve.mjs`, which spawns
`node node_modules/tsx/dist/cli.mjs server/src/index.ts` with its output appended to the log.

| What | Where |
| --- | --- |
| log | `~/.skill-academy/logs/app.log` |
| pid of the listener | `~/.skill-academy/app.pid` |
| generated launcher | `~/.skill-academy/start-app.vbs` |
| index and library | `~/.skill-academy/index.db` |

## At boot

`scripts/skill-academy-service.vbs` is the autostart, copied into

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\skill-academy-service.vbs
```

It runs `scripts/service.mjs` with window style 0, so a reboot brings the same service back with no
window and nothing to click. Delete that file to stop it starting at boot; `npm run stop` still stops a
running instance either way.

## Three ways the old wiring failed, and what replaced it

The service had no persistent launcher at all: it was started from a VBS in the Hermes scratch cache,
which is pruned, so the file disappeared and nothing brought the app back. Fixing that exposed the
reasons a start would have failed anyway.

**The build assumed npm was a project dependency.** `app.mjs` ran
`node node_modules/npm/bin/npm-cli.js run build`, and that path does not exist, so every start died with
`MODULE_NOT_FOUND` before it could serve anything. It now uses `npm_execpath` when present, the npm
beside the running node otherwise, and the shell as a last resort, and it only builds when there is no
bundle.

**Node was handed a `.cmd`.** The launcher ran `node .../tsx.cmd`, which is a batch file, not a
program: the process died silently. It now runs `node_modules/tsx/dist/cli.mjs`, which is JavaScript.

**A windowless launch discarded the reason it failed.** `WScript.Shell.Run(command, 0)` has no stdout,
so a crash left an empty log beside a dead service. `scripts/serve.mjs` owns the child and appends its
output to `app.log`, and `app.mjs` prints the log tail when the port never opens.

**And `npm run stop` could not stop it.** It killed `dev.pid`, which only the dev loop writes, so a
service started through `service.mjs` looked unstoppable. `scripts/stop.mjs` kills `app.pid` and falls
back to whatever is listening on the port; `serve.mjs` records that pid because the detached launcher
cannot hand one back.

## A listener netstat would not show

Confirming a start by parsing `netstat -ano` for `LISTENING :10008` reported nothing while `curl` talked
to the port happily, so the launcher declared failure against a service that was up. `app.mjs` now
probes the port with a TCP connect, which is the question being asked.

## Limits

- No supervisor: if the process dies, nothing restarts it until the next boot or `npm run service`.
  `serve.mjs` writes the exit code to the log, which is where to look.
- One port, one instance. A second start refuses when `app.pid` names a live process.
- The watcher stays off in service mode (`SKILL_ACADEMY_WATCH=1` to enable), so a skill written by
  hand appears at the next scan rather than instantly.

# Working together

The loop is: I edit files, the running app updates, you watch. No build step, no restart ritual, no pasting errors into chat.

## What you run once

```bash
npm install
npm run dev
```

That starts one supervisor (`scripts/dev.mjs`) with two children:

| Process | Port | Behaviour |
|---|---|---|
| API service (`tsx watch`) | 4320 | Restarts in under a second when a server file changes |
| Web client (Vite) | 4319 | Hot module replacement; the page updates without a reload |

Open <http://127.0.0.1:4319>. It proxies `/api` to the service, so there is one URL.

The service is persistent: it stays up while you work, and a file save restarts only the server process. State lives in SQLite and on disk, so a restart is a re-read, not a rebuild. The browser reconnects over SSE and keeps its scroll position and selection.

## Persistent mode

`npm run dev` dies with its terminal. When you want the app to stay up while you close that window, start it detached instead:

| Command | Effect |
|---|---|
| `npm run service` | Starts the loop hidden, no console window, survives the terminal that launched it |
| `npm run stop` | Stops the loop and its children by pid file |

Both modes write the same log, `~/.skill-academy/logs/dev.log`, and keep the same pid file. A second start refuses while one is running rather than fighting for the ports. You can watch the same session from the app once it is up; the terminal is optional.

## What you can watch

The app carries its own development surface at `/dev`:

- Service uptime, last restart, and the file that triggered it.
- Every request with method, path, status and duration, newest first.
- Scan progress: root, packages found so far, elapsed time.
- SSE events as they fire.
- The data directory, the database path, and the log file path.
- Buttons for `Rescan`, `Reset database`, and `Open log`.

Logs also go to `~/.skill-academy/logs/dev.log`, so a crash that kills the page is still readable.

## What I do

- I edit files in this repository and let the watcher pick them up. I do not restart your service, kill your processes, or open new consoles. If a change needs a restart, the supervisor does it.
- I verify against the live app at `127.0.0.1:4319` with a browser and against the API with `curl`, then read the log file if something failed. You should not have to tell me what the error was.
- When I need a clean database I use `npm run seed`, which writes a synthetic library under `~/.skill-academy/fixtures/` and points the service at it. Your real agent folders are never the test fixture.
- A change is done when the running app shows it. Not when the file is saved, not when it typechecks.

## Rules that keep this honest

- **One command, one URL.** If the loop needs a second terminal or a manual step, it is broken.
- **The watcher owns restarts.** A server edit restarts; a client edit hot-swaps. Nothing else.
- **State survives.** SQLite and files are the state; a restart must never lose a scan or a toggle.
- **Errors are visible.** A crash shows a banner with the last error and the dev panel keeps the trace. No silent dead page.
- **No hidden consoles.** Background jobs run without a visible window; the only terminal is the one you started `npm run dev` in.
- **Ports are fixed.** 4319 for the app, 4320 for the API, checked at startup with a clear message if taken.

## When the app is not running

If `127.0.0.1:4319` does not answer, I start it myself with `npm run dev` in the background, read the log, and tell you it is up. I still do not restart a process you already have running.

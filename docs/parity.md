# Parity: MCP, then CLI

Two front ends for people who are not in the browser. Both are thin clients over the local service,
which stays the source of truth, so neither can drift from the rules the UI follows.

## The MCP server

`mcp/server.ts` speaks MCP over stdio (newline-delimited JSON-RPC 2.0, protocol `2024-11-05`) and
exposes six tools:

| Tool | Arguments | Does |
| --- | --- | --- |
| `list` | `query?`, `limit?` | skills in the library with path, tokens, hash, risk |
| `search` | `query`, `limit?` | the same full-text search the app runs |
| `enable` | `name`, `agent?` | switch a skill on, moving it out of the agent's `.archive` |
| `disable` | `name`, `agent?` | switch it off into `.archive`, deleting nothing |
| `scan` | `force?` | rescan the roots |
| `lock` | `check?` | write the lock, or compare it with the library |

Register it with any MCP client, pointing at the running service:

```json
{
  "mcpServers": {
    "skill-academy": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts", "--base", "http://127.0.0.1:10008"],
      "cwd": "C:/git-public/skill-academy"
    }
  }
}
```

A tool failure comes back as `isError: true` with the reason in the text (an ambiguous name, a
service that is down), never as a dropped session: a client should be able to read the error and try
again.

## The CLI

`cli/ska.ts`, installed as `ska` (run it as `npx tsx cli/ska.ts` from a checkout).

```
ska list [query] [--limit n] [--json]
ska search <query>
ska show <name>
ska enable <name> [--agent a]
ska disable <name> [--agent a]
ska scan [--force]
ska lock [--check] [--file <lock>]
ska status
```

Exit codes are the contract, so CI does not have to parse prose: **0** success, **1** a negative
answer (`lock --check` found drift, or there is no lock at all), **2** a usage or connection problem.

Enabling and disabling call `/api/skills/:id/switch` — the route the UI's switch calls — so the
journal entry is identical whichever way it was done. A name resolves to exactly one skill or the
command fails and lists the candidates; guessing which `pdf` a script meant is how the wrong package
gets archived.

## Two things this work found

**A switch left its own row stale.** `POST /api/skills/:id/switch` moved the folder and journalled,
but never re-indexed, so enabling and then disabling the same skill in quick succession acted on a
path the package had already left. The route now calls `rescanRoot()` after both moves. The browser
hid this because the watcher and the next poll covered for it; a script does not wait.

**`lock --check` cannot compare the live lock.** The service keeps its own lock current after every
scan, so checking that file can only ever agree. CI needs a baseline published with the library,
which is what `--file` is for:

```
ska lock --file skill-academy.lock.json     # write it beside what you are about to commit
ska lock --check --file skill-academy.lock.json   # exit 1 the moment the library drifts
```

## Checks

`bash scripts/parity-check.sh` — **26 checks** against a throwaway service with a fixture root:

- a real MCP client handshake, then `tools/list` showing exactly the six tools, each with a schema;
- `list` and `search` answering without a browser;
- `enable` moving a parked package out of `.archive` and `disable` putting it back;
- a bad name returning a tool error while the session stays alive;
- the CLI listing, enabling, and writing the **same journal action and payload shape** the UI route
  writes;
- `lock --check` exiting 0 on a matching baseline, **1** on drift and naming what drifted, and 1 when
  the baseline does not exist.

## Limits

- The MCP server has no authentication: it talks to `127.0.0.1` and assumes the machine is yours. Do
  not expose it on a network interface.
- It is a client of the service, not a standalone index: nothing works if the service is not running,
  and that failure is reported plainly rather than by pretending.
- Tools cover the six P9 named. Curation, sources and sync are not exposed to agents yet, and an agent
  that could spend tokens on a merge is a decision, not an oversight.

# Architecture

## Runtime

| Layer | Choice | Why |
|---|---|---|
| Service | Node 22+, TypeScript, Fastify | One language with the ported provider layer; small dependency surface |
| Transport | HTTP + SSE | One-way events are enough; no socket lifecycle to manage |
| Storage | SQLite via `better-sqlite3`, WAL | Synchronous reads keep the scanner simple; a single file to back up |
| Watchers | `chokidar` with depth limits | Cross-platform recursive watch, and it survives editors that swap files |
| Git | `isomorphic-git` for local repos, GitHub REST for remotes | No `git` binary requirement; API gives commits, releases and trees in one place |
| Frontend | React 19, Vite, Tailwind v4, Radix primitives, TanStack Query | Same stack as the other local apps on this machine; accessible primitives |
| Filter | In-memory index over a snapshot, `Intl.Collator` plus a small fuzzy scorer | Typing must not touch the network |

Process: one foreground service, `node dist/server.js`, bound to `127.0.0.1:4319`. The browser opens automatically on first start. A single-instance lock file under the data directory refuses a second copy with a clear message rather than corrupting the database.

Data directory: `~/.skill-academy/`

```
~/.skill-academy/
├── index.db            # SQLite index + journal
├── library/            # canonical packages for linked placements
├── archive/            # archived packages, <date>-<name>/
├── snapshots/          # pre-update and pre-merge copies
├── reports/            # curation run reports
├── logs/               # rotating service log
└── config.json         # user settings that must survive a DB rebuild
```

## Data model

The database is an index plus a journal. `DELETE` on `index.db` and a rescan reproduces every skill and placement. Journal and settings live in `config.json` and `snapshots/`, so a rebuild keeps history.

```sql
-- Physical roots discovered on disk
CREATE TABLE roots (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,     -- absolute, realpath
  scope         TEXT NOT NULL,            -- 'global' | 'project'
  owner_codes   TEXT NOT NULL,            -- JSON array of agent codes sharing this root
  state         TEXT NOT NULL,            -- 'ok' | 'missing' | 'unreadable'
  last_scan_at  TEXT,
  error         TEXT
);

-- One row per logical skill (frontmatter name + package hash)
CREATE TABLE skills (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  package_hash   TEXT NOT NULL,           -- sha256 over sorted path:hash lines
  frontmatter    TEXT NOT NULL,           -- JSON, unknown keys preserved
  primary_source TEXT,                    -- 'mattpocock/skills', 'local', NULL
  state          TEXT NOT NULL DEFAULT 'active',  -- active|stale|archived
  pinned         INTEGER NOT NULL DEFAULT 0,
  internal       INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  UNIQUE(name, package_hash)
);

-- One row per physical copy of a skill
CREATE TABLE placements (
  id           INTEGER PRIMARY KEY,
  skill_id     INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  root_id      INTEGER NOT NULL REFERENCES roots(id),
  path         TEXT NOT NULL UNIQUE,      -- the skill package directory
  mode         TEXT NOT NULL,             -- 'linked' | 'native' | 'shadow'
  enabled      INTEGER NOT NULL,
  link_target  TEXT,                      -- library path for linked mode
  installed_hash TEXT,                    -- hash recorded when we wrote it
  drift        TEXT,                      -- NULL | 'missing' | 'modified' | 'replaced'
  scanned_at   TEXT NOT NULL
);

CREATE TABLE files (
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  sha256   TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  PRIMARY KEY (skill_id, rel_path)
);

CREATE TABLE sources (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,            -- 'github' | 'git' | 'folder'
  locator       TEXT NOT NULL UNIQUE,     -- owner/repo, absolute path
  ref           TEXT,                     -- branch or tag
  policy        TEXT NOT NULL DEFAULT 'notify',  -- off|notify|auto
  interval_hours INTEGER NOT NULL DEFAULT 6,
  quiet_hours   TEXT,                     -- JSON [start,end]
  last_checked_at TEXT,
  last_head_sha TEXT,
  last_release  TEXT,
  etag          TEXT,
  state         TEXT NOT NULL DEFAULT 'idle',  -- idle|checking|error|ratelimited
  error         TEXT
);

CREATE TABLE source_skills (
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,               -- path inside the repo
  version    TEXT,
  package_hash TEXT,
  PRIMARY KEY (source_id, path)
);

CREATE TABLE events (            -- journal and activity timeline
  id        INTEGER PRIMARY KEY,
  ts        TEXT NOT NULL,
  kind      TEXT NOT NULL,               -- toggle|archive|restore|update|merge|repair|scan
  skill_id  INTEGER,
  actor     TEXT NOT NULL,               -- 'you' | 'scan' | 'auto-update' | 'curation'
  summary   TEXT NOT NULL,
  before    TEXT,                        -- JSON filesystem state
  after     TEXT,                        -- JSON filesystem state
  undo_of   INTEGER,                     -- event id this reverses
  undone    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE llm_runs (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,              -- 'curation' | 'provider-test' | 'translate'
  provider   TEXT, model TEXT,
  status     TEXT NOT NULL,              -- queued|running|done|failed|cancelled
  tokens_in  INTEGER, tokens_out INTEGER, cost_usd REAL,
  started_at TEXT, finished_at TEXT,
  report_path TEXT, error TEXT
);
```

Notes:

- `placements.path` is the package directory, not `SKILL.md`. Two placements of the same skill under different agents are two rows and one `skills` row.
- `installed_hash` is what lets an update refuse to overwrite local edits. It is written on every install, update and repair.
- `skills.package_hash` folds duplicates. A skill whose name matches but whose hash differs is a separate row, shown as a variant conflict on the detail pane rather than merged silently.
- Deleting `index.db` loses nothing except scan history, which is rebuilt. The journal survives in `events` only as long as the DB does, so every event also appends a line to `journal.ndjson` in the data directory.

## Scan pipeline

```
roots ──► walker ──► parser ──► hasher ──► differ ──► DB ──► SSE
```

1. **Roots.** Loaded from `registry/agents.json`, filtered to detected paths for the current OS. Project roots come from the projects list plus the launch directory.
2. **Walk.** Breadth-first, depth-capped at 3 under each root, honouring the container list in `docs/creating-skills.md`. A directory containing `SKILL.md` is a package; the walker does not descend into it further.
3. **Parse.** Frontmatter via a tolerant YAML parser. A file that fails to parse is recorded as `unparsed` with the parser error and still listed, because a broken skill is exactly what the user needs to see.
4. **Hash.** SHA-256 per file, package hash over sorted `rel_path:sha256`. Files over 256 KB are hashed in streams; binary files are hashed but never read into the UI.
5. **Differ.** Compare against `placements` by path: new, changed (hash differs), unchanged, missing. Unchanged rows are not rewritten, which is what makes a second scan a no-op.
6. **Fold.** Group by `(name, package_hash)`. Placements attach to the group. A `name` with more than one hash adds a `variants` counter.
7. **Publish.** One SSE `scan.completed` event with counts, then incremental `skills.upsert` events only for changed rows.

Watchers: one chokidar instance per root, `depth: 4`, `ignoreInitial: true`, `awaitWriteFinish: { stabilityThreshold: 250 }`. Events are coalesced for 300ms per root before a subtree rescan. A full rescan runs every 6 hours and on demand.

Cost guard: 66 roots with deep project trees is the failure mode. Each root has a per-root cap (default 2,000 packages) and the walker reports when it hits it instead of silently truncating.

## Placement state machine

Modes are decided by what is on disk, then recorded.

```
discovered ──► native      (real directory inside an agent root)
          └─► linked       (symlink/junction into library)
          └─► shadow       (bundled or external, not writable)

native:  enabled  ──rename SKILL.md──►  disabled
         disabled ──rename back──────►  enabled
linked:  enabled  ──remove link──────►  disabled (package kept)
         disabled ──create link──────►  enabled
any:     enabled/disabled ──move to archive──► archived
         archived ──restore──► previous state
```

Every transition:

1. Stat the target and refuse if it changed since the row was read (compare mtime and hash).
2. Write the `events` row with `before` and `after` describing the exact operations.
3. Perform the filesystem operation with a two-phase pattern for anything multi-step: rename to a temp sibling first, then move into place, so a crash leaves a recoverable orphan that the next start sweeps.
4. Emit `placement.changed`.
5. On failure, restore from `before` and report the OS error verbatim.

Undo is the inverse operation from the journal, not a re-computation. `⌘Z` pops the newest undoable event, applies its inverse, writes an `undo_of` event, and marks the original undone.

Drift detection runs on every scan and before every mutation: a linked placement whose link vanished, a native placement whose `SKILL.md` reappeared after being disabled, a package edited outside the app. Drift never self-heals. It shows on the row and offers Repair.

### Archive layout

`~/.skill-academy/archive/<YYYY-MM-DD>-<name>/` contains the package plus `metadata.json`: original placements, mode, source, hash, reason, and the event id. Restore recreates placements using the same modes. A name collision appends `-2`.

## Sources and updates

Check cycle per source:

1. Resolve head: GitHub `GET /repos/{o}/{r}/commits?per_page=1` (ETag honoured), or `git ls-remote` for local remotes, or a directory mtime for folders.
2. Resolve release: `GET /repos/{o}/{r}/releases/latest`, tag names compared.
3. If head unchanged and release unchanged, write `last_checked_at` and stop.
4. Fetch the tree at the new head (GitHub `git/trees/{sha}?recursive=1`, or a local walk), run the same skill discovery rules, compute a package hash per discovered skill.
5. Diff against `source_skills`: added, removed, changed.
6. Write events per changed skill. One `release` event if the tag moved.
7. If policy is `auto` and the skill is unpinned, enqueue an update job.

Apply an update:

```
snapshot current package → download new tree (tarball at sha)
  → verify frontmatter name matches (else hold: rename)
  → verify installed_hash equals current hash (else hold: local changes)
  → write temp dir, hash, swap, re-link placements
  → journal event with both hashes
```

Download limits borrowed from the skills CLI: 10 MiB per file response, 25 MiB extracted, 1,000 files, overridable in Settings › Advanced. Archives are extracted with a path-traversal guard (`..`, absolute paths, symlinks rejected).

Rate limits: unauthenticated GitHub allows 60 requests per hour. The service tracks `X-RateLimit-Remaining` and pauses with `ratelimited` state and a resume time rather than retrying into a wall. A token raises it to 5,000.

Scheduler: a single timer with a 15-minute tick, reading due sources from the DB. Catch-up on start: any source whose `last_checked_at + interval` has passed runs once, with jitter. Nothing runs while the OS reports the machine asleep; the service re-checks on resume.

## Curation runtime

Described in [curation.md](curation.md). The runtime contract:

- Deterministic pass: pure functions over the DB, no model, always safe.
- LLM pass: a job with a token budget, a provider binding, a tool loop, and a report. Applying is a separate job with the same snapshot guarantees as an update.

## LLM layer

Described in [providers.md](providers.md). Two invariants:

- The renderer never receives a key. Keys live in the OS keychain, are read inside the service, and are redacted from every log line.
- Every model call goes through one function with a provider binding, a budget, and a usage record, so cost is always attributable.

## API

```
GET    /api/state                    machine summary, detection, counts
POST   /api/scan                     {roots?:[]} trigger, returns job id
GET    /api/roots
POST   /api/roots/custom

GET    /api/skills/snapshot          full index for the client filter
GET    /api/skills/:id
GET    /api/skills/:id/files/:path    raw file, confined to the package
POST   /api/skills/:id/state         {action:'on'|'off'|'archive'|'restore', targets:['claude-code',…]}
POST   /api/skills/:id/pin           {pinned:boolean}
POST   /api/skills/:id/repair

GET    /api/sources
POST   /api/sources                  {kind, locator, ref}
POST   /api/sources/:id/check
PATCH  /api/sources/:id              {policy, interval_hours, quiet_hours}
DELETE /api/sources/:id

GET    /api/updates
POST   /api/updates/:id/apply
POST   /api/updates/:id/skip

GET    /api/events?cursor=            journal and activity
POST   /api/events/:id/undo

GET    /api/curation/runs
POST   /api/curation/runs            {mode:'dry'|'apply', budget_usd}
GET    /api/curation/runs/:id
POST   /api/curation/runs/:id/apply

GET    /api/providers
POST   /api/providers/:id/test
POST   /api/providers/:id/key
POST   /api/providers/:id/oauth/start
GET    /api/providers/:id/models

GET    /api/events/stream             SSE
```

Conventions: JSON in, JSON out; errors are `{error:{message, code, detail}}` with the OS or upstream message preserved; mutations return the new state plus the event id so the client can offer an immediate undo.

## Security

- **Bind.** `127.0.0.1` only. A `--lan` flag requires a token generated on first use, sent as `Authorization: Bearer`, and rejects non-private source addresses.
- **Path confinement.** Every path from the client is resolved with `realpath` and must sit under a registered root or under the data directory. Symlinks are resolved and re-checked; loops are rejected.
- **Untrusted content.** Markdown is rendered with a sanitizer that allows no scripts, no iframes, no event handlers, and no `javascript:` URLs. Remote images are blocked by default and load only after an explicit per-source opt-in.
- **Prompt injection.** Skill text entering a model prompt is fenced as data, the system prompt says so, and the tool surface is an allowlist that cannot run shell commands or open network connections. Curation is dry-run by default.
- **Secrets.** OS keychain (`@napi-rs/keyring`) with a DPAPI-encrypted fallback file; never in SQLite, never in `config.json`, never in a log, never in an SSE payload.
- **Write safety.** Atomic renames, `fsync` on the journal, and a startup sweep for temp siblings.
- **No telemetry.** The app makes no outbound call except the ones the user configures: source checks and model providers.

## Performance budgets

| Operation | Budget |
|---|---|
| Cold scan, 2,000 packages, 20 roots | < 1.5s |
| Warm scan, unchanged | < 250ms |
| Filter keystroke → paint, 3,000 skills | < 16ms |
| Snapshot payload, 3,000 skills | < 4 MB gzipped |
| Toggle one placement | < 40ms server, optimistic UI |
| Memory, idle service | < 180 MB |

## Testing

- Unit: walker rules, frontmatter parsing, hashing, folding, state machine transitions, diffing.
- Property tests: any sequence of toggle/archive/restore on a temp tree returns the tree to its original hash; the journal inverse always restores.
- Fixture trees: a synthetic multi-agent layout with linked, native, shadow, drifted and broken packages.
- Integration: a real local git repo and a recorded GitHub API fixture; no live network in CI.
- UI: Playwright for the five main flows, axe for accessibility, a contrast check over the token table.
- Manual gate: run against this workstation's 66 roots before P2 ships.

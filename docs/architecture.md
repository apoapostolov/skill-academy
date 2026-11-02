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
├── archive/            # default archive location; any drive path can be configured instead
├── snapshots/          # pre-update and pre-merge copies
├── drafts/             # authoring drafts, outside every agent root
├── sync/               # per-profile git worktree used by the sync engine
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

CREATE TABLE archives (          -- named archive destinations, not subfolders
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,      -- absolute or UNC
  mode        TEXT NOT NULL DEFAULT 'move',  -- move | copy
  is_default  INTEGER NOT NULL DEFAULT 0,
  agent_code  TEXT,                      -- optional per-agent default
  available   INTEGER NOT NULL DEFAULT 1,
  last_check_at TEXT, error TEXT
);

CREATE TABLE archived_skills (
  id          INTEGER PRIMARY KEY,
  skill_name  TEXT NOT NULL,
  archive_id  INTEGER NOT NULL REFERENCES archives(id),
  dir_path    TEXT NOT NULL,             -- <archive>/<date>-<name>
  package_hash TEXT NOT NULL,
  placements  TEXT NOT NULL,             -- JSON, original placements
  reason      TEXT,
  event_id    INTEGER,
  archived_at TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'archived'  -- archived | restored | missing
);

CREATE TABLE skill_links (       -- a composite target absorbing a remote skill
  id            INTEGER PRIMARY KEY,
  skill_id      INTEGER REFERENCES skills(id) ON DELETE CASCADE,
  draft_id      INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  source_path   TEXT NOT NULL,
  source_name   TEXT NOT NULL,
  track         TEXT NOT NULL DEFAULT 'commit',  -- release | commit
  ref           TEXT,                    -- branch or tag when track=release
  mode          TEXT NOT NULL DEFAULT 'distill', -- distill | attach | summarize
  last_ingest_sha TEXT,
  last_ingest_ref TEXT,                  -- tag name for release tracking
  last_ingest_hash TEXT,                 -- hash of the target after ingest
  state         TEXT NOT NULL DEFAULT 'ok',      -- ok | behind | error | paused
  last_checked_at TEXT,
  CHECK ((skill_id IS NOT NULL) + (draft_id IS NOT NULL) = 1),
  UNIQUE(skill_id, draft_id, source_id, source_path)
);

CREATE TABLE ingest_runs (
  id           INTEGER PRIMARY KEY,
  skill_id     INTEGER REFERENCES skills(id),
  draft_id     INTEGER REFERENCES drafts(id),
  link_id      INTEGER REFERENCES skill_links(id),
  kind         TEXT NOT NULL DEFAULT 'delta',  -- bootstrap | delta
  from_sha     TEXT, to_sha TEXT,
  provider     TEXT, model TEXT,
  tokens_in    INTEGER, tokens_out INTEGER, cost_usd REAL,
  status       TEXT NOT NULL,            -- queued|running|dry|applied|failed|partial
  added        INTEGER, changed INTEGER, conflicts INTEGER, dropped INTEGER,
  snapshot_path TEXT, report_path TEXT, error TEXT,
  started_at   TEXT, finished_at TEXT,
  CHECK ((skill_id IS NOT NULL) + (draft_id IS NOT NULL) = 1)
);

CREATE TABLE drafts (
  id          INTEGER PRIMARY KEY,
  skill_id    INTEGER REFERENCES skills(id),   -- NULL for a new skill
  name        TEXT,
  path        TEXT NOT NULL,                   -- ~/.skill-academy/drafts/<id>/
  status      TEXT NOT NULL DEFAULT 'draft',   -- draft | validating | ready | discarded
  origin      TEXT NOT NULL,                   -- 'user' | 'llm'
  base_hash   TEXT,                            -- package hash when opened, for diffing
  llm_run_id  INTEGER REFERENCES llm_runs(id),
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE sync_profiles (
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL,
  remote      TEXT NOT NULL,
  branch      TEXT NOT NULL DEFAULT 'main',
  path_prefix TEXT,
  direction   TEXT NOT NULL DEFAULT 'backup',  -- backup | two_way
  include     TEXT,                            -- JSON: {sources:[], agents:[]} or null for all
  schedule    TEXT NOT NULL DEFAULT 'manual',  -- manual | on_change | hourly | daily
  last_commit TEXT,
  last_push_at TEXT, last_pull_at TEXT,
  state       TEXT NOT NULL DEFAULT 'idle',    -- idle|syncing|conflict|error|diverged
  error       TEXT,
  secrets_scan INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sync_runs (
  id           INTEGER PRIMARY KEY,
  profile_id   INTEGER NOT NULL REFERENCES sync_profiles(id),
  direction    TEXT NOT NULL,                  -- push | pull
  status       TEXT NOT NULL,                  -- queued|running|ok|conflict|failed
  from_commit  TEXT, to_commit TEXT,
  files_changed INTEGER, conflicts INTEGER,
  snapshot_path TEXT, report_path TEXT, error TEXT,
  started_at   TEXT, finished_at TEXT
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

Notes: tables are grouped by domain, not dependency order. SQLite accepts a forward reference in a `CREATE TABLE`, and every table exists before the first write, which is when these constraints are actually checked.

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

## Archive service

Archive is a location, not a convention. The service owns three rules.

1. **Resolve, don't assume.** A location is resolved with `realpath` at use time. A missing drive, an unmounted network path, or a permission change marks it `available = 0` and refuses the operation with the path and the OS error. There is no silent fallback to a local folder.
2. **Write the index before the move.** The `archived_skills` row and the location's `skill-academy-index.ndjson` line are written and flushed before the package moves, so a crash between the two leaves a recoverable record rather than an orphan.
3. **Cross-volume is copy-then-verify-then-remove.** A move inside one volume is a rename. Across volumes it is: copy to a temp directory inside the destination, hash every file, rename into place, then remove the source. A hash mismatch aborts and keeps both copies.

Restore reads `metadata.json` in the package directory, verifies the package hash, refuses on mismatch unless the user picks `restore as variant`, then recreates placements in their recorded modes. A location that moved on disk is re-pointed through Settings, and the index is rebuilt from the directories present.

## Ingest engine

Linked sources are a second write path into a local skill, and the only one that writes prose the user did not type. It is designed like the curator: read, propose, apply, snapshot.

### Resolving the delta

```
last_ingest_sha ──► compare API ──► changed files ──► knowledge files ──► prompt
```

- GitHub: `GET /repos/{o}/{r}/compare/{base}...{head}` gives status, filenames and patches in one call. Release tracking resolves the tag to a commit first, then compares commits.
- Local git: `git diff --name-status base..head`, then read the changed files at `head`.
- A link with no `last_ingest_sha` ingests the whole skill at its current ref; that is the first run, and the report says so.

**Bootstrap and composition.** A link without `last_ingest_sha` runs as `kind: bootstrap`: the whole upstream skill is read, not a delta. Composing an empty skill is a sequence of bootstraps plus one merge pass — each link contributes rules, the merge deduplicates across links, and the target body is written once. The report records which link contributed which rule, so a composite is auditable back to two repos.

The target may be a skill or a draft. A draft target is written in place under `drafts/<id>/` and reaches an agent directory only when saved; the ingest does not care which it is writing to, because both go through the same snapshot and hash guard.

Knowledge files: `SKILL.md`, `references/**/*.md`, `templates/**/*.{md,txt}`, and any `.md` inside the package. Excluded by default: scripts, binaries, anything over 256 KB, and anything outside the linked skill's directory. A `include_code` toggle adds scripts as text, off by default because code is not knowledge a model should paraphrase.

### Prompt contract

The model receives the local skill (body and reference manifest), the delta with file paths, and the existing ingested sections. It must return JSON with four arrays: `added_rules`, `changed_rules`, `conflicts`, `dropped`. Rules are imperative plus one clause of why. The prompt carries the same prohibitions as curation: no incident narration, no dates, no issue numbers, no duplication of content already present.

Conflicts are first class. When the upstream rule contradicts a local rule, the local rule stays and the conflict is reported with both texts and the upstream commit. The model may not resolve a conflict by picking a side.

### Applying

1. Re-read the local skill; refuse if its hash differs from the hash captured when the run started.
2. Snapshot to `~/.skill-academy/snapshots/ingest/<run-id>/`.
3. Write the distilled sections into the body, and `references/ingested/<source-slug>.md` with the upstream commit and the list of rules taken from it. If the body would pass 24,000 characters, the new material goes to the reference file and the body gets one pointer line instead; the report states that it did.
4. Record `last_ingest_sha`, `last_ingest_ref`, and the resulting `last_ingest_hash`.
5. Journal one event with both hashes so undo is a restore, not a re-run.

`attach` mode skips the model: it copies selected files into `references/ingested/<slug>/` and adds a manifest line. `summarize` writes one `references/ingested/<slug>-digest.md` from the delta and adds a one-line pointer in the body.

### Loop protection

- A run for a given skill takes a lock; a second run queues behind it.
- An ingest that would produce zero new rules marks the link `up to date` and writes no files.
- If the same delta fails twice, the link goes to `error` with the provider message and does not retry automatically.
- Budget: per-run token cap with a clean stop and a partial report, same as curation.



## Authoring

Drafts are files on disk plus a row, and they are outside every agent root by construction.

```
~/.skill-academy/drafts/<id>/
├── SKILL.md
├── references/…            # when the draft needs depth
└── draft.json              # frontmatter, origin, base hash
```

- **Editor state.** CodeMirror holds the buffer; the client PUTs the whole file on a 2-second debounce and on blur. The server writes atomically and never touches a skill directory.
- **Validation** is one function shared by the editor and the save path: required frontmatter, slug shape, description length, body size against 24,000 characters, dangling `references/` and `templates/` links, package hash collision against the library, and duplicate name with a different hash. The client renders the same result the server returns, so a green panel means the save will not be refused.
- **Generation** is an LLM job with a schema, not free text: `{name, description, body, references:[{path, content}], notes}`. The prompt carries the house rules — description that survives a 60-character retrieval window, imperative rules with one clause of why, no incident narration, depth in `references/`, no invented tool or command names. Output is validated before it becomes a draft; a failed schema is a failed run, never a half-draft.
- **Improve** runs the same job against an existing package and returns a diff, not a new file. The editor opens the diff; applying is explicit.
- **Save** goes through the placement engine, so it obeys the same modes, snapshots and journal as every other write. A native-mode skill saves in place; a linked-mode skill saves to the library and re-links. Saving without edits must produce an identical package hash, which is a test.

Source material for generation is explicit: a linked skill, a file path inside a registered root, or pasted text. The app never feeds the whole library into a prompt by default.

## Sync engine

Git is the transport. A profile maps the library onto a repository and the app does the three things a person would otherwise do by hand: commit, push, merge.

Prerequisite: `git` on `PATH` (2.40 or newer), checked at startup with a clear message. `isomorphic-git` is used for reading local sources, not for merging; a real merge with conflict markers is worth the dependency on the binary.

### Push

```
snapshot → secrets scan → stage selected paths → commit → push
```

- Paths: with no prefix, the repo root is `library/<source-slug>/<skill>/…` plus `manifest.json`. With a prefix, everything nests under it.
- The manifest records, per skill: package hash, source, placements as intent (`claude-code:user`, not `C:\Users\…`), and the archive location label if any.
- Commit message names the changes by skill and action (`update prose-review`, `archive 3 skills`, `add 2 skills`), so `git log` is readable without the app.
- Secrets scan runs on the staged content: key shapes, PEM blocks, `.env` files, and a high-entropy check on long strings. A hit blocks the commit, names file and line, and offers `Review` and `Exclude file`. It is not a linter the user can wave through.

### Pull and merge

```
fetch → compute base = last_commit → three-way merge → conflicts → resolve → apply
```

- No local changes: fast-forward.
- Local changes only: replay the remote commits, then re-apply local packages by hash; a package that changed on both sides is a conflict.
- Both sides changed the same file: `git merge` leaves markers; the app lists each path with `local`, `remote`, `both` and a diff, and refuses to finish until every path is resolved.
- Apply is transactional from the user's point of view: snapshot first, write through the placement engine, journal one event per changed skill. A failure rolls back to the snapshot.
- Deleting `index.db` and pulling is a supported flow: the manifest reconstructs skills and placements, and a placement whose root does not exist on this machine is recorded as `unplaced` instead of being invented.

### What never enters the repository

Keys, tokens, session state, archive contents, snapshots, logs, reports. The profile's include list can narrow what is pushed but cannot widen it past this rule.



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

GET    /api/archives                 named destinations + availability
POST   /api/archives                 {label, path, mode, is_default, agent_code}
PATCH  /api/archives/:id
POST   /api/archives/:id/check       realpath probe, free space
GET    /api/archives/:id/items
POST   /api/skills/:id/archive       {archive_id}
POST   /api/archived/:id/restore     {on_mismatch:'variant'|'refuse'}

GET    /api/skills/:id/links
POST   /api/skills/:id/links         {source_id, source_path, track, ref, mode}
PATCH  /api/links/:id                {mode, track, ref}
DELETE /api/links/:id
POST   /api/links/:id/check          resolve head, report delta size
POST   /api/links/:id/ingest         {dry:true, budget_usd}
GET    /api/ingest/runs
POST   /api/ingest/runs/:id/apply

GET    /api/drafts
POST   /api/drafts                   {name?, skill_id?, origin}
PUT    /api/drafts/:id/file          {path, content} autosave
POST   /api/drafts/:id/validate
POST   /api/drafts/:id/save          through the placement engine
DELETE /api/drafts/:id
GET    /api/drafts/:id/links
POST   /api/drafts/:id/links         {source_id, source_path, track, ref, mode}
DELETE /api/drafts/:id/links/:linkId
POST   /api/drafts/:id/ingest        {all:true, dry:true, budget_usd}
POST   /api/authoring/generate       {prompt, sources, provider, model, budget_usd}
POST   /api/authoring/improve        {skill_id, instruction}

GET    /api/sync/profiles
POST   /api/sync/profiles            {label, remote, branch, direction, include, schedule}
PATCH  /api/sync/profiles/:id
POST   /api/sync/profiles/:id/run    {direction:'push'|'pull', dry:true}
GET    /api/sync/runs
GET    /api/sync/runs/:id/conflicts
POST   /api/sync/runs/:id/conflicts/:path  {take:'local'|'remote'|'both'}
POST   /api/sync/runs/:id/finish

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
- **Path confinement.** Every path from the client is resolved with `realpath` and must sit under a registered root, a configured archive location, or the data directory. Symlinks are resolved and re-checked; loops are rejected.
- **Archive targets.** An archive location is user-chosen and may be any writable path, so it is validated separately: the path must exist, be writable, not be a skill root, and not be inside a skill package. A location that becomes unavailable fails the operation instead of falling back.
- **Ingest writes.** Upstream text is untrusted data in the prompt, fenced and labelled. The model may only return JSON matching the schema; the app validates it before writing. Writes are confined to the composite skill's own directory plus its `references/ingested/`, snapshotted first, and a hash guard refuses if the local skill changed under the run.
- **Untrusted content.** Markdown is rendered with a sanitizer that allows no scripts, no iframes, no event handlers, and no `javascript:` URLs. Remote images are blocked by default and load only after an explicit per-source opt-in.
- **Prompt injection.** Skill text entering a model prompt is fenced as data, the system prompt says so, and the tool surface is an allowlist that cannot run shell commands or open network connections. Curation is dry-run by default.
- **Sync credentials.** A repository token comes from the OS keychain or the git credential helper. It is never stored in `sync_profiles`, never logged, and never echoed in a run report. The secrets scan blocks a commit that contains key-shaped material and cannot be dismissed.
- **Drafts.** Drafts live under the data directory, are never scanned as skills, and reach an agent directory only through the save path, which uses the placement engine and its journal.
- **Secrets.** OS keychain (`@napi-rs/keyring`) with a DPAPI-encrypted fallback file; never in SQLite, never in `config.json`, never in a log, never in an SSE payload.
- **Write safety.** Atomic renames, `fsync` on the journal, and a startup sweep for temp siblings.
- **No telemetry.** The app makes no outbound call except the ones the user configures: source checks and model providers.

## Theming

One token contract, many palettes. Themes live in `themes.json`, shipped with the app, not fetched.

```json
{
  "id": "harbour",
  "name": "Harbour",
  "tint": 215,
  "accent": { "dark": "#6E93B8", "light": "#37628C" },
  "signal": "fixed"
}
```

- The client builds the CSS custom properties from `tint` plus the shared neutral ladder and the accent pair. Components reference tokens only, so no component knows a theme exists.
- `signal: "fixed"` is the whole file today: state colours are not part of a theme. The schema allows it so a future theme cannot quietly change them without a decision.
- Settings store `{ themeId, appearance: "system" | "dark" | "light" }`. Applying is a class on the root plus a variable rewrite; no reload, no flash.
- `scripts/check-contrast.mjs` walks every theme and both appearances, asserts body ≥ 7:1, secondary ≥ 4.5:1, indicators ≥ 3:1, and fails CI on the first pair that misses. It is the gate that makes twelve themes affordable.
- Theme tokens are never persisted in the database per skill, per source or per archive. Appearance is a machine preference, like window size.

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

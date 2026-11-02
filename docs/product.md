# Product

## Who it is for

One developer on one machine, with many coding agents and several hundred skills. The second user is the same person on a second machine, importing the same library. Team features are out of scope for v1.

## Jobs

1. "Show me every skill I have, everywhere, without walking 66 directories by hand."
2. "Turn this one off for Claude Code but leave it on for Cursor."
3. "Tell me when a repo I follow changes a skill, and update it when I say so."
4. "This library has eight skills that should be one. Do the merge and keep it reversible."
5. "Which skills am I not using, and which are duplicates of each other?"

## Feature spec

Each block lists the behaviour and the acceptance test. Screens and measurements live in [ui.md](ui.md); storage and engines in [architecture.md](architecture.md).

### 1. Monitor every known skill directory

Registry-driven, not hardcoded. The registry is `registry/agents.json`, parsed from `vercel-labs/skills` `docs/agents.md` on 2026-11-02: 67 rows, 79 agent codes, 66 distinct global roots, 53 distinct project roots, two project-only agents (Eve, PromptScript). Rows sharing a path (13 agents read `.agents/skills/` globally and in project scope) collapse into one physical root with many owners.

- Detection: a root exists if its directory is present and readable. Detection is a stat, not a guess.
- Scope: global roots always; project roots only for projects the user adds, or for the folder Skill Academy is started in.
- Walk: `<root>/<name>/SKILL.md`, up to three levels deep, matching the container rules in `docs/creating-skills.md` (`skills/`, `skills/.curated/`, `skills/.experimental/`, `skills/.system/`, and the per-agent directories). A `SKILL.md` at a shallower depth shadows anything nested under it.
- Parse: frontmatter `name`, `description`, `metadata.internal`, `version`, `license`, `allowed-tools`, plus any extra keys kept in a JSON column.
- Hash: SHA-256 per file, plus a package hash over sorted `path:hash` lines.
- Ignore: `node_modules`, `.git`, `.archive`, `*.disabled`, and any path the user excludes.
- Ignore failures: an unreadable directory is reported with the absolute path and the OS error, and the scan continues.

**Acceptance.** Cold scan of 2,000 packages across 20 roots completes in under 1.5s on NVMe. A second scan with no disk change writes nothing. A deleted skill disappears from the library within one watcher coalesce window (300ms) and appears in History as `removed on disk`.

### 2. List, filter, search in real time

- The library list is one row per logical skill (frontmatter name + package hash), with a placement count.
- Filtering runs on a client-side index built from one `GET /api/skills/snapshot`. Target: 3,000 skills, keystroke to painted list under 16ms.
- Query syntax: bare words match name, description and tags; `agent:claude-code`, `source:mattpocock/skills`, `is:on|off|mixed|update|stale|drift|internal`, `path:<substring>`, `tag:<tag>`. All clauses AND; words within a clause are fuzzy.
- Sort: Recently changed, Name, Placements, Source, Size. Default Recently changed.
- Empty states: no skills at all (points at onboarding), no results for this query (shows the parsed query and the clause that removed everything), scan in progress (skeleton rows, no spinner).

**Acceptance.** Typing `agent:cursor is:off` returns only skills placed under a Cursor root and disabled there. Clearing the field restores the same scroll position. Search never blocks on network.

### 3. Turn a skill on or off

Three placement modes, one archive. The mode is a property of the placement, chosen by what is on disk, never by preference alone.

| Mode | When | On | Off |
|---|---|---|---|
| Linked | Skill Academy wrote the placement | symlink/junction from agent dir to the library package | remove the link, keep the package |
| Native | The agent or `npx skills` installed a real directory | package present with `SKILL.md` | rename `SKILL.md` to `.SKILL.md.disabled`, keep the directory |
| Shadow | Package is bundled, external-dir, or read-only | read-only | control disabled with a reason |

- Per-agent: the detail pane carries a matrix of agent roots with a switch each.
- Per-skill: the row switch sets the whole set on or off in one action, with an undo toast. Its state is `on`, `off`, or `mixed`.
- Archive: moves the package to `~/.skill-academy/archive/<date>-<name>/`, removes all placements, keeps the record. Restore puts it back with the same placements.
- Journal: every operation writes `before` and `after` state plus the exact filesystem calls, so undo is a recorded inverse, not a guess.
- Drift: if disk disagrees with the journal (link removed by hand, `npx skills update` recreated `SKILL.md`, package deleted), the row shows `Drift` and offers Repair, which shows the diff and does nothing until confirmed.

**Acceptance.** Toggling one skill for one agent changes exactly one filesystem entry, verified by a before/after tree diff. Undo restores the exact previous tree hash. A skill with 9 placements turned off for 3 shows `mixed`, and the detail matrix explains which three. Nothing in this feature ever deletes a file.

### 4. Sources, notifications, scheduled updates

- Source types: GitHub repository (public or token), local git repository, local folder, skills.sh entry.
- A source contributes skills by the same walk rules as an agent root. A skills.sh entry is searched and previewed through the same client and lands in the library like any other source.
- Update detection is per skill, not per repo: the repo's new tree is walked, each skill's package hash is compared with the installed hash. A commit that touches one skill notifies once, not 200 times.
- Event kinds: `release` (new tag), `commit` (new head), `skill-changed`, `skill-added`, `skill-removed`.
- Policy per source: `off`, `notify` (default), `auto` (apply), plus per-skill `pin`.
- Schedule per source: interval (default 6h, jittered 10%), quiet hours, only-while-app-running.
- Apply is guarded: if the installed hash differs from the hash recorded at install, the update is refused and shown as `local changes` with three actions: keep local, take upstream, open diff.
- Before applying, the current package is snapshotted under `~/.skill-academy/snapshots/<source>/<skill>/<iso>/`. Applying is one transaction with a journal entry.
- Notifications: in-app notification center with unread count, optional browser notification when the tab is hidden, optional webhook (Discord or ntfy) with a template. Releases notify immediately; commit bursts collapse into one digest per source per hour.

**Acceptance.** Pointing at `mattpocock/skills` detects 38 skills, records the head SHA and latest release tag, and produces zero notifications on first import. A later release produces exactly one `release` event plus per-skill `skill-changed` events only for skills whose package hash changed. Auto-update on a skill with a local edit refuses and says why.

### 5. LLM curation

Two passes. The deterministic pass needs no model and always runs. The LLM pass is opt-in, dry-run by default, and cannot delete anything.

- Deterministic: transitions between active/stale/archived, exact duplicates by package hash, near-duplicates by name and description similarity for review, oversized `SKILL.md` (over 24k chars), dangling references, missing `SKILL.md`, empty descriptions.
- LLM pass: cluster by prefix and domain, propose umbrella merges, write the merged body in the umbrellas, produce a report with a `consolidations` and `prunings` list. Applying is a separate confirmed action.
- Both passes never touch `pinned`, `shadow`, or `internal` skills, and never archive a skill with unknown usage younger than the stale threshold.

Detail, including the ported prompt policy and thresholds, is in [curation.md](curation.md).

**Acceptance.** A dry run over a library with known duplicates proposes the correct umbrellas, archives nothing, and its report validates against the schema. An applied merge restores byte-identical from archive. A prompt-injection string inside a skill body does not change the run's tool calls.

### 6. Archive anywhere on disk

Archive is a destination, not a folder hidden inside the skill directory. The app never writes `.archive` next to a skill.

- **Named locations.** Settings › Archives holds a list: label, absolute path (including UNC and another drive), mode (`move` or `copy`), and one default. A location can also be the default for one agent, so archiving a Claude Code skill goes to `D:\Archives\claude` while everything else goes to `E:\Skill archive`.
- **Layout.** `<location>/<YYYY-MM-DD>-<name>/` holds the package plus `metadata.json` (original placements, mode, source, hashes, reason, event id). The location also carries `skill-academy-index.ndjson`, one line per archived package, so a restore works after the database is rebuilt or the folder is carried to another machine.
- **Availability is checked, not assumed.** A location on a disconnected drive shows `offline` and refuses the action with the path and the OS error. It never silently falls back to the local disk, because that is how an archive becomes a deletion.
- **Restore.** Hash the package, compare with `metadata.json`, recreate placements in their original modes. A hash mismatch restores as a variant (`name-2`) instead of overwriting the live skill.
- **Retention is off by default.** A location may carry a prune policy (keep N days), and pruning is a scheduled job that reports what it would remove before it removes anything.

**Acceptance.** Archiving to `D:\Archives\skills` and restoring after deleting `index.db` returns the exact tree hash. Unplugging the drive makes the action fail with `E:\Skill archive is offline` and leaves the skill in place. Two archives containing the same skill name restore side by side without collision.

### 7. Linked sources (composite skills)

A local skill can absorb knowledge from several remote skills and stay one skill. The local package is the single artifact an agent loads; the remote skills are sources, not placements.

- **Links.** Each link names a source, a skill path inside it, and what to track: a release tag or a commit on a branch. The skill detail shows a Linked list under the skill: source, tracked ref, last ingested, and status (`up to date`, `3 new commits`, `new release`, `local edits`, `error`).
- **Targets.** A link points at a saved skill or at a draft. Creating an empty skill and assigning sources to it runs through the same engine as linking an existing one; the first ingest on a link is a bootstrap of the whole upstream skill, and every run after it is a delta.
- **Change detection.** A link is compared against its last ingested ref, not against the repository head. A remote skill that changed five times while you were away reads as one delta, not five.
- **Ingest modes.** `distill` (default) extracts durable rules and merges them into the local skill. `attach` copies upstream reference files under `references/ingested/<slug>/` without rewriting the body. `summarize` adds a digest section. The mode is per link.
- **Ingest run.** Resolve the delta since the last ingested ref → select knowledge-bearing files (`SKILL.md`, `references/`, `templates/`, text only, size-capped) → one model call per link or per batch → structured result (`added_rules`, `changed_rules`, `conflicts`, `dropped`) → dry-run diff → apply with a snapshot.
- **Local wins.** A rule that contradicts the local skill stays local and is listed as a conflict in the report. The app never silently replaces a rule the user wrote.
- **Deduplication.** Content already present, or already ingested from another link, is dropped and reported. Two links teaching the same rule produce one rule with two provenance entries.
- **Refresh.** Ingesting again with no upstream change is a no-op, not a rewrite. The resulting local hash is recorded so a later run can tell a user edit from an upstream delta.
- **Protection.** A skill with links is marked composite. The curator never archives or absorbs it automatically; it may propose changes in a report only.
- **Unlink** removes the relationship and keeps everything it produced.

**Acceptance.** Linking two skills from different repositories and ingesting produces labelled sections plus `references/ingested/` entries with per-link commits. A second ingest with no upstream change writes nothing. A new upstream commit produces a dry-run containing only new rules. A contradicting rule keeps the local text and appears under conflicts. Restoring the snapshot returns the skill to its pre-ingest hash.

### 8. Authoring: LLM drafts and a real editor

Two ways in: generate a skill from intent, or open an existing one and edit it. Both end in the same place — a draft that becomes a skill only when saved.

- **Generate.** A prompt field, optional source material (a linked skill, a file, a pasted session note), a provider and model, and a cost estimate. The model returns a complete package: frontmatter with a slug name and a description written for the retrieval window, a body of imperative rules, and `references/` files when the body would pass 24,000 characters. The draft is shown, never saved automatically.
- **Start empty.** Name and description only, then a scaffold with `When to use`, `Rules` and `References` headings and nothing else. The draft opens in the editor with the Linked panel visible, so the skill can be built by assigning sources instead of writing prose. An empty body is a validation warning, not an error; saving a placeholder asks once.
- **Compose from sources.** On a draft, `Add source` appends links to remote skills. `Ingest all` runs one job across every link: bootstrap each upstream, merge them into one body, deduplicate rules that appear twice, and write one `references/ingested/<slug>.md` per link. The draft becomes a composite without ever being a half-written skill in an agent directory.
- **Editor.** CodeMirror 6 in markdown mode, with a toolbar over the field: heading, bold, italic, inline code, code block, bullet, numbered list, link, table, quote, and frontmatter. Keyboard shortcuts for each. Outline pane on the left, live preview on the right, both toggleable.
- **Validation panel.** Required fields, description length, slug collision against the library, body size against the 24k cap, dangling `references/` links, and duplicate package hash. Errors block save; warnings do not.
- **Drafts.** Autosaved every 2 seconds into `~/.skill-academy/drafts/`, never into an agent directory. A draft survives a restart, appears in the sidebar under Unsaved drafts, and never shows up in a scan.
- **Save.** Writes through the placement engine: linked mode writes the library package and re-links, native mode writes in place. The previous version is snapshotted and journaled, so every save is reversible.
- **Improve.** On an existing skill: `Rewrite for clarity` and `Extract rules from notes` produce a diff against the current body. Applying is a second action.
- **Tags.** Reads and writes `tags` in frontmatter, filters by them in the sidebar, and never keeps a tag that exists only in the database.

**Acceptance.** A one-sentence prompt produces a draft that passes validation with zero errors and a description inside the retrieval window. Opening an existing skill and saving without editing produces the same package hash. Saving writes through the placement engine and restores from the snapshot. A draft never appears in any agent's skill directory before it is saved. An empty skill with two assigned links ingests into a composite draft with per-link provenance, and saving it produces one skill with a `Linked` count of 2.

### 9. Cloud sync (backup repositories)

Sync is git, not a proprietary cloud. A profile points at a repository, and the app moves the library through it the way the Hermes DR mirror already works.

- **Profile.** Remote URL, branch, optional path prefix, direction (`backup` or `two_way`), what to include (everything, selected sources, selected agents), and a schedule (manual, on change debounced 5 minutes, hourly, daily).
- **Layout.** `library/<source-slug>/<skill>/…` mirroring the packages, plus `manifest.json` with package hashes, placements and archive index references, so a second machine can restore without this database.
- **Push.** Snapshot → secrets scan → stage → commit with a message naming the changes → push. A key-shaped string anywhere in the tree blocks the commit and names the file and line.
- **Pull.** Fetch → three-way merge against the last synced commit → conflicts listed per file with both versions → resolve per file (`local`, `remote`, or keep both) → apply with a snapshot. A conflict never resolves itself.
- **Never synced.** Provider keys, session tokens, archive contents, snapshots, reports, logs. The manifest records placements as intent, not absolute paths, so the same library can land under a different home directory.
- **Status.** Ahead and behind counts, last push and pull, changed-file preview before applying, and a per-profile state in the status bar.

**Acceptance.** Two machines sync the same library through a private repository and converge on the same package hashes. A local edit and a remote edit to the same file surface as one conflict and nothing is lost. A key-shaped string blocks the push and names the file. Deleting `index.db` and pulling restores the skills and their placements.

### 10. Context cost and health

Two views that answer questions the library otherwise hides.

- **Context cost.** Every skill's characters and estimated tokens, per agent: what its enabled set costs at load, what the largest ten contributors are, and what a disable or archive would save before it is done. Estimates carry a range and are labelled as estimates; the tokeniser is calibrated per model family.
- **Health.** A permanent list of structural problems the scanner and index already know: unparsed frontmatter, missing description, dangling `references/` links, body over 24,000 characters, duplicate hashes, same-name variants, unreadable roots. Safe fixes are one click (recompute hash, drop a dead link); everything else is report-only and links to the file.

**Acceptance.** The status bar shows a token estimate per agent within 5% of the calibration tokeniser. A skill with a dangling reference appears in Health, and opening it puts the caret on the line that names the missing file.

### 11. Scanning and the enable gate

- Every package is scanned when it is indexed, when it is updated, and before it is enabled: prompt-injection patterns, destructive shell operations, silent network calls, credential access, hidden unicode, oversized or binary payloads, and files outside the package.
- Findings carry a severity, a file and a line, with an excerpt. The detail pane shows a risk badge; the list shows a dot.
- Policy is a threshold: `block` (default), `warn`, `off`, configurable per source. A skill above the threshold cannot be enabled without an explicit override, and the override is journaled with the reason.
- An external scanner (the same `skill-scanner` that SkillHub uses) can be plugged in for deeper analysis; the built-in rules always run.

**Acceptance.** A fixture skill containing a curl-to-webhook exfiltration line is blocked from enable with `SKILL.md:14`, and the override path records who allowed it. A clean skill scans in under 200ms. Scanning never modifies a package.

### 12. Lockfile

`skill-academy.lock.json` is written on every mutation: skill name, source, commit or release, package hash, placements as intent, scan verdict, and the archive location label where relevant.

- The same file is the sync manifest, the export format, and the CI input.
- `ska lock --check` (or the equivalent endpoint) exits non-zero when the disk disagrees with the lock.
- Restoring on a machine without the database is `lock` plus packages: skills and placements are rebuilt, and a placement whose root does not exist is recorded as `unplaced` rather than invented.

**Acceptance.** Copying the lock and the packages to a clean machine reproduces every package hash and placement. Deleting one skill on disk makes `lock --check` fail with that skill named.

## Out of scope for v1

Skill execution, team permissions, a hosted registry, Windows service installation, mobile, and authoring anything other than a `SKILL.md` package.

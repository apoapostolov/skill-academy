# Plan

## What this is

Skill Academy is a local web application. A Node service scans every agent skill directory on the machine, indexes what it finds into SQLite, and serves a browser UI on `127.0.0.1:4319`. The UI lists skills, filters them as you type, and switches them on or off per agent. The same service watches the git repositories those skills came from, reports commits and releases, and can apply updates on a schedule. A curation pass, ported from Hermes' curator, proposes merges for skills that should be one class-level skill instead of five narrow ones.

Three things make it different from the tools that already exist. It treats the same skill installed in nine agent directories as one row with nine placements, not nine rows. It never destroys anything: every mutation is journaled with its inverse. And the curation pass copies Hermes' actual policy rather than inventing a similarity score.

## Non-goals

- Not a marketplace. Browsing skills.sh is a source import, not a storefront.
- Not an agent. Skill Academy does not run skills, and does not call an agent to use them.
- Not a sync service. No cloud account, no team sharing in v1. A folder or repo can be shared by putting it under git.
- Not an editor for skill content beyond the repair and merge cases curation produces.
- Not a replacement for `npx skills`. It reads what that tool installs and can repair it; it does not reimplement its download protocol.

## Principles

1. **Nothing is lost.** Archive, never delete. Every write records its inverse before it lands.
2. **The filesystem is the truth.** The database is an index that can be rebuilt from disk. A disagreement shows as drift and asks, never silently rewrites.
3. **Absence of evidence is not staleness.** No usage signal means unknown, and unknown never archives a skill.
4. **One skill, many placements.** Identity is frontmatter name plus content hash, not path.
5. **Untrusted content stays untrusted.** Skill text is data. It is never executed, never injected into a prompt without fencing, never rendered as HTML.
6. **The UI answers in one frame.** Filtering is client-side against an in-memory index. No spinner for typing.
7. **Reversible over clever.** A switch that can be undone beats an automation that guesses.

## Shape

```
browser  ──HTTP/SSE──  Fastify service  ──  SQLite (index + journal)
                            │
                            ├── scanner (chokidar + walkers)
                            ├── link farm (enable/disable/archive)
                            ├── source watcher (GitHub API, git ls-remote)
                            ├── scheduler (updates, curation, rescans)
                            └── LLM layer (11 providers, ported)
```

Per-feature inclusion decisions and milestone cuts are in [docs/triage.md](docs/triage.md). The development loop — one command, hot reload, a panel you can watch — is in [docs/dev-workflow.md](docs/dev-workflow.md).

Detail in [architecture.md](docs/architecture.md). Provider port in [providers.md](docs/providers.md). Curator port in [curation.md](docs/curation.md).

## Phases

Each phase ends with something usable, not a demo.

### P0 — Skeleton and registry (3 days)

Node service, SQLite schema, registry loader from `registry/agents.json`, detection of which agent roots exist on this machine. A read-only screen listing roots and what is in them.

Exit: the app opens, detects at least 10 agent roots on this workstation, and lists skill counts per root without writing anything.

### P1 — Scan and library (7 days)

Full walker, frontmatter parser, file hashing, duplicate folding, drift-free rescan. The library screen with sidebar, list, detail, and instant filter. Token accounting per skill and per agent set. Health view over the checks curation already computes.

Exit: 2,000 synthetic skills across 20 roots scan cold in under 1.5s; typing in the filter never exceeds 16ms per keystroke; a second scan of unchanged disk produces zero writes; the status bar reports the token cost of every agent's enabled set within 5% of a real tokeniser.

### P2 — Switches and archives (17 days)

Link farm with the Windows symlink → junction → tracked-copy chain, native rename mode, named archive locations, restore, undo journal, drift detection and repair. Per-agent matrix in the detail pane, tri-state row switch, bulk actions, presets applied to one agent scope or all, and project workspaces: register a repository, compare its project skills with the library by hash, promote or apply with a diff. Right-click on any row for archive with its switch, delete, reveal and copy path. Delete moves the package to a 30-day trash that restores the path and the placements, and purges to the OS Recycle Bin rather than unlinking. Content scanning with a risk badge and a gate on enable: a skill that fails the policy cannot be turned on without an explicit override.

Exit: every enable, disable and archive on this workstation is reversible from the journal; a skill toggled off in Claude Code stays on in Cursor; an archive to a second drive restores after `index.db` is deleted; an offline archive location refuses instead of falling back; a skill containing a shell exfiltration line is flagged and blocked from enable with the file and line; killing the app mid-write leaves a recoverable state.

### P3 — Sources and updates (11 days)

Add a GitHub repo, a local git source, a skills.sh entry, or a direct URL/zip. Snapshot its skills, detect per-skill changes at a new commit, notify, apply with snapshot and local-edit guard, schedule per source. Show the registry's own audit verdict beside ours where it exists. Write `skill-academy.lock.json` on every mutation so the library is reproducible on another machine.

Exit: a real repo (`mattpocock/skills`) reports a new release and a changed skill separately; a locally edited skill is refused with a diff, not overwritten; an auto-update run can be rolled back to the previous bytes; a fresh machine reproduces the same package hashes and placements from the lock alone.

### P4 — Providers and curation (7 days)

Port the provider layer, settings UI with key and OAuth sign-in, model catalogue fetch, cost display. Then the deterministic curation pass, then the LLM consolidation pass with dry-run reports and approval.

Exit: every one of the 11 providers answers a test call with a real key or a real sign-in; a dry-run curation on this library produces a report with merges that survive reading; an applied merge restores exactly from archive.

### P5 — Linked sources (6 days)

Link a local skill to remote skills, resolve deltas since the last ingested ref, ingest in three modes, conflicts surfaced, provenance written, snapshot and undo.

Exit: a first ingest on a skill linked to two repositories writes distilled sections and `references/ingested/` with per-link commits; a second run with no upstream change writes nothing; a contradicting rule keeps the local text and is listed; restore returns the pre-ingest hash; a composite skill survives a curation run untouched.

### P6 — Authoring (9 days)

Generate a draft from intent, start empty, assign sources to a draft and compose a composite from them, CodeMirror editor with the markdown toolbar, outline, preview, validation, autosave, save through the placement engine, improve-with-diff. Tag read and write into frontmatter, with a tag filter in the sidebar.

Exit: a one-sentence prompt yields a draft that validates clean; an empty skill with two assigned links ingests into a composite draft with per-link provenance; opening and saving an unchanged skill returns the same package hash; a draft never appears in an agent directory; every save is restorable from the snapshot.

### P7 — Cloud sync (5 days)

Git profiles, manifest, push with secrets scan, pull with three-way merge and per-path conflict resolution, schedules, status. Merging is skill-aware: a rename on one machine combines with an edit on another instead of presenting as a delete-plus-add.

Exit: two machines converge on the same package hashes through a private repo; a conflicting edit surfaces as one conflict and loses nothing; a key-shaped string blocks the push; deleting `index.db` and pulling restores skills and placements.

### P8 — Polish (6 days)

Onboarding, empty states, keyboard map, accessibility pass, dark mode, twelve themes with the contrast gate, notification center, reduced motion. Copy pass in Apo's voice.

Exit: keyboard-only run of the five main flows; contrast check on every surface; screen reader labels on every control; no layout shift on scan.

### P9 — Parity: MCP, then CLI (6 days, after v1)

An MCP server exposing `list`, `search`, `enable`, `disable`, `scan`, `lock` first, because an agent asking for a skill is the likelier caller; then a thin `ska` CLI over the same local API for scripts and SSH. Deferred because the service is the source of truth and both add reach, not capability.

Exit: an MCP client can list and enable skills without the browser; enabling from the CLI produces the same journal entry as the UI; `lock --check` exits non-zero on drift and is usable in CI.

Total: about 71 working days for v1. With the parity pass, 77. P0-P3 is a usable product; linking, authoring, sync and curation are amplifiers, not prerequisites.

## Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| Agent discovery rules change | 79 agents, undocumented corners; a root that scans recursively could pull in a whole project | Registry is data with a source URL and a date; walkers are depth-capped; unknown layouts surface as "unrecognized" instead of being guessed |
| Renaming `SKILL.md` confuses an agent | Some agents cache skill lists, some watch files | Prefer linked placements; native mode only when the app does not own the package; document which agents re-read on change |
| Update clobbers local edits | Users edit installed skills in place | Installed hash recorded at write; mismatch blocks the update and shows a three-way diff |
| Curation merges damage a good library | LLM writes are the highest-risk action in the app | Dry-run default, archive-not-delete, `absorbed_into` required, full restore, token budget |
| Prompt injection through skill text | Skill bodies are attacker-controlled content in a prompt | Fenced data blocks, tool allowlist, no shell, no network tools, dry-run first |
| Scan cost on a large disk | Watching 66 roots including project trees | Depth cap, ignore list, per-root opt-out, incremental rescan, coalesced events |
| Provider keys leak | Local web app with a browser surface | Keys in OS keychain, never in SQLite, never sent to the renderer, redacted logs |
| Archive location offline or moved | Drive letters change, network shares drop; a silent fallback would orphan the skill | Resolve at use time, refuse with the path, index on disk, re-point in Settings |
| Ingest writes bad prose into a good skill | It is the second LLM write path, and it edits a skill the user owns | Dry run, distilled rules only, conflicts listed, snapshot, hash guard, one-click restore |
| Ingest cost on a large first delta | A whole-skill first ingest can be 100k tokens | File caps, per-run budget, `attach` mode for cheap copies, chunk by file group |
| LLM authoring writes a confident, wrong skill | A generated SKILL.md can invent commands or tools that do not exist | Schema-validated draft, validation gate before save, no auto-save, improve returns a diff, the model never writes a live skill |
| Sync merge loses an edit | Two machines editing the same file | Three-way merge against the last synced commit, per-path resolution, snapshot before apply, nothing resolves itself |
| A secret reaches the sync repository | Skills can contain a key, and a repo is forever | Secrets scan blocks the commit with file and line; keys never enter the tree; private remote only |
| A composite built from many upstreams becomes a grab bag | Every source teaches something slightly different, and the merged skill has no single trigger | The description must name the class before ingest runs, duplicates are dropped, the report shows per-link contribution, and links soft-cap at 8 |
| Twelve themes multiply the visual QA surface | Every palette is a chance to ship an unreadable accent or a muddy surface | Fixed state colours, one neutral ladder, and a contrast script over all 24 variants that fails CI |
| The scanner blocks a skill the user needs | Pattern rules catch legitimate code, and a hard gate becomes an obstacle | Severity policy with an explicit, journaled override; per-source scan settings; findings always name file and line |
| Token estimates drift from the model | A character-to-token ratio is an approximation | Calibrate per model family, show a range rather than a false precision, and label it as an estimate |

## Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Web app served by a local Node service, not Electron | The brief says web; a local server also gives a real background process for scanning and schedules |
| D2 | SQLite as an index that can be rebuilt, not a source of truth | Disk changes under the app constantly; a rebuild must always be possible |
| D3 | TypeScript end to end | The provider port is JavaScript already; one language removes a translation step |
| D4 | Fastify + SSE, no WebSocket | One-way event stream is all the UI needs; SSE survives proxies and is trivial to debug |
| D5 | Client-side filter index | Typing must not wait on the server |
| D6 | Symlink/junction placements preferred, rename as fallback | Mirrors what `npx skills` recommends and what the OS supports without elevation on Windows |
| D7 | Archive instead of delete, always | Matches Hermes' own curator rule and makes the riskiest features reversible |
| D8 | Port providers verbatim, including OAuth quirks | String Theory already solved Codex base URL, Anthropic beta header and catalogue-as-health-check |
| D9 | Curation is dry-run by default | It is the only feature that can make the library worse |
| D10 | Usage telemetry is honest about being unknown | No cross-agent usage signal exists; pretending otherwise would archive good skills |
| D11 | Dark-first, grey-forward, PC-software density | Apo's stated taste: polished desktop software, dark default, neutral grey chrome, and a replaced signal palette (verdigris / raw sienna / rosewood / dusty blue) instead of system green, amber and red. Owned by [docs/ui.md](docs/ui.md) |
| D12 | Archive is a configured destination, never a folder inside the skill | Users keep archives on another drive; a hidden `.archive` next to a skill is invisible to backups and dies with the folder |
| D13 | Linked sources are composites owned locally, with remote provenance | One skill an agent loads, many upstreams; the local file stays the user's, and every ingested rule traces to a commit |
| D14 | Authoring is draft-first and the model never writes a live skill | A generated body can be plausible and wrong; a draft plus a validation gate keeps every write deliberate and reversible |
| D15 | Sync is git over the user's own private repository | Matches the existing DR habit, gives real history and three-way merge, and keeps the library portable without a service |
| D16 | Links attach to drafts as well as saved skills, and the first ingest is a distinct bootstrap run | An empty skill has to be composable before it is placed; bootstrap is not a delta and pretending otherwise corrupts provenance |
| D17 | Themes change accent and chrome tint only; state colours are fixed | Twelve skins that each redefine green and red make state unlearnable and break the contrast guarantee |
| D18 | A skill that fails the scan policy cannot be enabled without a recorded override | Every peer that ingests untrusted repositories scans them; auto-updating unscanned content is the one risk we cannot accept |
| D19 | One lockfile is the contract for sync, CI and export | A journal records history; a lock records the exact state another machine must reproduce |
| D20 | We measure context cost, not usage | Character and token counts are observable; which skill an agent loaded is not, and a fabricated usage number would drive bad archives |

## Open questions for Apo

1. **Name.** "Skill Academy" is a working title. Alternatives: Skillroom, Rack, Atelier.
2. **Scope of the first build.** P0-P2 is the useful core. Do you want sources and updates in the same pass, or shipped after you have lived with the library for a week?
3. **Library location.** Default `~/.skill-academy` (canonical packages, archive, journal). Any objection to that path?
4. **LAN access.** Local-only by default. Do you want a token-gated LAN mode for the Bedroom machine?
5. **Auto-update default.** I plan `notify` for every source, with auto-update opt-in per source. Confirm.
6. **Curation model budget.** One consolidation run on your library is roughly 60k-150k input tokens depending on cluster count. Cap per run?
7. **Default archive location.** `~/.skill-academy/archive` is the fallback. Do you want a drive path as the default (for example `E:\Skill archive`), and one per agent?
8. **Ingest defaults.** Distill for every link, or `attach` first so you can read the upstream before any model rewrites your skill?
9. **Sync remote.** A dedicated `skill-academy-library` private repo, or a folder inside the existing DR repository?
10. **Authoring model tier.** Cheap tier for drafts you will edit anyway, or the strong tier for fewer passes?

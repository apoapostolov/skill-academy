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
- A source contributes skills by the same walk rules as an agent root.
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

## Out of scope for v1

Skill authoring from scratch, skill execution, cloud sync, team permissions, a hosted registry, Windows service installation, mobile.

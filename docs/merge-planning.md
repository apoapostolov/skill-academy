# Merge planning dialog

One dialog that answers "what happens to these skills before anything happens to them". The merge
itself was already proven; this phase gives it a screen, a transaction, and a way back.

Everything below is read-only until an explicit approve. Each flow shows its plan, its diff and the
files it will touch; nothing writes on hover, on selection, or on opening the dialog.

## The three flows

### 1. Promote the newer copy

Two copies of one skill, an older version and a newer version. The newer body wins, **except** where
the older copy holds something the newer one does not.

- The plan lists the drift first: rules, sections, reference files and support files present in the
  older copy and absent from the newer one.
- Drift is carried into the promoted copy by default. Dropping it is a separate, explicit choice per
  line, never a silent consequence of choosing the newer file.
- The promoted copy is written from the newer body plus the carried lines, then the older copy goes
  to the trash. Neither copy is deleted.
- The report states the version moved, the files that differed and the number of lines carried.

### 2. Consolidate into X

A, B, C and D fold into one skill X. X may take the name of one of them.

- The plan names the survivor, the new skill's directory, the merge model, and the fold result with
  its audit (kept rules, dropped rules, invented lines).
- Applying creates X, moves every source into the internal trash, and records one journal entry.
  Each trashed package can be viewed, restored byte-identically, or purged now.
- A router is written instead of a merged body when one copy has no unique content — the existing
  fold rule, unchanged.
- Nothing is ever unlinked: the trash is the only destination.

### 3. Improve A with AI

A request against one skill, run as a job rather than a single call.

- The job reads the package, analyses it, proposes full file contents, validates the proposal, then
  renders a diff. Every step is recorded with its duration, so a long run is visible while it runs.
- The result is a per-file diff, never a rewritten file on disk. Approve applies through a snapshot
  so the previous state is one click away.
- A run that changes nothing says so and writes nothing.

## The diff pane

- One unified diff per file, dimmed red and green — no system red or green, no saturated fills — and
  every changed line also carries a `+` or `−` glyph so colour is never the only signal.
- Files covered: `SKILL.md`, its frontmatter as its own region, every `references/**/*.md`, and
  `templates/**`.
- Grouped by file with a header naming the path and the line counts; the file list is the spine and
  the diff follows the selection.
- A manifest line for anything that is not prose: assets and scripts are listed with their kind,
  size and whether they are added, removed, kept or replaced. An added or replaced image is shown as
  a thumbnail.
- Long lines scroll horizontally inside the diff pane only; the dialog never scrolls sideways.

## The rest of the screen

- **Right-click a row: Move and Improve.** Move opens the placement dialog; Improve opens the job
  dialog. Copy path, Copy name and Archive stay where they were.
- **Move.** Every detected agent root is listed with a checkbox and a `core` radio. One root holds
  the real package; the others receive a link, or their own copy when the footer switch says Move.
  The result list names per root what happened and why it failed.
- **Deleted.** The sidebar carries one row for the trash with a live count. It opens a dialog with
  Select, Wipe all, and a right-click menu of Recover (dimmed verdigris) and Delete, and Delete asks
  once because it cannot be undone inside the app.

## Cases the first sketch missed

### Identity and topology

- **Three or more copies.** Pairwise promote does not scale, so a group of N is ordered by evidence
  the dialog shows: version, then provenance commit date, then mtime. The user picks the winner from
  that order rather than the app assuming "highest version" — a deliberate revert is a real case.
- **Newer version number is the older copy.** A revert looks like a regression. The plan says
  `2.1.0 → 1.9.0` in words and requires an acknowledgement; nothing is promoted silently downward.
- **Name variants.** `Skill A`, `skill-a` and `skill_a` are one group with three spellings. The plan
  requires one name for the result.
- **Equal hashes.** Nothing to promote. The flow degrades to "these are identical; archive one" and
  never proposes a merge.
- **One copy is a subset.** The older package holds two reference files the newer one lost. Body-only
  drift would miss this, so the file inventory is compared file by file, not line by line.
- **A copy that is itself composite.** A linked skill may be the survivor but never a loser: its
  links point at it. Otherwise repositories keep feeding a directory nobody reads.
- **Link placements.** The same bytes can be a real directory in one agent root and a symlink in
  another. The plan states per copy which agents stop seeing which path, and applies through the
  placement engine rather than moving folders behind its back.
- **Protected roots.** A copy inside the live agent library is shown but blocked, with the path and
  the reason, until the deliberate override is set.

### What counts as drift

- **Frontmatter drift.** An edited description, added tags, a changed category or a hand-set version
  is drift. Frontmatter merges field by field: tags union, description from the winner unless the
  loser's is the only one inside the retrieval window, version the higher of the two.
- **File drift versus line drift.** A lost script, template or image is a missing file, not a
  missing line. The carry list keeps them as files and names their kind.
- **Moved, not missing.** Before anything is called drift its normalised text is searched across the
  whole winner package, including reference files: a rule that moved from a body into `references/`
  is a move, and moves are reported separately from losses.
- **Whitespace and line endings.** Normalised before comparing, exactly as the versioning monitor
  does, so a CRLF copy is not a hundred pieces of drift.
- **Drift that is itself ingested.** Text under a `## From <source>` section came from a link, not
  from the user. It is not organic drift and is not carried twice.
- **Contradictions, not gaps.** A contradiction is a decision item with both rules, asked for on
  demand because the check costs a model call.
- **Deliberate removals.** When provenance is known the newer copy's commits can be read, so a rule
  removed on purpose is not carried back as if it were an improvement.
- **Drift in the package's own trees.** `scripts/`, `templates/` and assets are compared by hash and
  carried file for file; a script is never merged line by line.

### Consolidate into X

- **X's identity is new.** Name, description and tags are regenerated for X, with the tags union and
  the survivor's description, instead of inheriting a stale body.
- **All or nothing.** The sources move first, each verified, then X is promoted from a staging
  directory; on any failure every moved package comes back and X's directory is removed.
- **Placements follow the trash.** A moved skill's agent placements are removed through the same
  engine so the journal holds the inverse; restoring from the trash recreates them.
- **Name reuse collision.** If X takes A's name, the row for A leaves the index in the same operation
  that inserts X, so the library never lists both.
- **Restoring after consolidation reopens a duplicate group.** Allowed, and the restore message says
  so, because a silent second copy is how libraries rot.
- **Git-tracked library.** If the packages live in a repository, the plan says the folders will move
  and the repository will show deletions.
- **Disk and hash proof.** Every move is verified by a package hash before it counts.

### Improve as a job

- **Bounded.** Step budget, token budget and a wall clock. Hitting either produces a partial
  proposal that says which files it did not reach.
- **Never invents support.** Any added line naming a path, command or flag that exists neither in the
  package nor in its linked sources is listed as unsupported, and an apply with unsupported lines is
  refused.
- **Ignores linked sections.** Inside a composite skill the ingested sections belong to their links;
  a proposal that would add one is blocked.
- **Idempotent.** The job records the package hash it started from; an apply against moved bytes is
  refused rather than merged into a surprise.
- **Shrinking is loud.** A proposal that would remove more than a fifth of the body says so.
- **Frontmatter stays valid.** A proposal that would break the name contract is refused before it
  reaches the diff.

### The diff pane

- **Stale plans self-report.** If a file changes on disk while the dialog is open, the apply refuses
  on the hash guard, in the same words the ingest engine uses.
- **Large files.** A diff past a few thousand lines is summarised with a per-file count.
- **Binary and assets.** No text diff: a thumbnail with dimensions for an image, plus the size delta.
- **Scripts are shown, never run.** Highlighted as text, listed in the manifest, never executed.
- **Totals before detail.** Files changed, lines added, lines removed, assets and scripts touched.

### Undo, record and concurrency

- **One undo for one plan.** Each flow is a single journal entry.
- **A second approve fails.** A plan carries the hashes it was computed against; applying after the
  package moved answers `plan-stale` instead of writing again.
- **No deletes, ever.** Archive and trash are the only destinations; purge is the only removal and it
  goes to the OS Recycle Bin, with the error shown if that call fails.

## Built (P4.5)

`bash scripts/merge-plan-check.sh` — 50 checks, a temporary agent root, one real model job:

| Part | Where | Proof |
| --- | --- | --- |
| Package diff with frontmatter region, binaries and manifest | `server/src/plandiff.ts` | `the plan shows the finished package as files`, `assets and scripts are named in the manifest` |
| Promote plan with drift, moves, frontmatter and revert detection | `server/src/promote.ts` | `the drift names the rule only the older copy has`, `a revert is detected` |
| Acknowledgement gate | `POST /api/promote/apply` | `applying without the acknowledgement is refused` |
| Carry the drift, archive the loser | `applyPromote()` | `the carried rule is in the promoted copy`, `the loser is in the trash` |
| Consolidation transaction with staging and rollback | `server/src/mergeIntoX.ts` | `the consolidation applies`, `a failing consolidation reports the failure`, `no half-written X is left behind` |
| Sources to the trash, restore byte-identically | `archiveSkill` / `restoreTrash` | `the trash lists a source`, `the restored copy is byte-identical` |
| Improve as a five-step job | `server/src/improveJob.ts` | `the job walks several steps`, `nothing was written before approve` |
| Per-file apply and undo | `POST /api/improve/apply`, `/undo` | `the improve applies`, `the package on disk is back to its original bytes` |
| Move across roots with one core | `POST /api/skills/:id/move` | verified in the app: 18 roots listed, one core, Link/Move switch |
| Deleted, with wipe, select, recover and delete | `web/src/Merge.tsx`, `POST /api/trash/wipe` | verified in the app |

## Deferred, and why

- **Fold into an existing X.** A name that already exists is refused with the path; folding into a
  standing skill needs its own diff and its own undo entry, which is a separate flow.
- **Placement consequence preview.** The plan names files, not yet which agents gain or lose a path.
- **Contradiction check in the dialog.** The endpoint takes `contradictions: true` and the model
  answers; the dialog does not request it yet because every plan would then cost a call.
- **Per-file accept in Improve.** The server accepts a file list; the dialog applies everything the
  job proposed.

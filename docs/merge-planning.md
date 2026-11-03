# Merge planning dialog

One dialog that answers "what happens to these skills before anything happens to them". Today the
Consolidate screen shows groups of duplicate bodies and a two-gate apply; the merge itself is proven,
but the screen cannot yet express the three things a user actually wants to do with a group.

Everything below is read-only until an explicit approve. Each flow shows its plan, its diff and the
files it will touch; nothing writes on hover, on selection, or on opening the dialog.

## The three flows

### 1. Promote the newer copy

Two copies of one skill, an older version and a newer version. The newer body wins, **except** where
the older copy holds something the newer one does not.

- The plan lists the drift first: rules, sections, reference files and support files present in the
  older copy and absent from the newer one.
- Drift is carried into the promoted copy by default. Dropping it is a separate, explicit choice per
  item, never a silent consequence of choosing the newer file.
- The promoted copy is written from the newer body plus the carried lines, then the older copy is
  archived. Neither copy is deleted.
- The report states the version moved, the files that differed and the number of lines carried.

### 2. Consolidate into X

A, B, C and D fold into one skill X. X may take the name of one of them.

- The plan names the survivor, the new skill's directory, the merge model, and the fold result with
  its audit (kept rules, dropped rules, invented lines).
- Applying creates X, moves A, B, C and D into the internal trash, and records one journal entry per
  moved package. Each trashed package can be viewed, restored byte-identically, or purged now.
- A router is written instead of a merged body when one copy has no unique content — the existing
  fold rule, unchanged.
- Nothing is ever unlinked: the trash is the only destination.

### 3. Improve A with AI

A request against one skill, run as a job rather than a single call.

- The job reads the package, proposes edits per file, and iterates: read, propose, check the result
  against its own sources, repeat within a step budget. Progress is visible while it runs.
- The result is a per-file diff, never a rewritten file on disk. Approve applies through the
  placement engine with a snapshot so the previous state is one click away.
- A run that changes nothing says so and writes nothing.

## The diff pane

- One unified diff per file, dimmed red and green — no system red or green, no saturated fills — and
  every changed line also carries a `+` or `−` glyph so colour is never the only signal.
- Files covered: `SKILL.md`, every `references/**/*.md`, `templates/**`, and the frontmatter as its
  own region.
- Grouped by file with a header naming the path and the line counts; the file list is the spine and
  the diff follows the selection.
- A manifest line for anything that is not prose: assets and scripts are listed with their kind,
  size and whether they are added, removed, kept or replaced. An added or replaced image is shown as
  a thumbnail with its dimensions.
- Long lines scroll horizontally inside the diff pane only; the dialog never scrolls sideways.

## Cases the first sketch missed

### Identity and topology

- **Three or more copies.** Pairwise promote does not scale, so a group of N is ordered by evidence
  the dialog shows: version, then provenance commit date, then mtime. The user picks the winner from
  that order rather than the app assuming "highest version" — a deliberate revert is a real case.
- **Newer version number is the older copy.** A revert looks like a regression. The plan says
  `2.1.0 → 1.9.0` in words and requires an acknowledgement; nothing is promoted silently downward.
- **Name variants.** `Skill A`, `skill-a` and `skill_a` are one group with three spellings. The plan
  requires one name for the result and shows which copy it comes from.
- **Equal hashes.** Nothing to promote. The flow degrades to "these are identical; archive one" and
  never proposes a merge.
- **One copy is a subset.** The older package holds two reference files the newer one lost. Body-only
  drift would miss this, so the file inventory is compared file by file, not line by line.
- **A copy that is itself composite.** A linked skill may be the survivor but never a loser: its
  links point at it. If it must be replaced, every link is re-pointed at X in the same transaction
  and the plan says so, because otherwise four repositories keep feeding a directory nobody reads.
- **Link placements.** The same bytes can be a real directory in one agent root and a symlink in
  another. The plan states, per copy, which agents stop seeing which path, and applies through the
  placement engine rather than by moving folders behind its back.
- **Protected roots.** A copy inside the live agent library is shown but blocked, with the path and
  the reason, until the deliberate override is set. This is the existing `protected-root` refusal,
  surfaced in the plan instead of at the last click.

### What counts as drift

- **Frontmatter drift.** An edited description, added tags, a changed category or a hand-set version
  is drift. Frontmatter merges field by field: tags union, description from the winner unless the
  loser's is the only one inside the retrieval window, version the higher of the two.
- **File drift versus line drift.** A lost script, template or image is a missing file, not a
  missing line. The carry list keeps them as files and names their kind.
- **Moved, not missing.** Before anything is called drift its normalised text is searched across the
  whole winner package, including reference files: a rule that moved from a body into
  `references/` is a move, and moves are reported separately from losses.
- **Whitespace and line endings.** Normalised before comparing, exactly as the versioning monitor
  does, so a CRLF copy is not a hundred pieces of drift.
- **Drift that is itself ingested.** Text under a `## From <source>` section came from a link, not
  from the user. It is not organic drift and is not carried twice.
- **Contradictions, not gaps.** The older copy says "never X" and the newer says "always X". Carrying
  both makes a skill that argues with itself, so a contradiction is a decision item with both rules
  and the source of each, never an automatic carry.
- **Deliberate removals.** When provenance is known the newer copy's commits are read: a rule whose
  removal appears in a commit message is flagged "removed on purpose at `<sha>`" with the message,
  because carrying it back is a regression dressed as preservation.
- **Drift in the package's own trees.** `scripts/`, `templates/` and assets are compared by hash.
  A changed script is listed and can be carried file-for-file; it is never merged line by line.

### Consolidate into X

- **X's identity is new.** Name, description and tags are regenerated for X (tags union, category
  from the chosen family, version reset), instead of inheriting the survivor's stale description.
- **All or nothing.** The four moves and the X write are staged: move to trash, verify each hash,
  write X, verify X, and on any failure put every moved package back and remove X's directory. A
  half-applied consolidation is worse than a refused one.
- **Placements follow the trash.** A moved skill's agent placements are removed through the same
  engine so the journal holds the inverse; restoring from the trash recreates them, which is what
  makes "recoverable" true rather than decorative.
- **Name reuse collision.** If X takes A's name, the row for A must leave the index in the same
  operation that inserts X, so the library never lists both. The trash is excluded from scanning by
  construction, so the moved package cannot reappear as a ghost row.
- **Fold into an existing X.** A name that already exists outside the group is a fourth variant:
  fold the group into that standing skill with its own diff, rather than refusing and leaving the
  user to rename something.
- **Restoring after consolidation reopens a duplicate group.** Allowed, and the restore message says
  so, because a silent second copy is how libraries rot.
- **Git-tracked library.** If the packages live in a repository, the plan says the folders will move
  and the repository will show deletions — otherwise the first `git checkout` resurrects the losers
  and the next scan reports a merge that never happened.
- **Disk and hash proof.** Every move is verified by a package hash before it counts. A moved folder
  that does not hash the same is treated as a failure of the whole apply.

### Improve as a job

- **Bounded.** Step budget, token budget and a wall clock. Hitting either produces a partial
  proposal that says which files it did not reach, never a silent stop.
- **Never invents support.** An extra check rejects any added line naming a path, command or flag
  that exists neither in the package nor in its linked sources, and lists those lines as unsupported.
- **Ignores linked sections.** Inside a composite skill the ingested sections belong to their links;
  the editor marks them locked and the job may not edit them. Otherwise the next ingest fights the
  improvement forever.
- **Per-file accept.** A job touching five files is approved file by file, not all-or-nothing, and
  the diff shows the acceptance state per file.
- **Idempotent.** The job records the package hash it started from; a second run on unchanged bytes
  proposes nothing, and an apply against moved bytes is refused rather than merged into a surprise.
- **Cancellable.** A cancel keeps the proposal as history, writes nothing and releases the target.
- **Shrinking is loud.** A proposal that would remove more than a fifth of the body needs an explicit
  acknowledgement, because "improve" that quietly deletes half a skill is the worst failure mode here.
- **Frontmatter stays valid.** A proposal that would break the name/description contract is refused
  before it reaches the diff, the same validator the editor shares.

### The diff pane

- **Stale plans self-report.** If a file changes on disk while the dialog is open, the pane marks the
  plan stale and the apply refuses on the hash guard, in the same words the ingest engine uses.
- **Large files.** A diff past a few thousand lines is summarised with a per-file count and a jump to
  the file in the package pane; the dialog never renders a hundred thousand lines.
- **Deleted files stay readable.** The only place a removed file's content still exists before apply
  is the diff, so a deletion shows its content collapsed rather than only a path.
- **Binary and assets.** No text diff: a thumbnail pair with dimensions for an image, and a one-line
  note for anything else, plus the size delta.
- **Scripts are shown, never run.** Highlighted as text with a lock glyph that says scripts are not
  executable from the app — the same rule the package pane already follows.
- **Totals before detail.** A strip at the top: files changed, lines added, lines removed, files
  added, files removed, assets touched. The count of files that will disappear is the loudest number
  on the screen.
- **Unchanged files are hidden by default**, with a toggle, because a diff that includes everything
  hides the change.
- **Consequence preview.** The plan ends with what the agent roots gain and lose — a small placement
  diff — because that is the part users feel after the fact.

### Undo, record and concurrency

- **One undo for one plan.** The whole flow is a single journal entry, so `u` reverses a four-package
  consolidation rather than one move out of four.
- **Every apply keeps its plan.** The applied run stores the plan and the diff it was approved with,
  so History can show what was agreed, not just that something happened.
- **A second approve fails.** A plan carries an id and the hashes it was computed against; the same
  plan applied twice, or applied from two windows, answers `plan-stale` instead of writing again.
- **No deletes, ever.** Archive and trash are the only destinations; purge is the only removal and it
  goes to the OS Recycle Bin, with the error shown if that call fails.

## Exit criteria

- Promoting an older copy whose body holds one rule the newer copy dropped keeps that rule, lists it
  as drift, and the promoted package contains it.
- A revert (lower version in the newer commit) is refused until acknowledged, and reports the move
  in words rather than as a number.
- Consolidating four placeholder skills creates X, moves all four into the trash, and restoring one
  returns it byte-identically with its placements recreated.
- A forced failure on the third move leaves the first two back where they were and no X behind.
- An Improve job on a placeholder skill shows at least two steps, produces a per-file diff, writes
  nothing before approve, and one apply plus one undo returns the original package hash.
- The diff pane renders `SKILL.md` and two reference files with dimmed red and green lines, names an
  added image and a removed script in the manifest, and states which agent roots change.

## What already exists, and what this adds

| Part | State |
| --- | --- |
| Fold with source audit and router rule | built, proven on fixtures |
| Two-gate apply, archive and exact restore | built, proven on fixtures |
| Trash table with a 30-day purge | built (archive feature); restore and clear inside the merge dialog are new |
| Per-file diff rendering | exists in the versioning monitor; a shared component and the merge wiring are new |
| Drift carry-forward, frontmatter merge, contradiction list | new |
| Multi-package transaction with rollback | new |
| Improve as a multi-step job with progress, per-file accept, unsupported-claim check | new |
| Placement consequence preview | new |

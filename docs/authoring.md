# Authoring (P6)

A draft is a skill that does not exist yet. It lives under the app's own data directory
(`DATA_DIR/drafts/<id>/`), never in an agent folder, and it reaches an agent only when the author
saves it through the placement engine. Everything else in this document follows from that sentence.

## The screen

The sidebar carries **Drafts** beside All skills, Needs attention and Deleted. The middle column
lists the drafts with their state (`valid` or `needs work`), character count and source count, and
opens with two ways to begin:

- **Describe it** — one sentence in the field, **Draft it** produces a draft whose frontmatter,
  description and rule sections come from the model. The draft is what the author edits; nothing is
  placed.
- **Empty** — a template with an empty description, which the validator immediately flags.

The detail pane becomes the editor:

| Part | What it does |
| --- | --- |
| Toolbar | bold, italic, code, heading, bullet, link — each wraps the selection and leaves the caret usable |
| Editor | CodeMirror 6 with markdown mode, line numbers, wrapping and history |
| Preview | the same renderer the detail pane uses, which drops raw HTML rather than executing it |
| Outline | every `#`, `##` and `###` heading, indented by level |
| Validation | the issues, in the order a reader would hit them |
| Sources | the draft's links, with **Ingest** per source and a field to add one |
| Save… | the agent roots, so the package lands in the library and the chosen root points at it |

Autosave writes the draft 600 ms after the last keystroke and re-runs validation on the answer, so
the validation panel and the list row always describe the text on disk.

## Composition from sources

A draft takes links exactly as a saved skill does (`POST /api/drafts/:id/links`), and each source
ingests through the same plan/apply pair the linked-sources phase uses. The result is a composite
draft: one `## From <source> (repo@sha)` section per link plus `references/ingested/<slug>.md`, with
the commit recorded per section. A draft is never a consolidation candidate, and consolidation
already refuses composites, so assembling one here cannot be undone by a merge elsewhere.

## Validation

`validateDraft()` reads the frontmatter the way the scanner does and reports:

- `no-frontmatter` / `unclosed-frontmatter`
- `no-name`
- `name-mismatch` — only when the folder name is known and differs, which at save time means the
  author overrode the name
- `no-description` and `long-description` (over 240 characters)
- `empty-body`
- `dangling-reference` — a `references/…`, `scripts/…`, `assets/…` or `templates/…` path the draft
  does not carry

A draft with any issue cannot be saved: the save route answers `invalid-draft` with the list.

## Saving

Save is the only act that touches an agent, and it is one transaction:

1. Validate; refuse on any issue.
2. Copy the draft's folder into `LIBRARY_DIR/<name>`.
3. Copy the package aside to `DATA_DIR/drafts/.snapshots/<name>-<stamp>` when one already exists.
4. Place the package into the chosen agent root through `place()` — junction, then symlink, then a
   tracked copy, the same chain the switch uses.
5. Journal the save with the snapshot path, so one undo puts the previous bytes back or removes the
   package entirely.

A second save of unchanged text returns the same package hash; the snapshot is the only difference
between the two runs.

## Improve

**Improve** sends the draft text and an instruction to the model and comes back with a proposal, not
an edit: the text, a diff against the draft (`diffPackages` with the proposal as the after-state),
and a **Take it** / **Discard** pair. Nothing is written until the author takes it.

## Proven by

`bash scripts/authoring-check.sh` runs 23 checks in a temporary data directory and a temporary agent
root, with the model supplied so the run costs nothing:

- a sentence becomes a draft, and that draft validates clean;
- the draft lives under the data directory and never in an agent root;
- an empty draft takes two sources, both ingest, and the draft carries one provenance section per
  source with its commit;
- a save places the package, a second save of unchanged text returns the same hash, and the undo
  restores;
- a draft with no description is refused at save;
- an improvement returns a proposal and a diff without writing;
- drafts never appear as library skills.

## Not built

- Tag *editing* is done in the frontmatter itself; there is no chip editor yet, and the sidebar tag
  filter is the existing facet list.
- A draft cannot be deleted from the screen yet; the file goes when its folder is removed.

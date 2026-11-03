# Sources

A source is where skills come from. The screen is **Sources** in the top menu, and it does four
things to one source at a time: check it, map its skill folders, plan an update, apply it.

## Two kinds

| Kind | What the row holds | How it is read |
| --- | --- | --- |
| `github` | `owner/name` | GitHub API: latest commit, latest release, file trees, raw files |
| `local` | an absolute path to a checkout | git: `rev-parse HEAD`, `describe --tags`; files straight from disk |

Adding a local source requires the folder to exist and to contain `.git` — a directory, or a file in a
git worktree. The branch is read back so you know which one you are looking at. A folder without
`.git` answers `not-a-checkout` rather than being silently accepted.

## The four steps

1. **Check** records the commit (twelve characters) and the nearest tag for the source. The first
   check records silently; every later one that sees something new records an event, which is what
   the Events list at the bottom of the dialog shows.
2. **Map** takes a comma-separated list of paths inside the source — `skills/ask-matt,
   skills/other`. A path may be a single file or a whole skill folder.
3. **Plan update** reads the mapped paths and reports, per path, whether it is present and how many
   files it carries. It writes nothing. The plan also names the commit change since the last
   recorded check.
4. **Stage files** copies what the plan read into `DATA_DIR/staging/<source>-<commit>` and journals
   it. **Replace in library** writes each mapped folder to `LIBRARY_DIR/<name>`, moving any previous
   package to the trash first, indexing the new one, and journalling the replacement.

A plan consumes the delta it measures: it checks the source itself, so asking **Check** first and
then **Plan update** shows no commit change — the change was already recorded. That is deliberate;
the plan is the thing that reports a move.

## Proven by

`bash scripts/sources-check.sh` — 25 checks against a real temporary git repository: registration and
kind, branch, commit and tag read from git, mapping, a plan that reads the folder from disk and
counts its files, staging that leaves the library alone, a replace that writes the package and its
support file into the library, the package answering a search afterwards, the `source-replace`
journal entry, a second commit reported as a change with the previous commit named, the event, the
plan naming both commits, and both refusals (`that path does not exist`, `not-a-checkout`).

## Known limits

- A GitHub source still needs `GITHUB_TOKEN`/`GH_TOKEN` for a private repository; an unauthenticated
  public read works but is rate limited.
- Mapping is typed, not browsed: there is no tree picker yet.
- Replacement is per mapped folder and lands in the library. Placement into agent roots stays with
  the switches, as everywhere else.

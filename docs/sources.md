# Sources

A source is where skills come from. The screen is **Sources** in the top menu, and it does four
things to one source at a time: check it, map its skill folders, plan an update, apply it.

## Three kinds

| Kind | What the row holds | How it is read |
| --- | --- | --- |
| `github` | `owner/name` | GitHub API: latest commit, latest release, file trees, raw files |
| `local` | an absolute path to a checkout | git: `rev-parse HEAD`, `describe --tags`; files straight from disk |
| `zip` | an `http(s)` URL to a zip | the bytes themselves: the hash of the archive is the commit; the files come from the unpacked tree |

Adding a local source requires the folder to exist and to contain `.git` — a directory, or a file in a
git worktree. The branch is read back so you know which one you are looking at. A folder without
`.git` answers `not-a-checkout` rather than being silently accepted.

## A zip behind a URL

A zip source is added by its URL and **nothing is downloaded when it is added** — registering a
source should not depend on the URL being up at that moment. The download happens on **Check**, which
names the archive by the SHA-256 of its bytes, truncated to twelve characters, and keeps
`Last-Modified` as the release. So "the commit" means "these exact bytes": a URL that starts serving a
different archive reads as a change, even if it is not a repository at all.

The archive is unpacked once per commit into `DATA_DIR/sources/<id>/<commit>` and read from there, so
a plan confirmed later reads the tree the plan measured rather than whatever the URL serves now. A
typical archive wraps everything in one folder (`repo-main/`); the plan reads from inside that folder,
so a mapping is `skills/zip-skill`, not `repo-main/skills/zip-skill`. Entries that would land outside
the unpacked folder are skipped rather than followed.

Everything after Check is the same machinery a local checkout uses: map, plan, stage, replace.

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

## The local-edit guard

Every replace records a **baseline**: the hash of each file the source wrote, plus one digest over
the set. On the next replace the library copy is compared with that baseline.

- Identical — the copy is still what the source left, so the replace proceeds.
- Different — you edited it here. The request answers **409 `local-edit`** with the package, the file
  and what happened to it (`edited here`, `added here`, `removed here`), and **nothing is written**.
  The screen shows the card "The library copy changed here" with **Replace anyway** and **Keep my
  copy**. The refusal does not spend the plan, so **Replace anyway** works on the same plan.
- Forced — the bytes are overwritten, then a new baseline is recorded, so the guard is quiet next
  time.

The guard runs once over every mapped package *before* the first write: a half-replaced set is worse
than a refusal.

**A package with no baseline is not guarded.** That only affects a library written before baselines
existed; the first replace records one, and every replace after that is protected. This was observed,
not assumed: the probe library's `demo-skill` was replaced once without a guard, and the very next
edit was refused.

## Proven by

`bash scripts/sources-check.sh` — 34 checks against a real temporary git repository: registration and
kind, branch, commit and tag read from git, mapping, a plan that reads the folder from disk and
counts its files, staging that leaves the library alone, a replace that writes the package and its
support file into the library, the package answering a search afterwards, the `source-replace`
journal entry, a second commit reported as a change with the previous commit named, the event, the
plan naming both commits, and both refusals (`that path does not exist`, `not-a-checkout`). The nine zip checks cover registration without a download, a refusal for a non-URL,
the byte hash as the commit, mapping inside the archive, a plan that reads the unpacked tree, a replace
that lands both files and indexes the package, and a re-upload that reads as a change. The last nine cover the guard: an
edit in the library stops a replace with `local-edit`, the package and the changed file are named, the
edited copy and its text survive, forcing with the same plan is accepted and writes the upstream text,
and the following replace is quiet because the forced write became the baseline.

## Known limits

- A GitHub source still needs `GITHUB_TOKEN`/`GH_TOKEN` for a private repository; an unauthenticated
  public read works but is rate limited.
- Mapping is typed, not browsed: there is no tree picker yet.
- A zip source has no release of its own: `release` is the server's `Last-Modified` header, so it
  changes on every re-upload even when the content is identical. The commit hash is the reliable
  comparison.
- Only zip is accepted. A `.tar.gz` URL answers with a download error rather than being unpacked.
- Replacement is per mapped folder and lands in the library. Placement into agent roots stays with
  the switches, as everywhere else.

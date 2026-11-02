# Versioning monitor

A view that answers one question per installed repository: is my copy still what upstream has, and if not, exactly what changed before I accept it.

This is planned work, ahead of the implementation order. Nothing below is built yet except the primitives it reuses, which are named where relevant.

## 1. What the monitor is

Today a source is a repository under watch, and an installation is a skill fetched from a repository. The monitor joins the two into one record per installed skill, because a repository can hold forty skills and each one can be at a different commit.

Three questions it answers:

1. **Is upstream ahead?** New commits, new releases, new skills in the repository that were never installed, and skills that were installed and have since been removed upstream.
2. **What exactly changed?** Three diffs, at three levels: repository ref to ref, skill package file by file, and text line by line. Then the fourth diff that matters most, local copy against remote origin.
3. **Has my copy drifted?** Local edits since install, upstream edits since install, or both. Both is a conflict and needs a three-way view.

The record, not the repository, is the unit of truth. A repository is a container; an installation is a promise that a specific skill came from a specific commit.

## 2. Data model

New tables. Existing tables stay as they are, and `sources` keeps its role as the watch list.

```sql
installations (
  id, repo, remote_path, name,
  ref_kind,            -- commit | tag | branch
  ref,                 -- the resolved sha at install time
  tag,                 -- human label when ref_kind is tag
  installed_at,
  installed_hash,      -- sha256 of SKILL.md at install time
  package_hash,        -- sha256 of the whole package tree at install time
  library_path,
  version,             -- frontmatter version at install time, may be null
  pin_ref,             -- set when pinned, check still runs but update is refused
  policy_channel,      -- release | head | pinned
  policy_auto,         -- off | notify | apply-minor | apply-any
  created_at
)

installation_files (
  installation_id, path, blob_sha, bytes, hash
)  -- one row per file at install time, the baseline for every later diff

installation_agents (
  installation_id, agent, mode, target_path, placed_at
)

repo_snapshots (
  repo, ref, tree_sha, fetched_at, truncated,
  release_tag, release_name, release_at, prerelease
)  -- cheap cache so a check does not refetch an unchanged tree

monitor_events (
  id, installation_id, kind, from_ref, to_ref, summary, severity,
  seen_at, acknowledged
)
```

`installation_files` is what makes a diff honest without network calls. The blob SHAs captured at install time are the same identifiers GitHub returns for a later tree, so an unchanged file is proven unchanged by comparing two short strings. Content is only fetched for files whose blob changed.

Reused as-is: `placement` for links and junctions, `trash` for replaced copies, `journal` for reversibility, `safety` for the risk scan, `lockRows` for the lockfile, `checkSource` for commit and release lookup.

## 3. The check engine

A check is per repository, then fanned out to installations. One tree fetch serves every installation in that repository, which matters against a rate limit of 60 unauthenticated requests an hour.

Steps:

1. Resolve the repository: follow a rename or transfer, detect archive, detect deletion. All three are events, not exceptions.
2. Fetch the ref list once: default branch head, the newest release tag, and the last ten tags. Conditional request with ETag when the previous result is younger than the poll period.
3. Fetch the tree at each ref of interest, recursive. If the response reports `truncated: true`, fall back to the contents API per installation path, because a truncated tree silently hides files and a diff built on it would be wrong.
4. For each installation, walk its subtree in the new tree and compare against `installation_files` by path and blob SHA.
5. Classify: unchanged, changed, added, removed, moved (same blob SHA, new path).
6. Compute the package hash the same way the installer does, so "same bytes" means the same thing in both places.
7. Write `monitor_events` only when something is genuinely new. A check that finds nothing writes nothing, so a quiet repository stays quiet.

Classification rules:

| Situation | Kind | Severity |
| --- | --- | --- |
| New commit touching the installed subtree | `content-change` | attention |
| New release tag, subtree unchanged | `new-release` | info |
| New release tag, subtree changed | `new-release` and `content-change` | attention |
| Skill directory gone from upstream | `gone-upstream` | destructive |
| New skill directories in a repo we installed from | `new-skill` | info |
| Upstream version went backwards | `version-regression` | attention |
| Same version, different bytes | `silent-change` | attention |
| Local copy differs from install baseline | `local-drift` | attention |
| Local and upstream both changed | `conflict` | destructive |

`silent-change` reuses the same-version drift check that already exists for duplicate copies. A version number that did not move is not evidence that nothing changed, and that is exactly the case a user is most likely to accept blind.

## 4. The diff engine

Four comparisons, each with its own cost.

**Ref to ref.** GitHub's compare API between the installed sha and the chosen target. Gives commits, files, additions and deletions per file. Cheap, one request, good for the History tab. Falls back to a tree comparison when the compare API refuses (force-pushed history, unreachable commit).

**Package to package.** Built from `installation_files` and the new tree, no content download. Produces the file list with status, byte sizes, and a percentage of the package changed. This is what the Update button gates on.

**File to file.** Content fetched for changed blobs only, then a unified diff with line numbers. Rules:

- Text by extension list, plus a content sniff for the first 8 KB.
- Binary files report size, hash and a changed flag, never bytes.
- Files above 384 KB follow the existing scanner cap and report "too large to diff".
- CRLF and lone CR normalised for the diff, with a note when the only difference was line endings. A skill edited on Windows against a Linux repository would otherwise show every line as changed.
- Markdown diff can switch to rendered mode, which shows the two versions side by side rather than as text.

**Local against remote.** This is the one the user actually needs. Three inputs: the install baseline, the local library copy, and upstream now. Two comparisons:

- Local against baseline: did I edit this?
- Upstream against baseline: did they edit this?

Neither changed: up to date, say nothing. Only upstream: a clean update. Only local: warn that an update would discard local work, and offer to keep it. Both: a conflict, shown as a three-way view with per-section resolution for markdown and refuse-to-guess for everything else.

## 5. Update application

Updates reuse the install path, which already fetches into the library, moves the replaced copy to the trash and journals both halves. The monitor adds three things: a gate, a policy and a rollback.

**The gate.** A confirmed update requires the user to have seen the file list and the size of the change. Three thresholds force a second look: more than 20 files changed, more than 400 lines changed, or a version bump that is not backwards-compatible by semver rules. The gate is a confirmation, not a block, and it names the reason it appeared.

**The policy.** Per installation:

| Channel | Tracks | Use |
| --- | --- | --- |
| `release` | newest non-prerelease tag | default, stable |
| `head` | default branch | a repository that does not tag |
| `pinned` | nothing, checks only | a copy deliberately frozen |

Auto-apply is off by default. `apply-minor` allows an update when the version increases and the major number does not. `apply-any` allows everything the gate permits. Any auto-apply writes the same journal entry a manual update does, so undo works identically.

**The rollback.** The replaced copy is already in the trash for 30 days. The monitor shows "restore the previous version" on an updated installation, which is a trash restore plus a re-placement, not a new mechanism.

**Preserving local edits.** When only the local copy changed and the user still wants the upstream update, three options: keep local (skip the update), take upstream (local edits go to the trash, recoverable), or merge for markdown. Merge is deliberately narrow: frontmatter and body are diffed separately, and any conflicting hunk is written with both sides and a marker rather than a guess.

## 6. The screen

The top menu gains **View > Versioning**, and the dialog is the same width family as the install dialog. Three columns, matching the rest of the app.

Left, the repository list: one row per repository, with installations nested underneath. Each row carries the state that matters in six pixels of colour, not a sentence: up to date, behind, local drift, conflict, gone. A count on the right, `3 of 5 changed`. Grouping switch: by repository, by agent, by state, by pinned.

Middle, the installations in the selected repository: name, installed version, remote version when it differs, last check, pin state. Row switches mirror the main list so the muscle memory carries over.

Right, the detail pane with four tabs:

- **Overview**: refs, dates, hashes, placements per agent, provenance, policy.
- **Changes**: the file tree of the diff with status glyphs, and the text diff beside it. Side by side by default, unified on a switch. Per-line additions and removals in the existing signal colours, with a wrap toggle that remembers.
- **History**: releases and commits between the installed ref and now, newest first, each expandable to its own compare.
- **Policy**: channel, auto-apply, pin with a reason, and a "check now" button.

A ref picker in the header of Changes allows any two refs, not just installed against latest, because "diff its versions/commits" means arbitrary pairs.

Footer: check all, update selected, and the rate-limit position, since a power user will hit it.

## 7. Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/monitor` | repositories, installations, states, counts, last check |
| POST | `/api/monitor/check` | `{ repo?, installationId?, all? }`, returns a job id |
| GET | `/api/monitor/job/:id` | progress, cancellable |
| GET | `/api/monitor/:id/diff` | `?from=&to=&level=tree\|file&path=` |
| GET | `/api/monitor/:id/plan` | dry run: file list, thresholds hit, version change |
| POST | `/api/monitor/:id/update` | requires the plan id, applies through the install path |
| POST | `/api/monitor/:id/pin` | `{ ref, note }` or unpin |
| POST | `/api/monitor/:id/policy` | `{ channel, auto }` |
| GET | `/api/monitor/events` | unacknowledged, grouped by installation |
| POST | `/api/monitor/events/ack` | `{ ids }` |
| POST | `/api/monitor/:id/rollback` | restore the previous package from the trash |

Checks run as a queued job rather than inside a request, because a repository with 200 installations will exceed any sensible request timeout and the user should be able to cancel.

## 8. Power-user functions beyond the brief

These are the ones that decide whether the view is used a year from now.

1. **Ref picker, not just latest.** Diff any tag or any of the last fifty commits against the installed ref. Some users want to know what a specific release did, not what the branch does today.
2. **Pin with a reason.** Freeze an installation at a ref and record why. A pin without a reason becomes folklore; a pin with one survives staff turnover.
3. **Silent-change detection.** Same version, different bytes, flagged. This is the most valuable single check in the whole view and the easiest to omit.
4. **Version regression detection.** Upstream tags 1.2.0 after 1.3.0. Happens after a bad merge, and installing it silently is a downgrade.
5. **Move tracking.** A skill renumbered from `skills/foo` to `skills/git/foo`. Matched by blob SHA so it is a move, not a deletion plus an addition.
6. **Repository rename and transfer following.** GitHub answers a redirect for a transfer and a 404 for a rename by URL. The monitor records the new canonical name and keeps history, rather than treating it as deleted.
7. **Upstream removal handling.** The skill is gone from upstream. Do not delete locally; keep it, mark it orphaned, and stop offering updates.
8. **New skills in a watched repository.** The repository grew two skills since the last check, offered as an install, which is the discovery path for repositories that keep growing.
9. **Local-modification ledger.** Per file, not per package: which files I edited, which upstream edited. A package-level answer is useless when one references file changed on each side.
10. **Risk delta.** Run the existing content scanner on the upstream package before offering the update. A package that was clean and is now medium is a different decision from a markdown typo fix.
11. **Cost and rate-limit awareness.** Requests per check, remaining budget, reset time, and conditional requests so an unchanged repository costs zero. A monitor that gets the user rate-limited once will be abandoned.
12. **Digest, not a storm.** One collated notification per period, with counts and the three most interesting changes, instead of one per skill.
13. **Lockfile interop.** Every installation is a lockfile entry, so CI can assert the same set on another machine, and the monitor can show a machine that has drifted from the lock.
14. **Export.** The whole monitor state as NDJSON, for the user's own DR repository and for diffing two machines.
15. **Duplicate-content detection.** Two installations of the same bytes from different repositories, shown as one package with two origins, so curation has the truth.
16. **Per-skill ignore.** Ignore future commits touching `scripts/` for a skill I only use for its markdown, so the signal stays about what I care about.
17. **Bulk selection and bulk update.** The same selection mode and header switches as the main list, because checking forty installations one at a time is not a workflow.
18. **Offline state.** Every row keeps its last known result with the timestamp, so the view is useful on a plane rather than showing an error page.
19. **Deterministic compare for case-insensitive filesystems.** Two files differing only by case collide on Windows; the diff reports it instead of silently merging.
20. **Install provenance in the package.** The `.skill-academy.json` manifest gains the ref and the repository URL, so a skill on disk can always answer where it came from without the app.

## 9. Edge cases that must be decided in code, not at runtime

| Case | Behaviour |
| --- | --- |
| Installed commit no longer reachable (force push) | Compare against the tree of the nearest known ref, mark the baseline as lost, require a full-file diff |
| Repository deleted or made private | Keep the last snapshot, mark unreachable, stop offering updates, keep the skill |
| Repository archived upstream | Info event once, checks continue |
| No frontmatter version | Version column shows a dash, comparisons fall back to blob hashes |
| Non-semver version string | Never auto-apply, always gate |
| Release with no tag | Read releases only for display, never as a channel target |
| Prerelease or draft release | Never a channel target unless the user opts in per repository |
| Multiple skills in a repository | One installation per path, one tree fetch per check |
| Skill nested deeper than the scan depth | Installer records the exact path, so depth is not a factor for updates |
| Submodule or LFS pointer in a package | Detect the pointer signature, report "external content", refuse to fetch |
| Tree response truncated | Fall back to per-path contents requests, never diff a partial tree |
| Binary asset changed | Size and hash only, no bytes |
| Line endings only | Report as normalized, do not claim a content change |
| Symlink inside a package | Record the target, never follow it, warn on Windows |
| Empty upstream directory | Treat as removal, not as an empty skill |
| Case-insensitive collision | Report both paths, refuse to apply until resolved |
| 60 requests an hour unauthenticated | Queue with backoff, surface the reset time, prefer one tree fetch per repository |

## 10. Stages

| Stage | Work | Days |
| --- | --- | --- |
| V0 | Tables, backfill from existing installs, provenance in the manifest | 1 |
| V1 | Check engine: refs, tree compare, classification, events, job queue | 3 |
| V2 | Monitor list and overview, grouping, states | 2 |
| V3 | Diff viewer: file tree, text diff with line numbers, markdown rendered mode, ref picker | 3 |
| V4 | Update plan, thresholds, apply through the install path, rollback | 2 |
| V5 | Policy, pin, channels, three-way local merge | 2 |
| V6 | Digest, acknowledgement, bulk, export, lockfile interop | 2 |
| V7 | Hardening: rate limits, renames, truncation, case collisions, offline | 2 |
| | **Total** | **17** |

Seventeen days added to the plan time rather than absorbed, because a monitor that mostly works is worse than none: a missed change teaches the user to trust a blank screen.

## 11. Decisions needed before V1

1. Is the default channel `release` with a fallback to `head` when a repository has no tags, or `head` for everything? I recommend release-first, because a tag is a promise.
2. Should auto-apply be available at all in the first release, or gated behind a setting that starts off? I recommend the setting, default off.
3. Does an update overwrite local edits by default, with the old copy in the trash, or refuse until the user chooses? I recommend refuse-and-offer, since a silently discarded edit is the fastest way to lose trust.
4. Should the monitor list repositories with zero installations, meaning a watch list entry only? I recommend yes, marked as watched, because that is how a user evaluates a repository before installing.
5. Is the digest a desktop notification, an in-app badge, or both? I recommend the badge first, since a notification system is its own project.

## 12. Interaction with the rest of the plan

The monitor sits between P3 and P4. It consumes the source registry and the update plan gate, and it produces the provenance data that P4's compare panel and P6's curation both need. Building it before the provider layer means the LLM passes later get a trustworthy "what changed" input instead of reimplementing diffing for a second time.

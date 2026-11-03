# Linked sources (P5)

A composite skill keeps absorbing knowledge from remote skills. One record per link, one dry run per
ingest, one snapshot per write, and a restore that returns the bytes the run started from.

Verified with `bash scripts/links-check.sh` — 30 checks, two real repositories
(`mattpocock/skills`, `obra/superpowers`), a temporary agent root and a temporary library:

```
PASS the placeholder skill is indexed            1 row
PASS a link to the first repository is created   mattpocock/skills
PASS a link to the second repository is created  obra/superpowers
PASS the same source twice is refused            duplicate-link
PASS the skill is now composite
PASS a link resolves its head before any ingest
PASS attach plans without a model
PASS attach lists the knowledge files            ['SKILL.md']
PASS attach applies
PASS the upstream files are copied verbatim
PASS the body gains one labelled section
PASS the manifest names the commit
PASS a second ingest on an unchanged link is refused   no-change
PASS the refused run wrote nothing
PASS distill answers with a proposal
PASS distill was a bootstrap
PASS distill found rules to add
PASS distill applies
PASS the distilled section is labelled with its repository and commit
PASS the reference file carries the commit
PASS a supplied answer becomes a dry run
PASS the conflict is reported
PASS the run applies with the conflict recorded
PASS the local rule survives a contradiction
PASS the upstream wording was not written into the body
PASS undo answers
PASS undo returns the hash the run started from
PASS the distilled section is gone after undo
PASS consolidation never proposes a composite
PASS the file paths and the run rows are consistent
```

## Shape

| Part | Where | Rule it follows |
| --- | --- | --- |
| `skill_links` | `server/src/links.ts` | one row per target, repository and path; the same source twice is a 409, not a second row |
| `ingest_runs` | same file | a run is a record of a dry run and of an apply, with tokens, counts, snapshot and proposal |
| Change detection | `remoteHead()` + `compareFiles()` | a link is compared with its own last ingested commit, never with the repository head |
| Bootstrap vs delta | `planIngest()` | no ingested commit means the whole upstream skill is read; after that only the delta |
| Knowledge selection | `knowledgeFiles()` | markdown and text inside the linked skill, 256 KB per file, 60,000 characters per run; scripts only when `includeCode` is asked for |
| Modes | `distill`, `attach`, `summarize` | attach copies files and asks no model; summarize writes a digest and one pointer line; distill writes rules |
| Deduplication | `planIngest()` | a rule the target already states, or another link already taught, is dropped and reported |
| Conflicts | proposal + apply | the local rule stays, both texts and the upstream commit are reported, the model may not pick a side |
| Body budget | `applyIngest()` | past 24,000 characters the rules go to `references/ingested/<slug>.md` and the body keeps one pointer |
| Snapshot | `applyIngest()` | `~/.skill-academy/snapshots/ingest/<runId>/`, written before the first byte changes |
| Guards | `applyIngest()` | the run must still be dry, the confirmation is explicit, and the package hash must match the one the dry run was computed against |
| Undo | `undoIngest()` | restores the snapshot, checks the hash equals the pre-run hash, moves the link back to its previous commit |
| Protection | `compositeTargets()` | the curator and the consolidation pass never propose a linked skill for a merge |

## Three defects this build surfaced

- **A conditional tree fetch returned no files.** `fetchTree()` answered `304` and handed back an
  empty list, so every unchanged repository looked wiped. The tree body is now cached in
  `repo_snapshots.files` and returned with the etag; a database without the column gets it added in
  place, and a cache with no body asks once without the conditional header.
- **A reasoning model spent the whole output budget and answered nothing.** The first distill run
  came back with `chars: 0, outTokens: 3000` — exactly the cap. `askModel()` now notices an empty or
  stub answer sitting on the cap and retries with a doubled budget, up to 16,000.
- **The attach path wrote a manifest into a directory that did not exist yet.** The copy loop created
  the folder; the manifest write did not. It does now.

## Deferred, and why

- **Local git sources.** Links resolve through the GitHub API only. A local repository needs the diff
  and blob reads moved to `git`, which is the same work the versioning monitor will need for local
  sources; it is not built twice here.
- **Drafts as targets.** Every column and guard is shaped for it, and `skill_links` keeps the
  `skill_id` nullable, but a draft target arrives with P6 because drafts do not exist yet.
- **A queue per skill.** A second run for the same target is currently refused by the hash guard
  rather than queued. Nothing runs concurrently today, so the lock has no work to do.
- **Cost estimate before a run.** Tokens are recorded after the fact. A pre-run estimate needs the
  provider catalogue priced per model, which the provider screen does not carry yet.

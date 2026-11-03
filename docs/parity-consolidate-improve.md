# Where Improve and Consolidate match Hermes

Hermes owns two procedures over its own skills: `skill-curation` reviews the library after a
session, `skill-consolidation` merges duplicates and rewires references. Improve and Consolidate in
this app implement those procedures rather than an interpretation of them.

Every row below names the requirement, the code that carries it, and the fixture check that proves
it. `npm run fixtures` runs the checks against a temporary skill tree; nothing in the live agent
libraries is touched.

## Consolidation

| Requirement (`skill-consolidation`) | Implementation | Proof |
| --- | --- | --- |
| Read all bodies end to end before writing | `POST /api/consolidate/fold/apply` refuses without `read: true`, then `confirm: true` (428 twice) | `the pointer applies`, `a clean fold applies` |
| Never merge on descriptions or blob similarity alone | a description-only match is `weak-evidence` with `plan: null` | `improve reports no family problems on clean fixtures` |
| Near-duplicate → survivor keeps name and version, loser becomes a pointer | `pointerText()` | `an identical copy is pointerized`, `the loser became a pointer` |
| Partial overlap → canonical untouched, other body becomes a router | `routerText()` | `the subtraction chooses a router, not a pointer` |
| Router keeps every unique section under its own heading | `sectionsOf` minus the survivor's headings | `the router keeps its unique lane` |
| Router keeps the References table of its own support files | the section is copied from the body, emitted once | `the router keeps its own support-file table`, `the router invents no placeholder table` |
| Router points at the canonical first | the pointer block is the first line of the body | `the router points at the canonical first` |
| Every rewritten body is version-bumped | `bumpVersion()` on the frontmatter | `the router bumps its version` (2.3.1 → 2.3.2) |
| Intentional family (router + children) is left alone | `intentional-family` carries `plan: null` | group summary in `/api/consolidate/dry-run` |
| The same name in several agent roots is distribution, not duplication | `cross-root-placement`, `plan: null`, blocked reason stated | live library: 55 of 65 groups carry `liveRoot` |
| A shared section shape is not shared content | `shape-only` below ~half the rules in common | `the router pair forms one group` (heading floor respected) |
| Pointerising a body with a unique section is refused | `would-drop-content` (409) names the sections | `would-drop-content` path in `consolidateApply.ts` |
| Model-written fold is audited against its sources | every substantive line must survive; invented lines listed | `the fold audit counts every line` (9/9) |
| One dropped line makes the merge lossy and it is refused | `lossy-merge` (409) with counts and a sample | `a lossy fold is refused with its counts` |
| A router is audited against the body it replaces, not both | `routerMode` audits `routerSource` alone | `mode: router` in the fold response |
| What was read is what is written | `fold/apply` accepts the `text` the panel displayed and audits that | `a clean fold applies` |
| Replaced bodies are archived before the write | `archiveFile()` into `~/.skill-academy/consolidation-trash` | `the replaced body is archived exactly` |
| A restore writes the body that belongs there | `undoConsolidation()` compares the archived `name:` with the target | `a restore refuses another skill's archive` |
| Sweep rewrites only quoted names, `related_skills` entries and Related bullets | `sweep.ts` | `rewire` counts in the apply response |
| `.usage.json` names are provenance and stay | skip list in `sweep.ts` | apply response |
| Own `references/` and `scripts/` targets must exist | close-out check, scoped to the touched skills | `dangling` in the apply response |
| Exercise merges on fixtures, never the live library | `SKILL_ACADEMY_ONLY_ROOTS`, own data dir, free port, readiness by record count | every check in `scripts/fixture-check.sh` |
| A live root refuses a write without an explicit opt-in | `insideProtected()` → 403 `protected-root` | live library answers 403 on `~/.hermes/skills` |
| Every touched skill loads afterwards, frontmatter valid, name matches its directory | `closeOut()` re-parses each rewritten package | `every touched skill still loads afterwards`, `the router still loads afterwards` |

## Curation

Improve copies the rule ids from `skill-curation` and `family-audit.py` verbatim: category-mismatch,
unexpected-unfiled, multi-family, undocumented-family, empty-family, member-drift,
description-over-budget, description-no-period, stub-body, name-drift, dormant-tags, shadow-category,
ambiguous-name. Description style rules are `info`, because they are a new-skill rule rather than a
defect in an existing one.

| Requirement | Proof |
| --- | --- |
| A short body is a defect | `improve finds the stub body` |
| A description past the budget is reported | `improve flags the long description` |
| A description without a period is reported | `improve flags the missing period` |
| A clean fixture produces no family findings | `improve reports no family problems on clean fixtures` |

## What is not proven here

- A live merge on a working skill beyond the one authorised `speckit-plan` run, which was applied
  and restored byte for byte.
- Provider parity: Anthropic and key-based xAI have no credential on this machine, so only the wire
  path is proven for them.

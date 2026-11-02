# Triage

Every capability from the competitive audit, plus everything already planned, classified. This document supersedes the phase table in [competitive-gaps.md](competitive-gaps.md) where the two disagree; the audit records what peers do, this records what we ship.

## How a feature earns a place

Four gates, in order:

1. **Harm.** Does leaving it out risk data loss, a security problem, or work that cannot be undone? Scanning, journals, snapshots and hash guards clear this gate and are never deferred.
2. **Daily friction.** Does its absence cost a minute every day? Toggling, filtering, updating, and seeing what a skill costs all qualify.
3. **Table stakes at low cost.** Two days or less for something every peer has. A lockfile and a health view are this.
4. **Fit.** It must not require becoming a different product. A registry server, an agent runtime, a team platform and a marketplace all fail here regardless of how popular they are.

A feature that clears none of these goes to the backlog with a trigger, or is rejected with the condition that would change the verdict.

## Triage

`v1` ships in the 61-day plan. `v1.1`/`v1.2` are dated later. `Reject` means we are not building it, and the last column says what would change that.

### Already committed

| Capability | Verdict | Where | Why |
|---|---|---|---|
| Multi-agent root discovery | v1 | P0-P1 | The product does not exist without it |
| Per-agent enable/disable | v1 | P2 | The core interaction |
| Linked / native / shadow placements | v1 | P2 | Disabling must match how the package was installed |
| Update detection per skill | v1 | P3 | Per-repo notifications are noise |
| Scheduled auto-update | v1 | P3 | The reason to monitor a source at all |
| Configurable archive destinations | v1 | P2 | A hidden `.archive` next to the skill is not a backup |
| Undo journal and drift repair | v1 | P2 | Every switch must be reversible |
| LLM curation and consolidation | v1 | P4 | The differentiator against every desktop manager |
| Composite linking with provenance | v1 | P5 | One skill, many upstreams, traceable back to commits |
| Authoring: LLM draft + editor | v1 | P6 | Creating skills is half the job |
| Cloud sync over git | v1 | P7 | Two machines, one library |
| Twelve themes | v1 | P8 | Cheap once the token contract exists |

### Added by the audit

| Capability | Verdict | Where | Days | Why |
|---|---|---|---|---|
| Content scan and enable gate | **v1** | P2 | 3 | We ingest untrusted repos and auto-update them. This is the one gap that is negligent, not merely behind |
| Behaviour tags from scanning | **v1** | P2 | 0 | Folded into the scan: `remote-code`, `network`, `privilege`, `filesystem` are cheaper and more honest than a risk score alone |
| Lockfile | **v1** | P3 | 2 | A journal records history; a lock records what another machine must reproduce |
| Token and context cost | **v1** | P1 | 2 | Nobody measures the enabled set across every agent. It is our best differentiator and it is cheap |
| Health view | **v1** | P1 | 1 | The checks already exist inside a curation report nobody opens |
| skills.sh discovery | **v1** | P3 | 2 | We already parsed its registry. Search and install, no marketplace |
| Tags with frontmatter write-back | **v1** | P6 | 1 | Ecosystem-native, versioned with the package, and the cheapest filter axis |

### Backlog, with a trigger

| Capability | Verdict | Trigger to promote | Days |
|---|---|---|---|
| MCP surface | v1.1, first | As soon as the API is stable; agents are the more likely caller than scripts | 3 |
| CLI (`ska`) | v1.1 | After MCP, or the first time a dotfiles script or SSH session needs it | 3 |
| Publish / pack / export | v1.1 | The first time a skill needs to leave this machine for someone else | 2 |
| Semantic resolve | v1.2 | Two weeks where the lexical filter visibly fails, or the library passes 3,000 skills | 3 |
| Usage import from agent transcripts | v1.2 | After v1, when there is a real question that usage would answer. Read-only, never drives aging | 3 |
| Quality lint (trigger clarity, duplicate triggers, description windows) | v1.2 | After Health has been used for a month and the structural problems are gone | 2 |

### Rejected

| Capability | Why not | What would change it |
|---|---|---|
| Run a skill without installing | Executing agent instructions is an agent run, not a file operation, and it turns a manager into a runtime | Never, in this product |
| Team RBAC, org registry, review queues | A server to run and secure for one person on two machines | A second person sharing the library as a peer, not as a guest |
| Session traces and execution reports | We cannot observe agent runs, and inventing telemetry is worse than having none | An agent that publishes a usage log we can read honestly |
| Local patch format across updates | Ours refuses the update on a local edit and offers a three-way diff; a patch model adds a merge format for a case the guard already covers | The diff-and-take-upstream flow proving painful in daily use |
| Marketplace hosting, ratings, reviews | Community features need a community; we have one user | Publishing skills for other people to install |
| Desktop app, TUI, IDE extensions | The web app plus one service is the whole surface budget | A workflow that genuinely cannot live in a browser tab |
| Accounts and sign-in | Nothing to authenticate against; keys live in the OS keychain | Sync moving to a hosted service, which it will not |
| Dependency resolution between skills | No peer does it well, and the format has no dependency field worth honouring | The spec gaining a real dependency contract |

## The v1 line

61 working days, cut into four milestones so value lands early.

| Milestone | Phases | Days | What exists after it |
|---|---|---|---|
| M1 — Inventory and control | P0, P1, P2 | 19 | Every skill found, listed, filtered, switched per agent, scanned, costed, archived to any drive, every action reversible |
| M2 — Sources | P3 | 9 | Repos and skills.sh watched, changes notified, updates applied with a guard, a lockfile that reproduces the library |
| M3 — Intelligence | P4, P5, P6 | 22 | Curation, composite linking and ingest, authoring |
| M4 — Continuity | P7, P8 | 11 | Git sync between machines, themes, onboarding, accessibility, copy |

M1 is the point where the app replaces "walking 66 directories". That is 19 days, not 61, and it is worth shipping before the rest exists.

## What this deliberately does not do

It does not become a registry, a runtime, a marketplace, or a team platform. Every one of those is a different product with its own server, identity and support burden. The bet is that one person with many agents needs a **control plane for their own machine**, and no peer has built that: SkillHub governs other people's skills, the desktop managers sync folders, the CLIs install. None of them measure, scan, compose and back up the library as one thing.

## Change from the audit

The audit suggested CLI first, then MCP. Reversed: agents are the likelier caller on this machine, and an agent asking "enable the PDF skill for Cursor" is worth more than a shell wrapper. Both stay at three days.

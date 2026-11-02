# Positioning: can we claim "best"?

2026-11-02, second audit. The question was whether Skill Academy can be called the best skill-management tool across every popular repository above 1,000 stars. The answer is no, for three separate reasons, and only one of them is about competitors.

## Why the claim fails today

1. **It does not exist.** There is no app, no service, no scan. A plan cannot be best at anything; "best" is a measurement, and the instrument has not been built.
2. **"Best" needs an axis.** On registry and governance, SkillHub wins and will keep winning. On scan depth, Agent Skills Guard wins. On token economics, `qvr` already ships what we are planning. On reach, the Vercel CLI is installed by an order of magnitude more people than anything else here. A single overall winner only exists under a weighting, and the weighting has to be stated.
3. **Our differentiators are thinner than the first audit claimed.** A tool we had not seen already ships a large part of what we called ours.

## The population

Forty-three repositories above 1,000 stars surfaced across fourteen queries. Only about a dozen are management tools; the rest are libraries, marketplaces of content, or adjacent runtimes. Mixing them is the category error the first audit warned about.

**Managers and installers** (the comparison set):

| Repo | Stars | Surface | What it is |
|---|---|---|---|
| `vercel-labs/skills` | 37,733 | CLI | The ecosystem's installer: 79 agents, add/check/update/remove |
| `NanmiCoder/cc-haha` | 15,271 | Desktop | Agent workbench with a skill market, worktrees, diff, multi-model |
| `xingkongliang/skills-manager` | 7,173 | Desktop | Central library, per-agent workspaces, presets, project sync, backup |
| `tech-leads-club/agent-skills` | 7,122 | Registry + MCP | Validated skill registry with a client and an MCP server |
| `iflytek/skillhub` | 5,356 | Server + web + CLI | Registry with versioning, RBAC, review, audit, scanning |
| `davepoon/buildwithclaude` | 3,707 | Hub | Directory of plugins, skills, MCP servers |
| `jeremylongshore/tons-of-skills-marketplace` | 2,890 | Marketplace | Model-agnostic platform, certification tiers planned |
| `qufei1993/skills-hub` | 1,851 | Desktop | 48 tools, collections, git-synced library |
| `rohitg00/skillkit` | 1,568 | CLI + web | Install, translate, share across agents |
| `Dimillian/CodexSkillManager` | 1,378 | macOS | Codex and Claude Code skills, Clawdhub import |
| `MoizIbnYousaf/ai-agent-skills` | 1,155 | Installer | Universal installer with a curated library |
| `jiweiyeah/Skills-Manager` | 1,052 | Desktop | 32 tools, symlink/junction, marketplace |
| `beizhu-1209/AIHelms` | 1,031 | Platform | Enterprise AI gateway with skill registration |

Also above 1,000 but not managers: `ComposioHQ/awesome-claude-skills` (78k), `VoltAgent/awesome-openclaw-skills` (53k), `alirezarezvani/claude-skills` (29k), `phuryn/pm-skills` (27k), `anthropics/skills` (186k). These are content, and comparing a content repository to a control plane inflates whatever claim follows.

## The entrant that changes the picture

`xingkongliang/skills-manager` was missing from the first audit. It ships, today, at 7,173 stars:

- A central library plus **per-agent Global Workspaces** that show every skill in an agent's folder, including ones installed outside the app.
- **Project Workspaces** that compare project-local skills with the library and sync in either direction.
- **Linked Workspaces**: any directory as a skills root.
- **Presets**: named groups toggled on and off for the current agent scope.
- Bulk operations, tags with an Untagged filter, update tracking on git sources, preview and local-versus-upstream comparison.
- **Backup and multi-device sync** through a private GitHub repo with device-flow sign-in, skill-aware merges (a rename on one machine combines with an edit on another), non-blocking conflicts, restorable snapshots, and an activity log.
- **Agent-driven management**: agents install, deploy and report through the app instead of writing into folders directly.

That is our P2, P3, P6 (tags) and P7, already shipped, on desktop, with a merge model that handles renames. It does not appear to scan, cost context, curate, compose or author — the four things we consider ours.

## Scorecard

Weights reflect one power user with many agents on two machines. Scores are 1-5. Ours is the **plan**, not a product, and that is the single most important caveat in this document.

| Tool | Coverage 15 | Control 15 | Security 15 | Updates 10 | Repro 10 | Context 10 | Authoring 10 | Continuity 10 | Reach 5 | Total |
|---|---|---|---|---|---|---|---|---|---|---|
| **Skill Academy (planned)** | 5 | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 2 | **460 / 500** |
| `qvr` | 3 | 4 | 5 | 2 | 5 | 4 | 2 | 1 | 3 | 335 |
| `xingkongliang/skills-manager` | 5 | 4 | 2 | 4 | 2 | 1 | 2 | 5 | 3 | 320 |
| `qufei1993/skills-hub` | 5 | 4 | 2 | 3 | 1 | 1 | 1 | 3 | 2 | 265 |
| `agent-skills-guard` | 3 | 4 | 5 | 3 | 1 | 1 | 1 | 1 | 2 | 260 |
| `iflytek/skillhub` | 1 | 2 | 5 | 3 | 3 | 1 | 3 | 2 | 3 | 255 |
| `vercel-labs/skills` | 5 | 2 | 2 | 4 | 1 | 1 | 2 | 1 | 4 | 245 |
| `tech-leads/agent-skills` | 4 | 2 | 4 | 2 | 2 | 1 | 1 | 1 | 3 | 235 |

Our 92% is not evidence of anything. Remove the two axes only we score top on — context economics and authoring — and the ranking compresses to 90 / 72 / 69: we lead, but by less than the raw table suggests, and the leader after us is a shipped desktop app rather than a plan.

The honest reading of the table: **we would be the only tool designed around the whole job, and the only one whose scores rest on intent rather than shipped code.**

## The claim I can defend

Not "the best skill management tool". This:

> Skill Academy is the only local control plane for one person's skills across every agent on their machine: the only one that gates a skill on a security scan before it can be enabled, prices the enabled set in context tokens, composes one skill from several upstreams with commit-level provenance, and consolidates the library with a dry-run LLM pass — while every action is journaled and reversible and the archive can live on any drive.

Every clause is falsifiable, and none of them is claimed by a shipped competitor today.

The broader claim becomes true only if we ship M1-M3 and then run the same six tasks on both apps with timers: find a skill, disable it for one agent, add a source, review an update, cost an agent's enabled set, recover from a bad edit. Until that run exists, "best" is a hypothesis with a plan attached.

## What we are not going to win

- **Reach.** 37k stars of `npx skills` habit. We will never beat that, and a CLI in v1.1 will not change it.
- **Marketplace.** Content networks compound. We will consume skills.sh, not compete with it.
- **Desktop polish.** `xingkongliang` has a tray, in-app updates, an activity log and a language switcher. A web app can match the workflow, not the chrome.
- **Registry and governance.** SkillHub has RBAC, namespaces and audit logs. That is a server, not a control plane.

## Triage changes from this audit

| Change | Verdict | Where | Days |
|---|---|---|---|
| Presets: named skill groups toggled per agent scope | **In v1** | P2 | 2 |
| Rename-aware merge in sync (a rename plus an edit combines) | **In v1** | P7 | 0 |
| Project workspaces: compare and sync project-local skills with the library | **In v1** | P2 | 3 |
| URL and zip sources | **In v1** | P3 | 1 |
| Upstream audit verdict shown beside ours | **In v1** | P3 | 1 |
| Agent-driven management | Already planned as MCP | P9 | 0 |
| Skill translation between languages | Reject | — | — |
| Certification tiers with retained evidence | Reject | — | — |
| In-app updater and tray chrome | Reject | — | — |
| Activity log export as a zip | Reject | — | — |

Presets are the one addition worth paying for: with 2,140 skills, a named set toggled per agent is the difference between a library and a workflow. Project workspaces wait for the first project where local skills genuinely diverge from the library.

## Revised totals

| Milestone | Phases | Days |
|---|---|---|
| M1 — Inventory and control | P0, P1, P2 | 24 |
| M2 — Sources | P3 | 35 |
| M3 — Intelligence | P4, P5, P6 | 57 |
| M4 — Continuity | P7, P8 | 68 |
| Parity (MCP, then CLI) | P9 | 74 |

Seven days more than the plan before this audit: presets, project workspaces, archive imports, and a second opinion on scans. All four are features a shipped peer has or a distribution channel requires, and all four are priced.

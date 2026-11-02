# Competitive audit and gap list

2026-11-02. Fifteen skill-management tools read from their own documentation; star counts and languages pulled from the GitHub API the same day. Claims are marked as documented unless this audit verified them in source or a live run — SkillHub and the Vercel CLI are the two that were opened up.

Inclusion decisions and milestone cuts live in [triage.md](triage.md); where the two disagree about sequencing, triage wins.

The point of this document is not to copy features. It is to find the places where our narrow scope leaves a real hole, and to say which holes are worth filling.

## The field

| Tool | Stars | Surface | Lang | What it actually owns |
|---|---|---|---|---|
| `vercel-labs/skills` | 37,733 | CLI | TS | The ecosystem's install path: 79 agents, add/find/list/check/update/remove, symlink or copy, npm-packaged skill sync |
| `iflytek/skillhub` | 5,356 | Server + web + CLI | Java | Registry with versioning, namespaces, RBAC, review, audit log, Cisco-backed scanning |
| `qufei1993/skills-hub` | 1,851 | Desktop | Rust | 48 tools, collections, git-synced library, bulk enable/disable, AI management |
| `jiweiyeah/Skills-Manager` | 1,052 | Desktop + `skm` | TS | 32 tools, symlink/junction fallback, marketplace, AI translation |
| `bruc3van/agent-skills-guard` | 392 | Desktop | Rust | Security scanning as the product: 8+ risk classes, install/update/uninstall, batch sync |
| `alvinunreal/lazyskills` | 333 | TUI | Go | Cross-agent visibility, preview, doctor, restore from lock files |
| `skilld-dev/skilld` | 329 | CLI + web | Rust | Registry with run-without-install, watch, provenance commit, capability tags |
| `nextlevelbuilder/skillx` | 195 | Web + CLI | TS | Marketplace with semantic search, ratings, publish/pack, MCP server, lockfile |
| `eljulians/skillfile` | 178 | CLI | Rust | Declarative Skillfile + lockfile, local patches preserved through updates, team deploys |
| `luochang212/skill-zoo` | 124 | CLI + WUI | TS | Built-in authoring editor, community audit scores, consistency checks, archive |
| `lasoons/AgentSkillsManager` | 91 | VS Code | TS | Browse and install skill repos across many IDEs |
| `ComeOnOliver/skillshub` | 65 | API + web | Python | A resolver API: describe a task, get one skill, token-efficient by design |
| `lcy362/flint` | 38 | Local app | TS | Tags that migrate back into frontmatter, library, health, data sovereignty |
| `try-agora/qvr` | 25 | CLI | Go | Lockfile, scan-before-install, token share per skill, session traces, CI policy |
| `yen0304/Skill-Dock` | 18 | VS Code | TS | Local-first manager with import |

Two observations before the matrix. The category is **CLI-first**: eleven of fifteen ship a CLI, and the four desktop tools are wrappers around the same operations. And **nobody does the whole job** — the biggest tools are strong in one lane and thin in the others, which is why they are not interchangeable.

## Capability matrix

`●` documented and central, `◐` partial or secondary, `·` absent.

| Capability | vercel | skillhub | skills-hub | SkillsMgr | guard | lazyskills | skilld | skillx | skillfile | qvr | zoo | **us** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Multi-agent root discovery | ● | ◐ | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| Per-agent enable/disable | ◐ | · | ● | ● | ◐ | ◐ | ◐ | · | ◐ | ● | ◐ | ● |
| Symlink/copy install modes | ● | · | ◐ | ● | ◐ | · | ● | ● | ● | ● | ◐ | ● |
| Update detect + apply | ● | ● | ● | ● | ● | · | ● | ● | ● | ◐ | ● | ● |
| Lockfile / reproducible | · | ◐ | · | · | · | ◐ | ● | ● | ● | ● | · | ◐ |
| Registry/marketplace discovery | ● | ● | ● | ● | ● | · | ● | ● | ◐ | · | ◐ | · |
| Semantic search | · | · | · | · | · | · | ● | ● | ◐ | · | · | · |
| Content security scan | ◐ | ● | · | · | ● | · | ● | ● | · | ● | ● | · |
| Authoring / editor | ◐ | ◐ | · | ◐ | · | · | · | ◐ | · | · | ● | ● |
| Tags / metadata write-back | · | ● | ● | ● | · | · | ● | ● | ● | · | ◐ | · |
| Token / context accounting | · | · | · | · | · | ◐ | ◐ | · | · | ● | ◐ | · |
| Usage analytics | ◐ | ● | · | · | · | · | ● | ● | · | ● | · | · |
| Team / org governance | · | ● | ◐ | · | · | · | · | ◐ | ● | ● | · | · |
| Publish / distribute | ● | ● | ◐ | ● | · | · | ● | ● | ◐ | · | ◐ | · |
| MCP surface | · | ◐ | · | · | · | · | · | ● | · | · | · | · |
| Run without installing | ◐ | · | · | · | · | · | ● | ◐ | · | ◐ | · | · |
| Health / consistency checks | ◐ | ◐ | · | · | ● | ● | ◐ | ◐ | · | ◐ | ● | ◐ |
| Cloud sync / backup | · | · | ● | · | · | · | · | · | ● | · | · | ● |
| Configurable archive location | · | ◐ | · | · | ◐ | · | · | · | · | · | ● | ● |
| LLM curation / consolidation | · | · | · | ◐ | · | · | · | ◐ | · | · | ◐ | ● |

## The gaps that matter

Each entry names the best peer evidence, why it bites us specifically, and a verdict. Cost is working days.

### G1. Content security scanning — **in scope, P2**
`agent-skills-guard` builds the product on it (8+ risk classes, multi-step chains, unicode deception, cross-skill attacks). `qvr` scans before an install lands. `skillhub` runs Cisco's scanner post-publish with a severity threshold that blocks release. `skill-zoo` surfaces community audit scores; `skillx` has a `vet` command.

We plan to ingest arbitrary repositories, auto-update them on a schedule, and sync them between machines. A secrets scan on push is not enough: prompt injection, destructive shell commands, silent network calls and hidden unicode are exactly what a skill can carry. Best fit is an adapter to `skill-scanner` (the same tool SkillHub uses) plus our own static rules for the obvious cases, with a per-skill risk badge, a block-on-severity policy, and a "scan before enable" default. **Cost 3.**

### G2. Lockfile — **in scope, P3**
`skillfile` has `Skillfile.lock`; `qvr` has `qvr.lock` with a scanned, vetted entry per skill; `skillx` pins releases in `skillx.lock.json`; `skilld` writes `.skills`; `lazyskills` restores from lock files.

We have a journal and a sync manifest, which is close but not a contract: nothing today can answer "rebuild this exact library on another machine and prove it". A `skill-academy.lock.json` — skill, source, commit or release, package hash, placements as intent, scan verdict — becomes the sync manifest, the CI input and the export format at once. **Cost 2.**

### G3. Token and context accounting — **in scope, P1**
`qvr` shows a token-share band per skill plus per-session traces; `skill-zoo` treats archive as context relief; `lazyskills` shows which skills an agent can actually see; `skilld` tracks install vs run.

Nothing in our plan tells the user what their enabled set costs. This is the one number that decides whether a library is usable: 2,140 skills across five agents is a context budget, not an inventory. Measure characters per skill, estimate tokens per agent set, show it in the status bar and per agent, and warn when an agent's enabled set crosses a threshold. This is cheap, honest, and none of the peers does it across every agent on the machine. **Cost 2.**

### G4. Registry discovery — **in scope, P3**
The Vercel CLI and skills.sh, `skillx`, `skillshub` and `skillhub` all answer "find me a skill" without a repo URL. We only accept repositories the user names.

We already parsed skills.sh's agent registry. Treating skills.sh as a source type — search, preview, install into the library — closes the biggest functional distance for a couple of days. Not a marketplace we host; a client for the one that exists. **Cost 2.**

### G5. Health view — **in scope, P1**
`skill-zoo` proactively detects three inconsistency classes; `flint` has a health page; `lazyskills` ships a doctor.

Our curation pass already computes dangling references, unparsed frontmatter, missing descriptions, oversized bodies and duplicate hashes — it just hides them inside a report nobody runs. Surface them as a permanent Health list with one-click fixes where safe (refresh hash, remove a dead link) and a report-only stance everywhere else. **Cost 1.**

### G6. CLI — **after v1**
Eleven of fifteen peers are CLI-first. A local web app is pleasant for browsing but useless over SSH, in a dotfiles script, or from inside an agent that wants to enable a skill.

A thin `ska` client over the local API — `list`, `search`, `enable`, `disable`, `install`, `update`, `sync`, `scan`, `lock` — costs little because the service is already the source of truth. It also becomes the MCP server's transport later. **Cost 3, deferred until the core is stable.**

### G7. Tags with write-back — **in scope, P6**
`flint` keeps tags in local config but can migrate them into `SKILL.md` frontmatter in one click; `skill-zoo` and the desktop managers use tags as the primary axis.

We have labels nowhere. Tags in frontmatter are already ecosystem-native and versioned with the package, so the cheap version is: read `tags`, write `tags`, filter by tag, and never keep a tag that exists only in our database. **Cost 1.**

### G8. Publish, pack, export — **after v1**
`skillx` validates, packs and publishes; `skillhub` is a registry; Better Capabilities already shipped zip packaging because people ask for it.

Exporting a skill as a zip or publishing a source to a repo is how work leaves this machine. Our sync covers backup, not distribution. **Cost 2, deferred.**

### G9. Semantic or resolver search — **after v1, optional**
`skillx` runs bge embeddings plus FTS5 with reciprocal rank fusion; `skillshub` sells itself on a resolver that returns the right skill in one call.

Our filter is lexical on purpose: typing must never wait. But "describe the task, get three candidates" is a different job and we already ported the provider layer. Add it as a separate Resolve action over a cached embedding index, never in the typing path. **Cost 3, only if the lexical filter proves insufficient in daily use.**

### G10. MCP surface — **after v1**
`skillx mcp` serves its installer over MCP; `skillhub` exposes a compatibility layer.

Making the library addressable by an agent is the natural end state: "enable the PDF skill for Cursor" as a tool call. Depends on the CLI existing first. **Cost 3, deferred.**

### G11. Local patches across updates — **rejected**
Only `skillfile` does it, and the reason is that its update path overwrites. Ours refuses the update when the local hash changed and offers a three-way diff. A patch model would add a merge format to maintain for a case our guard already handles. Revisit only if the diff-and-take-upstream flow proves painful in practice.

### G12. Run a skill without installing — **rejected**
`skilld run` loads instructions for one task and writes nothing. Tempting, but it means executing agent instructions from a registry, which is an agent run, not a file operation. Out of scope by design.

### G13. Team RBAC and org registries — **rejected server-side**
`skillhub` spends its complexity here: namespaces, roles, promotion review, audit log. For one person on two machines, that is a server to run and secure. The lockfile plus a CI policy check gives the reproducible half without the governance theatre.

### G14. Session traces and execution reports — **rejected**
`qvr` records sessions with token totals and wall-clock; `skillx` accepts execution reports. Both need the app to observe agent runs, which we deliberately cannot see. Pretending to would mean inventing telemetry.

## What this does to the plan

Four gaps are not optional once the app ingests untrusted repositories and updates them automatically: **scanning, a lockfile, token accounting, and a health view**. Tags and skills.sh discovery are cheap and close real holes. Together they add about 9 days to v1.

| Phase | Change | Days |
|---|---|---|
| P1 | + token accounting, health view | 5 → 7 |
| P2 | + scan pipeline and enable gate | 6 → 9 |
| P3 | + lockfile, skills.sh source | 6 → 9 |
| P6 | + tag read/write and filter | 8 → 9 |
| P9 | CLI and MCP, after v1 | +6 |

v1: about 61 working days. With the deferred parity pass: 67.

The gaps we are not closing are the ones that require becoming a different product: a registry server, an agent runtime, a team platform.

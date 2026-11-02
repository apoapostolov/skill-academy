# Skill Academy

A local web app that finds every agent skill on this machine, shows them in one place, and turns them on and off per agent.

Planning stage. Nothing is implemented yet. The plan is in [PLAN.md](PLAN.md), the design in [docs/ui.md](docs/ui.md).

## The problem it solves

Skills are scattered across 66 global directories owned by 79 agent codes. A skill installed for Claude Code is invisible to Cursor, duplicated for Codex, and stale in three other places. Turning one off means knowing which directory that agent reads, and the five ways an install can be laid out.

Skill Academy scans those directories, treats duplicates as one skill with many placements, and gives every skill a switch per agent. It also watches the repositories the skills came from, reports commits and releases, and can update on a schedule. A curation pass, ported from Hermes' own curator, finds clusters that should be one skill instead of five.

## Documents

| File | Owns |
|---|---|
| [PLAN.md](PLAN.md) | Scope, phases, risks, decisions |
| [docs/product.md](docs/product.md) | Jobs, flows, acceptance criteria |
| [docs/ui.md](docs/ui.md) | Design system, screens, states, copy |
| [docs/architecture.md](docs/architecture.md) | Runtime, data model, scan and update engines, API, security |
| [docs/curation.md](docs/curation.md) | Hermes curator port, both passes |
| [docs/providers.md](docs/providers.md) | String Theory provider port |
| [registry/agents.json](registry/agents.json) | The 67-row agent registry parsed from skills.sh |
| [design/mockup-library.html](design/mockup-library.html) | Static design mockup |

## Status

- Registry: parsed from `vercel-labs/skills` on 2026-11-02.
- Provider layer: source read from `C:\git-public\string-theory`, port not started.
- Curator: policy read from `hermes-agent/agent/curator.py`, port not started.
- App: not started.

Working title. The name is Apo's call.

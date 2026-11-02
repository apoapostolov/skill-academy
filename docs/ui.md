# Interface

Apple HIG behaviour adapted to a browser: same restraint, same hierarchy, same feedback discipline. Not a copy of Apple's visual identity, and no iOS shapes on a desktop surface.

The reference for control behaviour is the `apple-ui-standards` skill. This document owns Skill Academy's concrete decisions: measurements, tokens, screens, states, motion and copy.

## Principles

1. **Calm density.** A professional tool shows a lot without feeling loud. Colour marks state, never decoration.
2. **One primary action per screen.** The library's primary action is the switch. Everything else is secondary.
3. **The row is the truth.** If a row says mixed, the detail must explain it in one glance.
4. **Nothing moves under the pointer.** Scans update rows in place. No reorder mid-hover.
5. **Reversible actions do not ask.** Toggle and undo. Irreversible actions ask twice.

## Style

Three preferences decide every visual question below.

1. **Polished PC software.** Skill Academy runs in its own window (Chromium app mode), at desktop density, with a menu bar, a toolbar, resizable panes, context menus, keyboard accelerators and a status bar. No mobile shapes: no bottom sheets, no floating action buttons, no oversized radii, no card grids, no bounce.
2. **Dark by default.** Dark ships as the default theme; light is an equal, not a fallback. Every surface is designed dark first and checked in light before merge.
3. **Grey carries the interface, colour carries state.** Chrome, panes, rows and text are neutral grey with no tint. Chroma appears only where it means something: enabled, attention, destructive, available. Nothing decorative is coloured.

### Signal colours

The default signal palette is replaced. System green, amber and red read as consumer alerts, fight a neutral grey surface, and make a quiet tool look loud.

| Meaning | Token | Dark | Light | Replaces |
|---|---|---|---|---|
| Enabled, healthy | `--ok` | `#6E9E8A` verdigris | `#3F6F5B` | system green |
| Attention, drift | `--attention` | `#B58B62` raw sienna | `#8A6236` | amber |
| Destructive | `--destructive` | `#B85C57` rosewood | `#993F3A` | red |
| Available, update, selection | `--accent` | `#7FA3C7` dusty blue | `#3D6B93` | system blue |

Every signal colour stays under 45% saturation and is checked at 4.5:1 against `--surface` for text use and 3:1 for a 2px indicator. Destructive colour appears only inside a destructive confirmation. Enabled colour is never decoration.

### Themes

Twelve themes, each with a dark and a light variant, plus one restrained custom accent. A theme changes two things: the accent and the tint of the grey ladder. It never changes state colours. Verdigris, raw sienna and rosewood stay identical in every theme, because a state that changes meaning with a skin is not a state.

| Theme | Dark accent | Light accent | Character |
|---|---|---|---|
| Graphite | `#7FA3C7` | `#3D6B93` | Neutral default, cool grey |
| Harbour | `#6E93B8` | `#37628C` | Deeper blue |
| Fjord | `#7E9AA8` | `#3F6673` | Blue-grey, lowest chroma |
| Ink | `#5F8F8C` | `#2F6663` | Deep teal, near-black chrome |
| Fern | `#6F9E72` | `#4A7350` | Green, 31° clear of the enabled hue |
| Moss | `#8FA37A` | `#556B45` | Olive, warm green |
| Dusk | `#9A8FB4` | `#5B527A` | Muted violet |
| Plum | `#B08FA3` | `#7A5266` | Mauve |
| Clay | `#B08A76` | `#7A5341` | Terracotta |
| Sand | `#B5A588` | `#736449` | Warm neutral |
| Fog | `#9AA6AE` | `#55636B` | Cool grey, no colour pull |
| Rose | `#B58A8A` | `#7A5050` | Dusty rose |

Rules:

- The accent hue stays at least 20° away from the enabled hue (`#6E9E8A`, roughly 155°), so no theme can make the whole interface read as "on".
- Surface tint comes from the theme at 6% chroma or less. `--bg`, `--surface` and `--sidebar` shift a few points of hue; never enough to fight the content or the cropped screenshots.
- Light variants darken the accent for contrast. The accent never carries body text.
- A theme ships only when every pair in the token table passes the same contrast check as the default. The check runs across 24 variants in CI; a failing theme is not released.
- Custom takes one hue slider and a chroma ceiling of 45%, then passes the same gate. No arbitrary hex field: a hand-picked hex is how a tool ends up with an unreadable accent.

### Settings › Appearance

Above the grid, a segmented control: `System`, `Dark`, `Light`. System follows the OS and switches live.

Below it, the theme grid: three columns, 148×96 cards, each a live miniature of the window — sidebar strip, one list row, one switch — rendered in that theme's tokens, with the name beneath in 11px. The selected card carries a 2px accent ring. Clicking applies immediately, no confirmation, and the whole window including open sheets re-renders.

A `Preview` strip under the grid shows one row at the current theme with the three states (on, off, mixed) side by side, so the signal colours can be judged before committing. Themes are stored per machine in settings, not synced.

## Window

A three-pane layout filling the viewport, no page scroll. Only the list and the detail body scroll.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ File  Edit  View  Skills  Sources  Tools  Help                               │  26px
├──────────────────────────────────────────────────────────────────────────────┤
│  Skill Academy   [ Filter in Cursor            ⌘K ]      ⟳ 12/66   ◉ 3   ⚙  │  44px
├───────────────┬──────────────────────────┬───────────────────────────────────┤
│  All skills   │  agent:cursor  ×         │  prose-review                  ⋯  │
│  Updates    3 │  18 results              │  ApoMakesMods/prose-review  v2.1  │
│  Mixed     12 │  ┌────────────────────┐  │  ─────────────────────────────    │
│  Drift      1 │  │ ▣ prose-review  ◐  │  │  On in 3 of 5 agents      [ ◐ ]  │
│               │  │ ▣ seo-audit     ●  │  │  ┌─────────────────────────────┐  │
│  AGENTS       │  │ ▣ design-apps   ○  │  │  │ Claude Code        [ ● ]    │  │
│  Claude Code  │  └────────────────────┘  │  │ Cursor             [ ● ]    │  │
│  Cursor       │                          │  │ Codex              [ ○ ]    │  │
│  SOURCES      │                          │  │ Hermes Agent       [ ● ]    │  │
│  mattpocock   │                          │  └─────────────────────────────┘  │
├───────────────┴──────────────────────────┴───────────────────────────────────┤
│ 2,140 skills · 66 roots · scanned 4m ago        SQLite · 3 jobs · 148 MB     │  24px
└──────────────────────────────────────────────────────────────────────────────┘
   232px min        340–420px                    flexible, min 480px
```

- Sidebar: 232px default, resizable 200–280, collapsible to a 52px rail with icons only.
- Density: Compact (default, 44px rows), Comfortable (56px), Dense (36px, no description). Set in Settings › General.
- List: 340px default, resizable 300–520, remembers per view.
- Detail: minimum 480px. Under 1080px total the detail moves to a pushed pane with a back chevron. Under 760px the sidebar becomes a sheet.
- Splitters: 1px hairline, 8px hit area, cursor `col-resize`, double-click resets to default.
- No scrollbars unless content overflows; overlay style, 8px wide, fade unless hovered or scrolling.

### Menu bar

26px, one row, hairline bottom, `--sidebar` background, 12px text. `File Edit View Skills Sources Tools Help`. Menus are real menus: keyboard navigable, type-ahead, accelerators right-aligned. The window uses Chromium app mode, so this is the only menu bar; the browser's own chrome is absent.

### Toolbar

44px, one row, hairline bottom. Left: wordmark 13px semibold, then the current section in 12px secondary. Centre: the filter field, 440px max, radius 6. Right: scan status, notification bell with unread count, settings gear.

### Status bar

24px, `--sidebar`, 11px tertiary, hairline top, three cells: library totals and last scan on the left, current jobs and database state in the middle, memory and provider state on the right. It shows steady state only, never progress.

Scan status: idle shows nothing. Scanning shows a 14px indeterminate ring plus "Scanning 12 of 66" in 11px secondary, no bar. Finished shows the result for 4 seconds then fades to nothing.

## Tokens

Semantic only. Components never reference raw values.

### Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FAFAFB` | `#101113` | Window background |
| `--surface` | `#FFFFFF` | `#17181B` | Rows, cards, toolbar |
| `--surface-raised` | `#FFFFFF` | `#1D1F22` | Sheets, popovers, menus |
| `--sidebar` | `#F2F2F4` | `#141518` | Sidebar, menu bar, status bar |
| `--text` | `#1C1C1E` | `#E9EAEC` | Primary text |
| `--text-secondary` | `#6A6C70` | `#9A9CA1` | Descriptions, meta |
| `--text-tertiary` | `#8A8C90` | `#7A7C82` | Timestamps, counts |
| `--separator` | `rgba(0,0,0,.09)` | `rgba(255,255,255,.08)` | Hairlines |
| `--accent` | `#3D6B93` | `#7FA3C7` | Selection, focus, primary button |
| `--accent-soft` | `rgba(61,107,147,.10)` | `rgba(127,163,199,.14)` | Selected row background |
| `--ok` | `#3F6F5B` | `#6E9E8A` | Enabled state |
| `--attention` | `#8A6236` | `#B58B62` | Drift, local changes, mixed |
| `--destructive` | `#993F3A` | `#B85C57` | Destructive confirmation only |
| `--neutral-state` | `#8A8C90` | `#6C6E73` | Disabled track, inert glyphs |

Rules: chroma is state, never decoration. Disabled and inert are neutral grey, not a dimmed colour. No token carries more than 45% saturation. Nothing relies on hue alone: every state also has a glyph or a label, so the app is fully readable in greyscale. Contrast targets: body text ≥ 7:1, secondary ≥ 4.5:1, large text and 2px indicators ≥ 3:1. The contrast check runs in CI over every pair in the table, in both themes.

### Type

System stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable", "Segoe UI", Inter, sans-serif`. Mono: `"SF Mono", "Cascadia Code", ui-monospace, monospace` for paths, hashes and counts.

| Role | Size / line / weight | Use |
|---|---|---|
| Title | 22 / 28 / 600 | Detail title, onboarding headline |
| Heading | 15 / 20 / 600 | Section headers in sheets |
| Body | 13 / 18 / 400 | Default text |
| Body strong | 13 / 18 / 590 | Row name, values |
| Caption | 11 / 14 / 400 | Meta, timestamps, counts |
| Micro | 10 / 12 / 500, tracking .04em, uppercase | Sidebar group labels |
| Mono | 12 / 16 / 400 | Paths, SHAs, token counts |

Tracking: `-0.01em` on 15px and above, `0` below. Never below 11px except the micro label.

### Space, radius, elevation

- Space scale: 2, 4, 8, 12, 16, 24, 32, 48. Only these.
- Row padding: 12px vertical, 14px horizontal. Section padding: 20px. Sheet padding: 24px.
- Radius: 4 controls, 6 rows and cards, 8 sheets and popovers, 999 pills. Nothing above 8 except pills.
- Elevation: `0 0 0 1px var(--separator)` for inline surfaces; `0 8px 28px rgba(0,0,0,.12), 0 0 0 1px var(--separator)` for sheets and popovers. No other shadows.

## Sidebar

Grouped lists with 26px rows, 8px group gaps, micro uppercase headers.

1. **Smart lists** — All skills (count), Updates (count, blue dot when > 0), Mixed (count), Drift (count, warn dot), Drafts (count), Archive.
2. **Agents** — one row per detected agent with its own count of placed skills. Undetected agents are hidden behind "Show all agents" at the group foot, which opens the registry sheet. Rows carry a 16px agent glyph from the icon set.
3. **Sources** — one row per source with a state dot (`up to date`, `behind`, `error`), plus "Add source…".
4. **Tags** — top eight tags by count, then "All tags…".

Selection: accent-soft pill, 6px radius, full row width including 8px side inset. Hover: `rgba(0,0,0,.04)`. Focus ring only from keyboard.

Sidebar footer: a 24px line with `2,140 skills · 66 roots · scanned 4m ago` in tertiary, and a rescan icon button. This is the only place showing global counts.

## Search and filter

The top-bar field is the command palette in disguise. It filters the list as you type and, when the query starts with `>`, runs commands instead.

- Debounce: none. Filter applies on the input event against the client index.
- Chips appear under the list header, one per parsed clause, removable with a small ×. Typing `is:off ` promotes the clause to a chip and clears the text field, so the next word is a new clause.
- Suggested completions appear in a 1-row inline hint under the field, never a dropdown covering the list: `agent:`, `source:`, `is:`, `tag:`, `path:`.
- Match highlighting: the matched substring in name and description gets `background: var(--accent-soft); border-radius: 3px`.
- Scope indicator: when a sidebar item is selected, the field placeholder reads `Filter in Cursor`, and the chip `agent:cursor` is added automatically.
- `⌘K` focuses the field; `esc` clears the query and keeps focus; `esc` again blurs.
- No results: the list area shows the parsed query as chips, then one line naming the clause that eliminated everything (`No skills have both is:off and agent:zed`), then a secondary button `Clear that clause`. Never a shrug illustration.

## List

One row per logical skill. Grouped by `Recently changed` default into Today, This week, Earlier; grouping applies only to that sort.

```
┌────────────────────────────────────────────────────┐
│ ▣  prose-review                          ◉    ⋯   │  56px
│    Rewrites prose without changing meaning · 3     │
│    ApoMakesMods/prose-review          v2.1  ⌄      │
└────────────────────────────────────────────────────┘
```

- Height follows density: 44px Compact (default), 56px Comfortable, 36px Dense. The description gets one line at Compact and Dense, two at Comfortable.
- 16px agent glyph or source glyph; a stacked glyph with `+3` when placements span agents.
- Name 13/590, one line, truncating with an ellipsis.
- Description 11px secondary, max two lines, clamped.
- Meta line 11px tertiary: source, version, and one badge when relevant (`Update`, `Drift`, `Mixed`, `Linked 3`, `Internal`, `Pinned`).
- Right: the switch (state as described below) and a `⋯` menu on hover.
- Hover: surface lightens to raised, the `⋯` fades in over 120ms. Selected: accent-soft, 3px accent bar on the leading edge.
- Multi-select: `⌘`/`ctrl` click, `shift` click for a range, `⌘A` selects the filtered set. A floating bulk bar appears 12px above the list foot with `N selected`, `Turn on`, `Turn off`, `Archive`, `Pin`, `Deselect`. Escape clears.
- Virtualized at 60 rows rendered; scrolling stays 60fps.
- New rows from a live scan fade and slide 4px in over 180ms, then settle. Rows never reorder while a pointer is inside the list.

## Switches and state

The switch is the product. Its three states must be readable without colour.

| State | Control | Row badge | Meaning |
|---|---|---|---|
| On | filled track, knob right | none | placed in every detected agent that can hold it |
| Off | neutral track, knob left | none | placed nowhere |
| Mixed | filled track with a 2px gap and a dash in the knob | `Mixed` | placed in some agents |
| Pinned | On with a small pin glyph beside the track | `Pinned` | updates will not apply |
| Drift | switch shows attention tint and a corner dot | `Drift` | disk disagrees with journal |
| Shadow | switch disabled, 60% opacity, tooltip with reason | `Read-only` | bundled or external-dir |

- Track 34×20, knob 16, 2px inset, radius 999. On uses `--ok`; off uses `--neutral-state`; mixed uses `--ok` with a horizontal dash on the knob.
- Hit target 44×44 including padding.
- Motion: knob travels 14px in 180ms `cubic-bezier(.32,.72,0,1)`; track colour crossfades 120ms.
- Optimistic: the switch moves immediately, the row gets a 500ms subtle pulse, and a failure reverts with a toast quoting the OS error. No blocking modal.
- Bulk toggles animate rows in sequence with a 12ms stagger, capped at 10 staggered rows.
- Keyboard: `space` toggles the focused row, `⌥space` opens the per-agent matrix.

## Detail

Header (sticky, 116px): glyph, name 22/600, source line with a link, version pill, and the primary control — `On in 3 of 5 agents` with the switch at the right. `⋯` holds Rename, Pin, Reveal in file manager, Copy path, Archive.

Segmented tabs directly under the header, underlined style, 13px: `Instructions`, `Agents`, `Linked`, `Files`, `Activity`, `Updates`, `Curation`. The tab set is stable across skills; empty tabs still render with an explanation.

### Instructions

Rendered markdown with a serif-free reading column capped at 720px, 14/22. Code blocks use mono 12 on `--sidebar` with a copy button. Remote images are blocked by default with a line `Image blocked. Load images for this skill?` and a toggle that remembers per source. Raw mode switches to mono text with line numbers. Frontmatter is shown as a 6-row key/value table above the body, with unknown keys collapsed under `More fields`.

### Agents

The matrix: one row per detected agent root that can hold this skill.

```
Claude Code    ~/.claude/skills          linked     [ ● ]
Cursor         ~/.cursor/skills          linked     [ ● ]
Codex          ~/.agents/skills          linked     [ ○ ]
Hermes Agent   ~/.hermes/skills          native     [ ● ]
Zed            ~/.agents/skills          same root as Codex  [ ◌ ]
```

- Ignored/aliased roots state the reason on the right in tertiary instead of showing a switch.
- Rows group by physical root; agents sharing a root are listed once with all their names (`Codex, Cline, Zed`).
- Right-click a row for `Reveal`, `Repair placement`, `Convert to linked`.
- Below the matrix, one line of explanation in 11px tertiary naming the mode the switch uses: `Turned off by renaming SKILL.md. The package stays where it is.`

### Linked

The knowledge this local skill absorbed from elsewhere. A linked list under the skill, one row per remote source, 48px:

```
mattpocock/skills · prose-review        upstream 4c81e0d      [ Ingest ]
tracking: commit main · ingested 2 weeks ago · 3 new commits
```

- Columns: source and upstream skill path, the ref being tracked, last ingested (relative), and a right-aligned action.
- Status chip: `Up to date`, `3 new commits`, `New release v1.3.2`, `Local edits`, `Error`. Attention uses the sienna token; up-to-date is neutral, not green.
- The row expands in place to show what the last ingest contributed: rules added, conflicts, dropped, and a link into the run report. No modal for reading.
- Header actions: `Add link` and `Ingest all` (disabled when every link is up to date, with the reason in its tooltip).
- Under the list, one line in tertiary: how the ingest writes, for the mode of the selected link. `Distill merges rules into this skill. Local rules win on conflict.`
- Empty state: `No linked sources. This skill is self-contained.` with `Add link`.
- A composite skill shows a link glyph beside its name in the list, and `Linked 3` in the meta line. Pinned and composite are independent.

### Files

Tree with per-file size and hash short form, 12px mono. Directories collapse; `SKILL.md` open by default. A footer shows package size and hash, with `Copy hash`.

### Activity

A timeline, newest first, 40px rows: toggles, scans that changed it, updates applied, curation merges, drift repairs. Each entry has a 20px glyph, the action in body text, the actor (`you`, `scan`, `auto-update`, `curation`), and a relative timestamp. Every reversible entry carries `Undo` on hover. This is the journal made visible.

### Updates

Current version, source head, last checked, and a list of changes: release entries with the tag and notes excerpt, commit entries with the message subject and short SHA. `Check now`, `Update`, `Pin`, and for a refused update a `Local changes` block with the three actions and a diff link.

### Curation

Only for skills the curator can touch. Shows state (active/stale/archived), last decided, usage signal (`unknown` is a first-class value with an explanation), and any proposed merge with a link into the run report.

## Authoring

A full-window surface, not a sheet. The menu bar and toolbar stay; the three panes are replaced.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ‹ Library   prose-review  [LLM draft]          Saved 14:22   Preview  Save  │ 52px
├──────────────────────────────────────────────────────────────────────────────┤
│ H1 H2  B  I  ‹›  {}  •  1.  ❝  ↗  ▦  ¶  ⌗                                   │ 36px
├───────────────┬──────────────────────────────────┬───────────────────────────┤
│ OUTLINE       │  1  ---                          │ PREVIEW                   │
│ Rewrites…     │  2  name: prose-review           │ # Rewrites prose…         │
│ When to use   │  3  description: Rewrites…       │                           │
│ Rules         │  4  ---                          │ Keep facts, attribution…  │
│ Conflicts     │  5                                │                           │
│               │  6  ## When to use               │ ─────────────────────     │
│               │  7  Read the audience first…     │ VALIDATION                │
│               │                                  │ ✓ Frontmatter complete    │
│               │                                  │ ⚠ Description 142 chars   │
├───────────────┴──────────────────────────────────┴───────────────────────────┤
│ 412 words · 2,818 / 24,000 chars ▓▓░░░░░░░░        line 7, col 24 · anthropic│ 24px
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Header.** Back chevron returns to the library and asks before discarding unsaved changes. Name is inline-editable and becomes the slug on first save. Origin badge reads `New`, `LLM draft` or `Editing`. Save state: `Saved 14:22`, `Saving…`, `Unsaved changes`. Right: `Preview` toggle, `Validate`, `Save`.
- **Format toolbar.** 28px buttons, 4px radius, 8px gaps, grouped by a 1px separator: H1, H2, bold, italic, inline code, code block, bullet list, ordered list, quote, link, table, frontmatter block. Each has a tooltip with its shortcut. Buttons act on the selection and keep focus in the editor.
- **Outline.** 200px, one row per heading, 22px, indented by level, click scrolls to the heading, current heading highlighted. Empty state: `No headings yet.`
- **Editor.** CodeMirror, mono 12.5/20, soft wrap, current-line highlight, markdown syntax colouring, line numbers on by default (toggle in the header menu). The frontmatter block gets a subtle tinted background so the boundary is obvious.
- **Right rail.** 380px, two tabs: `Preview` and `Sources`. Preview is sanitized render at 13/20, capped at 640px of text width, updating on a 120ms debounce and never scroll-jumping.
- **Validation.** Docked at the bottom of the rail regardless of tab: a one-line summary (`2 errors, 1 warning` or `Ready to save`) that expands into findings, 24px rows, error glyph in rosewood, warning in sienna. Clicking a finding moves the caret to its line. The save button is disabled while any error stands, and its tooltip names the first one.
- **Footer.** Words, characters against the 24,000 cap as a 40px hairline, caret position, and the provider plus model when the draft came from or is being improved by a model.

### New skill

`⌘N` opens a 560px sheet with two entry rows, each a 72px card:

- **Generate from a prompt.** Opens the generate form below.
- **Start empty.** Asks for a name and a description, then opens the editor with a scaffold (`When to use`, `Rules`, `References`) and the Sources tab selected. Nothing is written to an agent directory.

### Generate a draft

A 560px sheet over the editor surface, 8px radius.

- A 4-row prompt field, placeholder `What should this skill do, and when should it be used?`
- **Source material** as chips: `Attach skill`, `Attach file`, `Paste text`. Each chip opens a picker; attachments are listed with a remove control. Nothing is pulled implicitly.
- **Model** row: provider, model, and `about $0.04` estimate, updating with the prompt length.
- Footer: `Generate draft`. On completion the editor opens the draft with the origin badge and a one-line summary of what the model produced. A failed schema is reported as a failed run with the reason, never a partial draft.

### Build from sources

The Sources tab is the same link list as the detail pane, scoped to this draft.

- Empty state: `No sources yet. Add a skill to ingest, or write the first rule.` with `Add source`.
- Each row: source and upstream skill path, tracked ref, mode (`Distill` / `Attach` / `Summarize`), and `Ingest`. A footer button reads `Ingest all`, disabled when nothing is behind.
- First ingest on a link is a bootstrap. The run sheet shows, per link, how many rules it contributed, how many were dropped as duplicates of another link, and any conflict. The merged body appears in the editor diff, not applied blind.
- After the run the header badge reads `Composite draft`, the outline takes the generated headings, and the Sources tab shows `2 sources · 7 rules · 1 conflict`.
- The body cap still applies: when the merged material would pass 24,000 characters, the overflow lands in `references/ingested/` and the body keeps one pointer per source.
- A soft cap of 8 links per skill warns at 6. Past 8, `Add source` asks for confirmation and names the context cost.
- Saving places the composite like any other skill: the Linked count follows it into the library.

### Edit an existing skill

Opening `Instructions` and pressing `Edit`, or the row menu's `Edit`, opens the same surface with the package loaded and `Editing` in the header. `Rewrite for clarity` and `Extract rules from notes` sit in the header menu and open a diff sheet: the current body on the left, the proposal on the right, per-hunk accept. Applying writes through the save path.

## Sheets

All sheets are centered, max 560px wide (720 for reports), 8px radius, 24px padding, hairline border, 200ms scale from .98 with fade. Escape closes; the primary button is focused on open only if the sheet is a confirmation.

- **Add source** — segmented type (GitHub, Git repo, Folder), URL or path, branch, then a live check that shows what would be imported: N skills found, M new, K already present, with a scrollable list. Footer: `Add source`.
- **Update review** — what changed per skill, the old and new hash, and a rendered diff for `SKILL.md`. Buttons: `Update 3 skills`, `Skip`, `Pin these`.
- **Curation run** — a report sheet with four sections: Clusters found, Proposed merges, Proposed archives, Left alone. Each proposal is a row with the umbrella name, absorbed skills, and one-sentence reason. Footer states the token and cost estimate before applying and requires typing nothing; the confirm button reads `Apply 4 merges`.
- **Ingest review** — the delta per link: commits since the last ingest, files read, proposed rules grouped as added, changed and conflicts, and the token and cost estimate before the run. Mode selector per link. Footer: `Ingest 3 sources`, with `Dry run` beside it.
- **Archive** — destination picker listing every archive location with its free space and availability, the mode, and one line: `Restorable from E:\Skill archive`. Confirm reads `Archive skill`.
- **Settings** — sidebar inside the sheet: General, Agents, Sources, Archives, Sync, Providers, Curation, Shortcuts, Advanced. Providers and Curation are described in their own documents. The Archives pane is a table: label, path, mode, default, availability dot, free space, and `Test`. Below it, a per-agent default dropdown and `Add location`. A path that is offline shows the OS error in place, not a toast. The Sync pane is a profile table: label, remote, direction, schedule, ahead/behind, last run, and `Run now`.
- **Sync conflict** — one row per conflicted path with its state, a two-column diff, and a choice of `Keep local`, `Take remote`, or `Keep both`. The footer's `Finish merge` stays disabled until every row is resolved, and names how many remain.
- **Registry** — the full 67-row agent table with detection state, paths, and an `Add custom root` action.

## Notifications

The bell opens a popover, 360px wide, anchored top-right: unread first, then today, then earlier. Each entry: source, event kind, skill count, time, and one action (`Review`). A footer link opens the Updates view. Badge is a dot when there is unread, a number when over 9.

Toasts: bottom-right, 320px, stack of three, 4s auto-dismiss with a progress hairline, `Undo` when the action is reversible. Never more than one toast per action source per second; bulk actions produce one toast with a count.

## Onboarding

Three steps in a centered 720px column, no sidebar, no tour overlay.

1. **What Skill Academy found.** A list of detected agent roots with counts, each with a switch to include or skip. Headline: `12 agents found on this machine.` Sub: `Skill Academy reads their skill folders. It does not change anything yet.`
2. **Where skills come from.** Optional sources with two suggestions derived from installed skills' own source metadata, plus `Skip for now`.
3. **Your library.** A single sentence describing what was found: `2,140 skills, 380 duplicates, 41 with updates.` Primary button: `Open library`.

Progress is a 2px line under the header, not dots.

## Loading, empty and error states

Every surface has four states designed before it is built.

| Surface | Loading | Empty | Error |
|---|---|---|---|
| Library | 8 skeleton rows, no spinner, 300ms delay before showing | `No skills in this agent. Install one or add a source.` | `Could not read ~/.cursor/skills. Permission denied.` + `Show in file manager` |
| Detail | Header from the row, body skeleton | `This skill has no instructions file.` | `Package could not be read.` + path |
| Updates | `Checking 4 sources…` with per-source rows | `No updates. Last checked 4m ago.` | `GitHub rate limit. Next check at 15:40.` |
| Curation | `Reading 380 skills…` with a token counter | `No runs yet.` | `Run failed: provider returned 401.` + `Fix provider` |
| Scan | top-bar ring with counts | — | one aggregated row in the list: `3 paths could not be read` with a disclosure |

Error copy always states what failed, on which path, and the exact OS or HTTP message, then one action. No apologies, no exclamation marks.

## Motion

- Durations: 120ms micro (hover, fade), 180ms standard (toggle, row insert), 240ms sheets, 320ms pane transitions. Nothing longer.
- Easing: standard `cubic-bezier(.32,.72,0,1)`; enter `cubic-bezier(.16,1,.3,1)`; exit `cubic-bezier(.4,0,1,1)`.
- Never animate layout of the list while scanning. Never animate width of text.
- `prefers-reduced-motion: reduce` collapses all of the above to opacity-only 80ms and disables the row stagger.
- No parallax, no bounce except the toggle's 4px overshoot.

## Keyboard

| Key | Action |
|---|---|
| `⌘K` | Focus filter |
| `↑` `↓` | Move selection |
| `space` | Toggle focused row |
| `⌥space` | Toggle menu per agent |
| `⌘⌥S` / `ctrl+alt+S` | Rescan |
| `⌘,` | Settings |
| `⌘Z` | Undo last reversible action |
| `⌘⇧U` | Updates view |
| `⌘N` | New skill |
| `⌘S` | Save the draft |
| `⌘B` / `⌘I` / `⌘K` | Bold / italic / link in the editor |
| `⌘⇧P` | Toggle preview |
| `⌘⏎` | Validate |
| `⌘1..7` | Detail tabs |
| `esc` | Clear query, then deselect, then close sheet |

Shortcuts are shown in tooltips and in Settings › General › Keyboard.

## Accessibility

- Roles: sidebar `navigation`, list `listbox` with `option`, row switch a real `switch` with `aria-checked="mixed"`, tabs `tablist`, sheets `dialog` with `aria-modal` and a focus trap.
- Focus order: sidebar, filter, list, detail. Focus never enters the detail automatically after a selection change.
- Visible focus: 2px accent ring at 2px offset, only for `:focus-visible`.
- Every icon-only control has an accessible name. Agent glyphs carry the agent name.
- Live regions: scan completion and update arrival announce politely; errors assertively.
- Reduced transparency: `@media (prefers-reduced-transparency: reduce)` makes the sidebar and sheets opaque.
- Zoom to 200% must not clip the switch or the meta line; the list reflows to 72px rows.
- Colour-blind check: every state has a glyph or label. The app is usable in greyscale.

## Copy

Voice: Apostol's operational profile. Short, factual, no encouragement, no personality in error paths. Sentence case for labels and buttons. No terminal periods on labels. Numbers formatted with the locale, but counts in the sidebar use compact form above 1,000 (`2.1k`).

| Surface | Text |
|---|---|
| Empty library | No skills in this agent. Install one or add a source. |
| Mixed badge | Mixed |
| Toggle off, native mode | Turned off by renaming SKILL.md. The package stays where it is. |
| Drift row | Drift — the disk changed since Skill Academy placed this. |
| Repair sheet | Repair placement |
| Local edits block | This skill changed on disk. Updating would overwrite your edits. |
| Update confirm | Update 3 skills |
| Archive confirm | Archive skill. It moves to E:\Skill archive and can be restored. |
| Archive location offline | E:\Skill archive is offline. Reconnect the drive or pick another location. |
| Linked, empty | No linked sources. This skill is self-contained. |
| Linked, behind | 3 new commits since the last ingest. |
| Ingest review | Ingest 3 sources |
| Ingest conflict | Local rule kept. Upstream says: never rewrite a quoted passage. |
| Ingest no-op | Nothing new upstream. No changes written. |
| New skill | New skill |
| Draft autosave | Saved 14:22 |
| Validation clean | Ready to save |
| Validation blocked | 2 errors block saving |
| Generate prompt | What should this skill do, and when should it be used? |
| Generate estimate | about $0.04 |
| Draft source badge | LLM draft |
| Start empty | Start empty |
| Empty body | No rules yet. Ingest sources or write the first rule. |
| Composite draft | Composite draft |
| Sources summary | 2 sources · 7 rules · 1 conflict |
| Link cap warning | 6 sources. Each one adds context to every load. |
| Sync ahead | 3 commits ahead of origin |
| Sync conflict | Both sides changed this file. Pick one. |
| Sync blocked | Blocked: 1 key-shaped string in references/api.md |
| Sync never run | No sync yet. |
| Scan failure row | 3 paths could not be read |
| Curation dry run | Reading 380 skills. Nothing will change. |
| Curation apply | Apply 4 merges |
| Provider test ok | Connected. 41 models. |
| Provider test fail | Anthropic returned 401: invalid x-api-key |
| Rate limit | GitHub rate limit. Next check at 15:40. |
| Onboarding headline | 12 agents found on this machine. |

Rules: no "Oops", no "Whoops", no "Awesome", no exclamation marks, no emoji in labels. A hint is one sentence and only appears where the decision is genuinely ambiguous. If a control needs a paragraph to explain, the control is wrong.

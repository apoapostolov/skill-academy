import re
import pathlib

p = pathlib.Path('C:/git-public/skill-academy/docs/ui.md')
t = p.read_text(encoding='utf-8')
n = 0


def rep(old, new, count=1):
    global t, n
    assert old in t, 'MISSING: ' + old[:70]
    t = t.replace(old, new, count)
    n += 1


STYLE = """## Style

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

## Window

A three-pane layout"""

rep("## Window\n\nA three-pane layout", STYLE)

m = re.search(r"```\n┌.*?\n```", t, re.S)
assert m, 'diagram not found'
new_diagram = """```
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
```"""
t = t[:m.start()] + new_diagram + t[m.end():]
n += 1

rep("- Sidebar: 232px default, resizable 200–280, collapsible to a 56px rail with icons only.",
    "- Sidebar: 232px default, resizable 200–280, collapsible to a 52px rail with icons only.\n"
    "- Density: Compact (default, 44px rows), Comfortable (56px), Dense (36px, no description). Set in Settings › General.")

rep("### Top bar\n\n52px, one row, hairline bottom. Left: wordmark 15px semibold, then the current section name in 13px secondary. Centre: the global search field, 480px max, pill radius 8. Right: scan status, notification bell with unread count, settings gear. No traffic lights; the browser owns those.",
    """### Menu bar

26px, one row, hairline bottom, `--sidebar` background, 12px text. `File Edit View Skills Sources Tools Help`. Menus are real menus: keyboard navigable, type-ahead, accelerators right-aligned. The window uses Chromium app mode, so this is the only menu bar; the browser's own chrome is absent.

### Toolbar

44px, one row, hairline bottom. Left: wordmark 13px semibold, then the current section in 12px secondary. Centre: the filter field, 440px max, radius 6. Right: scan status, notification bell with unread count, settings gear.

### Status bar

24px, `--sidebar`, 11px tertiary, hairline top, three cells: library totals and last scan on the left, current jobs and database state in the middle, memory and provider state on the right. It shows steady state only, never progress.""")

m = re.search(r"\| Token \| Light \| Dark \| Use \|.*?The contrast check runs in CI over every pair in the table\.", t, re.S)
assert m, 'colour table not found'
new_colour = """| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FAFAFB` | `#101113` | Window background |
| `--surface` | `#FFFFFF` | `#17181B` | Rows, cards, toolbar |
| `--surface-raised` | `#FFFFFF` | `#1D1F22` | Sheets, popovers, menus |
| `--sidebar` | `#F2F2F4` | `#141518` | Sidebar, menu bar, status bar |
| `--text` | `#1C1C1E` | `#E9EAEC` | Primary text |
| `--text-secondary` | `#6A6C70` | `#9A9CA1` | Descriptions, meta |
| `--text-tertiary` | `#8A8C90` | `#6C6E73` | Timestamps, counts |
| `--separator` | `rgba(0,0,0,.09)` | `rgba(255,255,255,.08)` | Hairlines |
| `--accent` | `#3D6B93` | `#7FA3C7` | Selection, focus, primary button |
| `--accent-soft` | `rgba(61,107,147,.10)` | `rgba(127,163,199,.14)` | Selected row background |
| `--ok` | `#3F6F5B` | `#6E9E8A` | Enabled state |
| `--attention` | `#8A6236` | `#B58B62` | Drift, local changes, mixed |
| `--destructive` | `#993F3A` | `#B85C57` | Destructive confirmation only |
| `--neutral-state` | `#8A8C90` | `#6C6E73` | Disabled track, inert glyphs |

Rules: chroma is state, never decoration. Disabled and inert are neutral grey, not a dimmed colour. No token carries more than 45% saturation. Nothing relies on hue alone: every state also has a glyph or a label, so the app is fully readable in greyscale. Contrast targets: body text ≥ 7:1, secondary ≥ 4.5:1, large text and 2px indicators ≥ 3:1. The contrast check runs in CI over every pair in the table, in both themes."""
t = t[:m.start()] + new_colour + t[m.end():]
n += 1

rep("- Radius: 6 controls, 10 cards, 14 sheets, 999 pills.",
    "- Radius: 4 controls, 6 rows and cards, 8 sheets and popovers, 999 pills. Nothing above 8 except pills.")
rep("- Height 56px minimum, grows to 72px when the description wraps to two lines at the current width.",
    "- Height follows density: 44px Compact (default), 56px Comfortable, 36px Dense. The description gets one line at Compact and Dense, two at Comfortable.")
rep("- Track 38×22, knob 18, 2px inset, radius 999. On uses `--on`; off uses `--off`; mixed uses `--on` with a 1px `--bg` inset line and a horizontal dash on the knob.",
    "- Track 34×20, knob 16, 2px inset, radius 999. On uses `--ok`; off uses `--neutral-state`; mixed uses `--ok` with a horizontal dash on the knob.")
rep("knob travels 180ms `cubic-bezier(.32,.72,0,1)`; track colour crossfades 120ms.",
    "knob travels 14px in 180ms `cubic-bezier(.32,.72,0,1)`; track colour crossfades 120ms.")
rep("All sheets are centered, max 560px wide (720 for reports), 14px radius",
    "All sheets are centered, max 560px wide (720 for reports), 8px radius")
rep("| Off | grey track, knob left | none | placed nowhere |",
    "| Off | neutral track, knob left | none | placed nowhere |")
rep("| Drift | switch shows warning tint and a corner dot | `Drift` | disk disagrees with journal |",
    "| Drift | switch shows attention tint and a corner dot | `Drift` | disk disagrees with journal |")

p.write_text(t, encoding='utf-8')
print('replacements:', n, 'bytes:', len(t))

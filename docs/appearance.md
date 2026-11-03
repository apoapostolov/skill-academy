# Appearance

Twelve themes, each a complete set of the tokens `styles.css` reads (`--bg`, `--surface`, `--text`,
`--text-2`, `--text-3`, `--accent`, `--ok`, `--attention`, `--destructive`, `--sep`, `--hover`). No
component names a colour directly, so a theme is a variable swap: `applyTheme()` writes the tokens
onto `documentElement` and nothing else in the app needs to know a theme exists.

Ten are dark and two are light (Day, Paper). The choice is written to
`localStorage['skill-academy.theme']`, applied on mount, and cycled with `t` or picked in
**Appearance** in the menu. The picker draws each card in its own palette, and shows the **worst
contrast ratio** that theme puts on screen — the same number the gate enforces.

## The gate

`npm run contrast` (`scripts/contrast-check.ts`) reads the same `THEMES` the app applies and checks
these pairs for every theme:

| Pair | Minimum |
| --- | --- |
| text on background, text on surface | 7:1 |
| secondary text, tertiary text on background | 4.5:1 |
| accent on background, accent on surface | 4.5:1 |
| ok, attention, destructive on background | 4.5:1 |

It also asserts there are twelve themes, that the ids are unique, that at least one is light, that
every theme names every token, and — so the gate cannot quietly pass everything — that an obviously
unreadable pair is caught.

**A colour was caught by it.** `Day` shipped with tertiary text `#70747c`, which reads 4.3:1 against
`#f6f5f2`; it looked fine and failed the bar. It is now `#666a72` at 4.98:1, and the gate is the
reason, not a preference.

## Limits

- The gate checks the tokens, not every painted pixel: a component that hard-codes a colour would
  escape it. The rule is that nothing does, and `styles.css` is the place to look when one appears.
- There is no per-theme screenshot test; the picker is checked by reading the applied variables in
  the running app.

/**
 * The contrast gate the twelve themes have to pass.
 *
 * A theme is a palette, and a palette is only usable if it can be read. This computes WCAG 2.1
 * relative luminance for each pair the app actually puts on screen and fails on the ones that fall
 * short. It reads the same `THEMES` the app applies, so a colour cannot be changed in one place and
 * checked in another.
 */
import { THEMES, UNSHIPPED_LIGHT, type Theme } from '../web/src/themes'

import { contrastRatio } from '../web/src/themes'

interface Pair {
  label: string
  foreground: string
  background: string
  /** 7 for body text, 4.5 for secondary text and single-colour marks. */
  minimum: number
}

const round = (value: number): number => Math.round(value * 100) / 100

function pairs(theme: Theme): Pair[] {
  const t = theme.tokens
  return [
    { label: 'text on bg', foreground: t.text, background: t.bg, minimum: 7 },
    { label: 'text on surface', foreground: t.text, background: t.surface, minimum: 7 },
    { label: 'secondary on bg', foreground: t['text-2'], background: t.bg, minimum: 4.5 },
    { label: 'tertiary on bg', foreground: t['text-3'], background: t.bg, minimum: 4.5 },
    { label: 'facet rows on sidebar', foreground: t.facet, background: t.sidebar, minimum: 7 },
    { label: 'accent on bg', foreground: t.accent, background: t.bg, minimum: 4.5 },
    { label: 'accent on surface', foreground: t.accent, background: t.surface, minimum: 4.5 },
    { label: 'ok on bg', foreground: t.ok, background: t.bg, minimum: 4.5 },
    { label: 'attention on bg', foreground: t.attention, background: t.bg, minimum: 4.5 },
    { label: 'destructive on bg', foreground: t.destructive, background: t.bg, minimum: 4.5 }
  ]
}

const failures: string[] = []

const check = (label: string, condition: boolean, detail = ''): void => {
  console.log(`${condition ? 'PASS  ' : 'FAIL  '}${label}${detail ? '  ' + detail : ''}`)
  if (!condition) failures.push(label)
}

check('there are twelve themes', THEMES.length === 12, String(THEMES.length))
check('every theme id is unique', new Set(THEMES.map((theme) => theme.id)).size === THEMES.length)
check('every shipped theme is dark', THEMES.every((theme) => theme.mode === 'dark'))
// The light palettes exist and are deliberately withheld: the shipped set must not quietly include
// a theme that has only ever passed token maths and never met a rendered surface.
check('the light palettes are withheld, not forgotten', UNSHIPPED_LIGHT.length === 2 && !THEMES.some((theme) => theme.mode === 'light'),
  UNSHIPPED_LIGHT.map((theme) => theme.id).join(', '))
check(
  'every theme names all its tokens',
  THEMES.every((theme) =>
    ['bg', 'surface', 'sidebar', 'text', 'text-2', 'text-3', 'accent', 'accent-soft', 'ok', 'attention', 'destructive', 'sep', 'hover'].every(
      (token) => Boolean((theme.tokens as unknown as Record<string, string>)[token])
    )
  )
)

for (const theme of THEMES) {
  const results = pairs(theme).map((pair) => ({ ...pair, ratio: contrastRatio(pair.foreground, pair.background) }))
  const worst = results.reduce((low, row) => (row.ratio < low.ratio ? row : low), results[0])
  const failing = results.filter((row) => row.ratio < row.minimum)
  check(
    `${theme.name} (${theme.mode}) passes every pair`,
    failing.length === 0,
    `worst ${worst.label} ${round(worst.ratio)}:1 (needs ${worst.minimum})` +
      (failing.length ? ` · failing: ${failing.map((row) => `${row.label} ${round(row.ratio)}`).join(', ')}` : '')
  )
}

// The gate is only useful if it can fail: a pair that is obviously unreadable must be caught.
check('the gate catches an unreadable pair', contrastRatio('#111111', '#151515') < 1.2, String(round(contrastRatio('#111111', '#151515'))))

console.log('')
console.log('contrast checks:', failures.length === 0 ? 'all passed' : `${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)

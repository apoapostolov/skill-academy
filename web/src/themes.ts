export interface ThemeTokens {
  bg: string
  surface: string
  sidebar: string
  text: string
  'text-2': string
  'text-3': string
  accent: string
  'accent-soft': string
  ok: string
  attention: string
  destructive: string
  sep: string
  hover: string
}

export interface Theme {
  id: string
  name: string
  mode: 'dark' | 'light'
  tokens: ThemeTokens
}

/**
 * Twelve themes, each a complete set of the tokens `styles.css` reads. Nothing in the app names a
 * colour directly, so a theme is a variable swap and no component needs to know it exists.
 *
 * The palette is not a matter of taste alone: `npm run contrast` computes WCAG ratios for every theme
 * and fails the build when text, secondary text or an accent does not reach its bar. A theme that
 * looks good and cannot be read is not a theme.
 */
export const THEMES: Theme[] = [
  {
    id: 'slate',
    name: 'Slate',
    mode: 'dark',
    tokens: {
      bg: '#101113',
      surface: '#17181b',
      sidebar: '#141518',
      text: '#e9eaec',
      'text-2': '#a8aab0',
      'text-3': '#8b8e94',
      accent: '#7ba0c6',
      'accent-soft': 'rgba(123, 160, 198, 0.16)',
      ok: '#7fb39a',
      attention: '#c69a6d',
      destructive: '#c97670',
      sep: 'rgba(255, 255, 255, 0.08)',
      hover: 'rgba(255, 255, 255, 0.05)'
    }
  },
  {
    id: 'carbon',
    name: 'Carbon',
    mode: 'dark',
    tokens: {
      bg: '#0c0d0f',
      surface: '#141619',
      sidebar: '#111316',
      text: '#e8e9eb',
      'text-2': '#a4a7ad',
      'text-3': '#86898f',
      accent: '#a9b1bd',
      'accent-soft': 'rgba(169, 177, 189, 0.16)',
      ok: '#84b49f',
      attention: '#c39a6c',
      destructive: '#c8746e',
      sep: 'rgba(255, 255, 255, 0.07)',
      hover: 'rgba(255, 255, 255, 0.05)'
    }
  },
  {
    id: 'ember',
    name: 'Ember',
    mode: 'dark',
    tokens: {
      bg: '#12100e',
      surface: '#1a1714',
      sidebar: '#16130f',
      text: '#ece7e1',
      'text-2': '#ad9f92',
      'text-3': '#8c8175',
      accent: '#d99a62',
      'accent-soft': 'rgba(217, 154, 98, 0.18)',
      ok: '#8fb58c',
      attention: '#d9b56a',
      destructive: '#cf7a68',
      sep: 'rgba(255, 255, 255, 0.08)',
      hover: 'rgba(255, 240, 225, 0.05)'
    }
  },
  {
    id: 'moss',
    name: 'Moss',
    mode: 'dark',
    tokens: {
      bg: '#0d1211',
      surface: '#161c1a',
      sidebar: '#111715',
      text: '#e6ebe7',
      'text-2': '#a2aea6',
      'text-3': '#829087',
      accent: '#88b79b',
      'accent-soft': 'rgba(136, 183, 155, 0.16)',
      ok: '#8fc0a0',
      attention: '#c3a271',
      destructive: '#c8796f',
      sep: 'rgba(255, 255, 255, 0.08)',
      hover: 'rgba(230, 255, 240, 0.05)'
    }
  },
  {
    id: 'indigo',
    name: 'Indigo',
    mode: 'dark',
    tokens: {
      bg: '#0e1018',
      surface: '#171a26',
      sidebar: '#12141d',
      text: '#e7e9f2',
      'text-2': '#a3a8bc',
      'text-3': '#8389a0',
      accent: '#9aa2e0',
      'accent-soft': 'rgba(154, 162, 224, 0.18)',
      ok: '#8db29c',
      attention: '#c5a071',
      destructive: '#c87b78',
      sep: 'rgba(255, 255, 255, 0.08)',
      hover: 'rgba(235, 240, 255, 0.05)'
    }
  },
  {
    id: 'plum',
    name: 'Plum',
    mode: 'dark',
    tokens: {
      bg: '#120f15',
      surface: '#1b1621',
      sidebar: '#16121a',
      text: '#ece8f0',
      'text-2': '#aca2b8',
      'text-3': '#8b8197',
      accent: '#c095d6',
      'accent-soft': 'rgba(192, 149, 214, 0.18)',
      ok: '#90b59a',
      attention: '#c9a173',
      destructive: '#cd7c8a',
      sep: 'rgba(255, 255, 255, 0.08)',
      hover: 'rgba(250, 235, 255, 0.05)'
    }
  },
  {
    id: 'teal',
    name: 'Teal',
    mode: 'dark',
    tokens: {
      bg: '#0b1214',
      surface: '#141c1f',
      sidebar: '#0f1719',
      text: '#e4edee',
      'text-2': '#9fb0b2',
      'text-3': '#7f9194',
      accent: '#79bcc4',
      'accent-soft': 'rgba(121, 188, 196, 0.16)',
      ok: '#8dbfa6',
      attention: '#c5a473',
      destructive: '#c87c76',
      sep: 'rgba(255, 255, 255, 0.08)',
      hover: 'rgba(225, 250, 255, 0.05)'
    }
  },
  {
    id: 'amber',
    name: 'Amber',
    mode: 'dark',
    tokens: {
      bg: '#111110',
      surface: '#1a1917',
      sidebar: '#151413',
      text: '#eae7e1',
      'text-2': '#a9a49a',
      'text-3': '#88847b',
      accent: '#dbb06a',
      'accent-soft': 'rgba(219, 176, 106, 0.18)',
      ok: '#9dbb8f',
      attention: '#d6ae63',
      destructive: '#c87f6d',
      sep: 'rgba(255, 255, 255, 0.08)',
      hover: 'rgba(255, 245, 225, 0.05)'
    }
  },
  {
    id: 'rose',
    name: 'Rose',
    mode: 'dark',
    tokens: {
      bg: '#131013',
      surface: '#1c171b',
      sidebar: '#171316',
      text: '#eee7ea',
      'text-2': '#b0a1a7',
      'text-3': '#8f8187',
      accent: '#dd9dab',
      'accent-soft': 'rgba(221, 157, 171, 0.18)',
      ok: '#93b69c',
      attention: '#c9a478',
      destructive: '#d47f88',
      sep: 'rgba(255, 255, 255, 0.08)',
      hover: 'rgba(255, 235, 240, 0.05)'
    }
  },
  {
    id: 'ice',
    name: 'Ice',
    mode: 'dark',
    tokens: {
      bg: '#0e1114',
      surface: '#161a1f',
      sidebar: '#111519',
      text: '#e6ebef',
      'text-2': '#a4adb5',
      'text-3': '#848d95',
      accent: '#8fb6d6',
      'accent-soft': 'rgba(143, 182, 214, 0.16)',
      ok: '#8bb4a3',
      attention: '#c6a179',
      destructive: '#c97d78',
      sep: 'rgba(255, 255, 255, 0.08)',
      hover: 'rgba(230, 245, 255, 0.05)'
    }
  },
  {
    id: 'day',
    name: 'Day',
    mode: 'light',
    tokens: {
      bg: '#f6f5f2',
      surface: '#ffffff',
      sidebar: '#efeeea',
      text: '#1c1d20',
      'text-2': '#565a61',
      // 4.3:1 against this background was the gate catching a colour that only looked fine.
      'text-3': '#666a72',
      accent: '#37648e',
      'accent-soft': 'rgba(55, 100, 142, 0.12)',
      ok: '#3f6f57',
      attention: '#7d5a24',
      destructive: '#9a3a34',
      sep: 'rgba(0, 0, 0, 0.10)',
      hover: 'rgba(0, 0, 0, 0.05)'
    }
  },
  {
    id: 'paper',
    name: 'Paper',
    mode: 'light',
    tokens: {
      bg: '#f5f1e8',
      surface: '#fffdf7',
      sidebar: '#efe9dc',
      text: '#232019',
      'text-2': '#5b5445',
      'text-3': '#736b5a',
      accent: '#7d5322',
      'accent-soft': 'rgba(125, 83, 34, 0.12)',
      ok: '#43664a',
      attention: '#7a5a1e',
      destructive: '#943a30',
      sep: 'rgba(0, 0, 0, 0.10)',
      hover: 'rgba(0, 0, 0, 0.05)'
    }
  }
]

/** WCAG 2.1 relative luminance, so the app can show the same ratios the gate enforces. */
export function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16))
  const channel = (channelValue: number): number => {
    const srgb = channelValue / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const first = luminance(a)
  const second = luminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/** The worst ratio a theme puts on screen, and which pair it was: what a picker should show. */
export function worstContrast(theme: Theme): { label: string; ratio: number } {
  const t = theme.tokens
  const pairs: Array<[string, string, string]> = [
    ['text on bg', t.text, t.bg],
    ['text on surface', t.text, t.surface],
    ['secondary on bg', t['text-2'], t.bg],
    ['tertiary on bg', t['text-3'], t.bg],
    ['accent on bg', t.accent, t.bg],
    ['accent on surface', t.accent, t.surface],
    ['ok on bg', t.ok, t.bg],
    ['attention on bg', t.attention, t.bg],
    ['destructive on bg', t.destructive, t.bg]
  ]
  return pairs
    .map(([label, foreground, background]) => ({ label, ratio: contrastRatio(foreground, background) }))
    .reduce((low, row) => (row.ratio < low.ratio ? row : low))
}

export function themeById(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

/** Applies a theme by writing the tokens onto the document, which is all `styles.css` reads. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [token, value] of Object.entries(theme.tokens)) root.style.setProperty(`--${token}`, value)
  root.dataset.theme = theme.id
  root.dataset.mode = theme.mode
}

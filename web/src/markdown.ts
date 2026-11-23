import { marked, type Token, type Tokens } from 'marked'
import { highlight } from './highlight'

/**
 * Markdown for the detail pane. Raw HTML in a skill file is dropped rather than passed
 * through: these files come from elsewhere, and the pane must never execute them.
 * Fenced code is coloured by the same tokeniser the script reader uses.
 */

/**
 * A link in a skill file can name any scheme. `javascript:` and `data:` are the two that turn a
 * click into code, so only a scheme a browser can fetch as a page is allowed through; everything
 * else keeps its text and loses its href.
 */
function safeHref(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  // A relative reference has no scheme at all and resolves inside the app.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return /^(https?|mailto):/i.test(value) ? value : ''
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    return '&quot;'
  })
}

function codeHtml(text: string, language: string): string {
  const extension = language ? `.${language.split(/\s+/)[0].toLowerCase()}` : ''
  const tokens = highlight(text, extension)
  const coloured = tokens
    .map((token) => (token.cls ? `<span class="${token.cls}">${escapeHtml(token.text)}</span>` : escapeHtml(token.text)))
    .join('')
  const label = language ? `<span class="md-lang">${escapeHtml(language)}</span>` : ''
  return `<div class="md-code">${label}<pre><code>${coloured}</code></pre></div>`
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html() {
      // Anything that is raw HTML in the source is not trusted output.
      return ''
    },
    code(token: Tokens.Code | string) {
      if (typeof token === 'string') return codeHtml(token, '')
      return codeHtml(token.text, token.lang ?? '')
    },
    link(token: Tokens.Link | string, title?: string | null, text?: string) {
      if (typeof token === 'string') {
        const href = safeHref(token)
        const label = escapeHtml(text ?? token)
        return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${label}</a>` : label
      }
      const href = safeHref(token.href)
      const label = token.text
      return href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener" title="${escapeHtml(token.title ?? '')}">${label}</a>`
        : label
    },
    image(token: Tokens.Image | string) {
      // Relative images inside a package are shown from the package browser instead.
      if (typeof token === 'string') return `<span class="md-img">${escapeHtml(token)}</span>`
      return `<span class="md-img">${escapeHtml(token.text || token.href)}</span>`
    }
  }
})

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string
  // A wide table scrolls on its own instead of stretching the reading measure.
  return html.replace(/<table>/g, '<div class="md-table"><table>').replace(/<\/table>/g, '</table></div>')
}

export type MarkdownToken = Token

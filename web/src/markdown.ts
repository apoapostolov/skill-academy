import { marked, type Token, type Tokens } from 'marked'
import { highlight } from './highlight'

/**
 * Markdown for the detail pane. Raw HTML in a skill file is dropped rather than passed
 * through: these files come from elsewhere, and the pane must never execute them.
 * Fenced code is coloured by the same tokeniser the script reader uses.
 */

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
        const href = escapeHtml(token)
        return `<a href="${href}" target="_blank" rel="noreferrer noopener">${escapeHtml(text ?? token)}</a>`
      }
      const href = escapeHtml(token.href)
      return `<a href="${href}" target="_blank" rel="noreferrer noopener" title="${escapeHtml(token.title ?? '')}">${token.text}</a>`
    },
    image(token: Tokens.Image | string) {
      // Relative images inside a package are shown from the package browser instead.
      if (typeof token === 'string') return `<span class="md-img">${escapeHtml(token)}</span>`
      return `<span class="md-img">${escapeHtml(token.text || token.href)}</span>`
    }
  }
})

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string
}

export type MarkdownToken = Token

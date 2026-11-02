/**
 * A small, dependency-free tokeniser for the languages that appear inside skill
 * packages. It is deliberately not a parser: it colours comments, strings, numbers,
 * keywords and calls so a script reads like code instead of a wall of text.
 */

export type Token = { text: string; cls: string }

type Family = 'js' | 'py' | 'sh' | 'ps1' | 'json' | 'yaml' | 'css' | 'sql' | 'html' | 'toml' | 'plain'

const KEYWORDS: Record<Family, string[]> = {
  js: 'const let var function return if else for while of in new class extends import from export default async await try catch finally throw typeof instanceof delete void switch case break continue null undefined true false this super static get set yield'.split(' '),
  py: 'def class return if elif else for while in not and or is None True False import from as with try except finally raise yield lambda pass break continue global nonlocal assert del async await print'.split(' '),
  sh: 'if then else elif fi for while do done case esac function return local export readonly unset shift source set unset echo cd exit'.split(' '),
  ps1: 'param if else elseif foreach for while do until switch function return try catch finally throw write-host write-output get-childitem set-content get-content new-item remove-item invoke-webrequest export-csv import-csv start-process stop-process test-path join-path'.split(' '),
  json: 'true false null'.split(' '),
  yaml: 'true false null yes no on off'.split(' '),
  css: 'important media import keyframes from to'.split(' '),
  sql: 'select from where insert into values update set delete create table index drop alter join left right inner outer on group by order limit offset as and or not null true false'.split(' '),
  html: 'html head body script style div span class id href src'.split(' '),
  toml: 'true false'.split(' '),
  plain: []
}

const FAMILY_BY_EXT: Record<string, Family> = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.json': 'json',
  '.py': 'py', '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh', '.ps1': 'ps1', '.psm1': 'ps1',
  '.yml': 'yaml', '.yaml': 'yaml', '.css': 'css', '.sql': 'sql', '.html': 'html', '.htm': 'html',
  '.toml': 'toml', '.md': 'plain', '.txt': 'plain'
}

const HASH_COMMENT: Family[] = ['py', 'sh', 'yaml', 'toml']
const SLASH_COMMENT: Family[] = ['js', 'css', 'sql']

export function familyFor(ext: string): Family {
  return FAMILY_BY_EXT[ext.toLowerCase()] ?? 'plain'
}

/** Splits code into coloured tokens. Anything unmatched stays plain text. */
export function highlight(code: string, ext: string): Token[] {
  const family = familyFor(ext)
  const keywords = new Set(KEYWORDS[family])
  const tokens: Token[] = []
  let index = 0

  const push = (text: string, cls: string) => {
    if (!text) return
    const last = tokens[tokens.length - 1]
    if (last && last.cls === cls) last.text += text
    else tokens.push({ text, cls })
  }

  while (index < code.length) {
    const rest = code.slice(index)

    // block comments
    const block = /^\/\*[\s\S]*?\*\//.exec(rest) ?? /^"""[\s\S]*?"""/m.exec(rest) ?? /^'''[\s\S]*?'''/m.exec(rest)
    if (block && (block[0].startsWith('/*') ? SLASH_COMMENT.includes(family) || family === 'js' : true)) {
      push(block[0], 'tok-com')
      index += block[0].length
      continue
    }

    // line comments
    if ((SLASH_COMMENT.includes(family) || family === 'js') && rest.startsWith('//')) {
      const end = rest.indexOf('\n')
      const text = end === -1 ? rest : rest.slice(0, end)
      push(text, 'tok-com')
      index += text.length
      continue
    }
    if (HASH_COMMENT.includes(family) && rest.startsWith('#')) {
      const end = rest.indexOf('\n')
      const text = end === -1 ? rest : rest.slice(0, end)
      push(text, 'tok-com')
      index += text.length
      continue
    }

    // strings
    const quote = /^(`|"|'|"""|''')/.exec(rest)
    if (quote) {
      const mark = quote[0]
      let cursor = mark.length
      while (cursor < rest.length) {
        if (rest[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (rest.startsWith(mark, cursor)) {
          cursor += mark.length
          break
        }
        if (mark.length === 1 && rest[cursor] === '\n') break
        cursor += 1
      }
      push(rest.slice(0, cursor), 'tok-str')
      index += cursor
      continue
    }

    // numbers
    const number = /^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest)
    if (number && !/^\w/.test(rest.slice(number[0].length, number[0].length + 1))) {
      push(number[0], 'tok-num')
      index += number[0].length
      continue
    }

    // words: keyword, call, plain
    const word = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (word) {
      const value = word[0]
      const after = rest.slice(value.length)
      if (keywords.has(value) || keywords.has(value.toLowerCase())) push(value, 'tok-kw')
      else if (/^\s*\(/.test(after)) push(value, 'tok-fn')
      else push(value, '')
      index += value.length
      continue
    }

    // yaml/toml/inf keys at line start
    if ((family === 'yaml' || family === 'toml') && /^[A-Za-z_][\w.-]*(?=\s*[:=])/.test(rest)) {
      const key = /^[A-Za-z_][\w.-]*/.exec(rest)![0]
      push(key, 'tok-key')
      index += key.length
      continue
    }

    push(code[index], '')
    index += 1
  }

  return tokens
}

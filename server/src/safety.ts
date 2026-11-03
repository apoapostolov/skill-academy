import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Risk = 'clean' | 'low' | 'medium' | 'high'

export interface Finding {
  /** Path relative to the package root, as shown to the person reading it. */
  file: string
  /** 1-based line number in that file. */
  line: number
  code: string
  severity: Exclude<Risk, 'clean'>
  /** The matched line, trimmed, so a decision can be made without opening the file. */
  excerpt: string
}

interface Rule {
  code: string
  severity: Exclude<Risk, 'clean'>
  /** What the same match means in prose: never enough on its own to block an enable. */
  prose: Exclude<Risk, 'clean'>
  test: (line: string) => boolean
}

const MAX_FILE_BYTES = 384 * 1024
const MAX_FINDINGS = 40
const MAX_EXCERPT = 160

/**
 * Only files that can execute are scanned. Markdown and YAML are prose about commands, and
 * reading them produced mostly noise: a documentation line showing an install one-liner is
 * not the same act as a script running it. SKILL.md is still read, because its instructions
 * are what an agent obeys, but a match there stays below blocking.
 */
const SCANNED_EXT = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.psm1',
  '.bat',
  '.cmd',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl',
  '.lua'
])

const NETWORK = /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|fetch\(|requests\.(post|get)|urllib)\b/i
const DATA_FLAG = /(\s-d\s|\s--data|-F\s|--form|--upload-file|-T\s|--post-data|--body|-Body\s)/i
const SECRET_PATH =
  /(\.ssh\/id_[a-z0-9]+|id_rsa\b|id_ed25519\b|\.env\b|credentials\.json|\.aws\/credentials|\.netrc|\.npmrc|\.pgpass|login\.keychain)/i
const READ = /\b(cat|less|more|head|tail|cp|scp|readFileSync|read_text|open\(|type\s)\b/i
const REMOTE_HOST = /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[^\s"'`]+/i
const SECRET_VALUE =
  /\$(?:\(|\{)?\s*(cat|type|Get-Content)\b|@[^\s"']+|\$\{?[A-Za-z_]*(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL|COOKIE)[A-Za-z_]*\}?/i
const DOC_EXT = /\.(md|markdown|ya?ml)$/i

/**
 * A pipe one-liner only counts where a command can start: at the beginning of the line,
 * after a separator, or inside a substitution. Text such as "Install: curl ... | bash"
 * inside a docstring is advice, not something the file runs.
 */
const COMMAND_START = /(^\s*(?:[\w.-]*[\/])?(curl|wget|sudo|sh|bash|iex))|([;|&`(]\s*(curl|wget))|(\$\(\s*(curl|wget))/i

export const RULES: Rule[] = [
  {
    // The canonical exfiltration line: file or secret content leaving for a remote host.
    // A POST to localhost, or a body made of ordinary variables, is not this.
    code: 'shell-exfiltration',
    severity: 'high',
    prose: 'medium',
    test: (line) => NETWORK.test(line) && DATA_FLAG.test(line) && REMOTE_HOST.test(line) && SECRET_VALUE.test(line)
  },
  {
    code: 'remote-pipe-execution',
    severity: 'high',
    prose: 'medium',
    test: (line) => COMMAND_START.test(line) && /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/i.test(line)
  },
  {
    code: 'remote-code-evaluation',
    severity: 'high',
    prose: 'medium',
    test: (line) =>
      /\b(eval|Invoke-Expression|iex)\b[^\n]*(\$\(\s*(curl|wget)|\|\s*(curl|wget))/i.test(line) ||
      /\b(iwr|Invoke-WebRequest|curl)\b[^\n]*\|\s*(iex|Invoke-Expression)/i.test(line)
  },
  {
    code: 'encoded-payload-execution',
    severity: 'high',
    prose: 'medium',
    test: (line) => /base64\s+(-d|--decode|-D)\s*\|\s*(ba)?sh/i.test(line) || /FromBase64String[^\n]*\|[^\n]*iex/i.test(line)
  },
  {
    // Only the unrecoverable shapes are high; a scoped recursive delete is attention.
    code: 'destructive-command',
    severity: 'high',
    prose: 'medium',
    test: (line) =>
      /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/i.test(line) ||
      /\b(mkfs(\.\w+)?|dd\s+if=[^\n]*of=\/dev\/)/i.test(line) ||
      /\bformat\s+[a-z]:/i.test(line)
  },
  {
    code: 'scoped-recursive-delete',
    severity: 'medium',
    prose: 'low',
    test: (line) => /Remove-Item[^\n]*-Recurse[^\n]*-Force/i.test(line) || /\brm\s+-[a-z]*r[a-z]*f?\s+\S+/i.test(line)
  },
  {
    code: 'credential-read',
    severity: 'medium',
    prose: 'low',
    test: (line) => SECRET_PATH.test(line) && READ.test(line)
  },
  {
    code: 'privilege-escalation',
    severity: 'medium',
    prose: 'low',
    test: (line) => /\bsudo\s+\w/.test(line) || /Start-Process[^\n]*-Verb\s+RunAs/i.test(line)
  },
  {
    code: 'network-access',
    severity: 'low',
    prose: 'low',
    test: (line) => NETWORK.test(line) && /https?:\/\//i.test(line)
  }
]

const ORDER: Record<Exclude<Risk, 'clean'>, number> = { low: 1, medium: 2, high: 3 }

/** Scans one file's text, keeping the line number of every match. */
export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = []
  const prose = DOC_EXT.test(file)
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.length > 2000) continue
    for (const rule of RULES) {
      if (!rule.test(line)) continue
      findings.push({
        file,
        line: index + 1,
        code: rule.code,
        severity: prose ? rule.prose : rule.severity,
        excerpt: line.trim().slice(0, MAX_EXCERPT)
      })
      break
    }
    if (findings.length >= MAX_FINDINGS) return findings
  }
  return findings
}

export function riskOf(findings: Finding[]): Risk {
  let worst: Exclude<Risk, 'clean'> | null = null
  for (const finding of findings) {
    if (worst === null || ORDER[finding.severity] > ORDER[worst]) worst = finding.severity
  }
  return worst ?? 'clean'
}

const SKIP_DIR = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', 'target', '.skill-academy'])

/**
 * The scan and the file listing are the same walk with two collectors. Doing them apart read every
 * directory twice and re-read `SKILL.md` that the parser had just held in memory, which on a cold
 * scan of two thousand skills is the difference the exit criterion measures.
 */
export function scanAndList(
  dir: string,
  known: Record<string, string> = {}
): { risk: Risk; findings: Finding[]; files: { relative: string; size: number }[] } {
  const findings: Finding[] = []
  const files: { relative: string; size: number }[] = []
  const walk = (current: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (depth < 4 && entry.name !== '.git' && entry.name !== 'node_modules' && files.length < 400) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const relative = path.relative(dir, full).split(path.sep).join('/')
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      if (files.length < 400) files.push({ relative, size })
      // Findings keep their own rules: dotfiles are not read, deep folders are not entered.
      if (findings.length >= MAX_FINDINGS || depth > 3) continue
      if (entry.name.startsWith('.')) continue
      if (SKIP_DIR.has(entry.name)) continue
      if (!SCANNED_EXT.has(path.extname(entry.name).toLowerCase())) continue
      if (size > MAX_FILE_BYTES) continue
      const text = known[relative] ?? (() => {
        try {
          return fs.readFileSync(full, 'utf8')
        } catch {
          return null
        }
      })()
      if (text !== null) findings.push(...scanText(relative, text))
    }
  }
  walk(dir, 0)
  return {
    risk: riskOf(findings),
    findings: findings.slice(0, MAX_FINDINGS),
    files: files.sort((a, b) => a.relative.localeCompare(b.relative))
  }
}

/** Walks a package's own files, never following links out of it. */
export function scanPackage(dir: string): { risk: Risk; findings: Finding[] } {
  const findings: Finding[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > 3 || findings.length >= MAX_FINDINGS) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (findings.length >= MAX_FINDINGS) return
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name)) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const skillText = entry.name === 'SKILL.md' && depth === 0
      if (!skillText && !SCANNED_EXT.has(path.extname(entry.name).toLowerCase())) continue
      try {
        const stat = fs.statSync(full)
        if (stat.size > MAX_FILE_BYTES) continue
        const relative = path.relative(dir, full).split(path.sep).join('/')
        findings.push(...scanText(relative, fs.readFileSync(full, 'utf8')))
      } catch {
        /* an unreadable file is not a finding */
      }
    }
  }
  walk(dir, 0)
  return { risk: riskOf(findings), findings: findings.slice(0, MAX_FINDINGS) }
}

/**
 * The live agent library is not a test bed. Consolidation and curation both write through the same
 * functions the tests use, so a real root is refused unless a run explicitly opts in — the fixture
 * harness (scripts/fixture-check.sh) is the supported way to exercise these paths.
 */
export function protectedRoots(): string[] {
  const home = os.homedir()
  const roots = [path.join(home, '.hermes', 'skills')]
  const hermesHome = process.env.HERMES_HOME
  if (hermesHome) roots.push(path.join(hermesHome, 'skills'))
  if (process.platform === 'win32') roots.push(path.join(home, 'AppData', 'Local', 'hermes', 'skills'))
  return roots.map((root) => path.resolve(root))
}

export function insideProtected(paths: string[]): string | null {
  if (process.env.SKILL_ACADEMY_ALLOW_REAL === '1') return null
  const roots = protectedRoots()
  for (const candidate of paths) {
    const resolved = path.resolve(candidate)
    for (const root of roots) {
      if (resolved === root || resolved.startsWith(root + path.sep)) return resolved
    }
  }
  return null
}

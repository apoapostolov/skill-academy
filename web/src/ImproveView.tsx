import { useCallback, useEffect, useMemo, useState } from 'react'

export interface ImproveFinding {
  rule: string
  severity: 'error' | 'warn' | 'info'
  skill: string
  path: string
  skillId?: number
  detail: string
}

interface RuleMeta {
  id: string
  severity: 'error' | 'warn' | 'info'
  source: string
  why: string
}

interface ImproveReport {
  rules: RuleMeta[]
  findings: ImproveFinding[]
  summary: Record<string, number>
  roots: Array<{ root: string; skills: number; registry: boolean }>
  ms: number
}

const SEV_ORDER: Record<string, number> = { error: 0, warn: 1, info: 2 }

export function ImproveView({
  onSelectSkill,
  onImproveSkill
}: {
  onSelectSkill: (id: number) => void
  onImproveSkill: (id: number, name: string) => void
}) {
  const [report, setReport] = useState<ImproveReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [severity, setSeverity] = useState<'all' | 'error' | 'warn' | 'info'>('all')
  const [rule, setRule] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>('')

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/improve/dry-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const data = (await res.json()) as ImproveReport & { error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setReport(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const findings = useMemo(() => {
    const list = report?.findings ?? []
    const q = query.trim().toLowerCase()
    return list
      .filter((f) => severity === 'all' || f.severity === severity)
      .filter((f) => !rule || f.rule === rule)
      .filter((f) => !q || f.skill.toLowerCase().includes(q) || f.path.toLowerCase().includes(q) || f.detail.toLowerCase().includes(q) || f.rule.includes(q))
      .sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || a.rule.localeCompare(b.rule) || a.skill.localeCompare(b.skill))
  }, [report, severity, rule, query])

  const ruleCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of report?.findings ?? []) m.set(f.rule, (m.get(f.rule) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [report])

  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0 }
    for (const f of report?.findings ?? []) c[f.severity] += 1
    return c
  }, [report])

  const ruleMeta = useMemo(() => {
    const m = new Map<string, RuleMeta>()
    for (const r of report?.rules ?? []) m.set(r.id, r)
    return m
  }, [report])

  const openFinding = (f: ImproveFinding) => {
    const key = `${f.rule}:${f.path}:${f.detail}`
    setSelected(key)
    if (f.skillId) onSelectSkill(f.skillId)
  }

  return (
    <div className="improveview">
      <div className="listhead">
        <span className="listcount">
          {report ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'Improve'}
        </span>
        <div className="listactions">
          <button className="ghost small" disabled={busy} onClick={() => void load()}>{busy ? 'Scanning…' : 'Rescan'}</button>
        </div>
      </div>

      {error && <div className="draftstatus" role="alert">{error}</div>}

      {report && (
        <div className="iv-summary">
          <button className={`iv-sev ${severity === 'all' ? 'on' : ''}`} onClick={() => setSeverity('all')}>
            <span className="iv-sev-count">{report.findings.length}</span><span className="iv-sev-label">all</span>
          </button>
          <button className={`iv-sev error ${severity === 'error' ? 'on' : ''}`} onClick={() => setSeverity(severity === 'error' ? 'all' : 'error')}>
            <span className="iv-sev-count">{counts.error}</span><span className="iv-sev-label">errors</span>
          </button>
          <button className={`iv-sev warn ${severity === 'warn' ? 'on' : ''}`} onClick={() => setSeverity(severity === 'warn' ? 'all' : 'warn')}>
            <span className="iv-sev-count">{counts.warn}</span><span className="iv-sev-label">warnings</span>
          </button>
          <button className={`iv-sev info ${severity === 'info' ? 'on' : ''}`} onClick={() => setSeverity(severity === 'info' ? 'all' : 'info')}>
            <span className="iv-sev-count">{counts.info}</span><span className="iv-sev-label">info</span>
          </button>
        </div>
      )}

      <div className="iv-filters">
        <input
          className="iv-search"
          placeholder="Filter findings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter findings"
          spellCheck={false}
        />
        <select className="iv-rule" value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Filter by rule">
          <option value="">All rules</option>
          {ruleCounts.map(([r, c]) => <option key={r} value={r}>{r} ({c})</option>)}
        </select>
      </div>

      {report && rule && ruleMeta.get(rule) && (
        <div className="iv-rule-note">
          <span className="iv-rule-name">{rule}</span>
          <span className="iv-rule-why">{ruleMeta.get(rule)?.why}</span>
        </div>
      )}

      <div className="iv-list">
        {!report && busy && <div className="empty">Scanning the library…</div>}
        {report && findings.length === 0 && <div className="empty">No findings match.</div>}
        {findings.map((f, i) => {
          const key = `${f.rule}:${f.path}:${f.detail}`
          return (
            <div
              key={key + ':' + i}
              className={`iv-row ${f.severity} ${selected === key ? 'selected' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => openFinding(f)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFinding(f) } }}
            >
              <div className="iv-row-top">
                <span className={`iv-badge ${f.severity}`}>{f.severity}</span>
                <span className="iv-rule-tag">{f.rule}</span>
                <span className="iv-skill">{f.skill}</span>
                {f.skillId && (
                  <button
                    className="ghost small iv-action"
                    onClick={(e) => { e.stopPropagation(); onImproveSkill(f.skillId!, f.skill) }}
                    title="Open AI improve job for this skill"
                  >Improve</button>
                )}
              </div>
              <div className="iv-detail">{f.detail}</div>
              <div className="iv-path" title={f.path}>{f.path.split(/[\\/]/).slice(-3).join('/')}</div>
            </div>
          )
        })}
      </div>

      {report && (
        <div className="iv-foot">
          {report.roots.length} root{report.roots.length === 1 ? '' : 's'} · {report.ms} ms
        </div>
      )}
    </div>
  )
}

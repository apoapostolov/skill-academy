import { useMemo, useState } from 'react'
import type { CurationReport } from './curationTypes'
import { ACTION_LABELS, CLUSTER_HINTS, CLUSTER_LABELS } from './curationTypes'

type Tab = 'ageing' | 'overlap'

/**
 * Curation is a reading surface, not a writer. Nothing here archives anything: an archive is shared
 * by every agent that reads the same root, and the app cannot see who loaded what. Age is the one
 * signal the filesystem actually carries, so it is the one this panel shows.
 */
export function CurationView({
  report,
  busy,
  error,
  onRefresh,
  onOpenSkill
}: {
  report: CurationReport | null
  busy: boolean
  error: string
  onRefresh: () => void
  onOpenSkill: (id: number) => void
}) {
  const [tab, setTab] = useState<Tab>('ageing')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [days, setDays] = useState(90)

  const needle = query.trim().toLowerCase()

  const stale = useMemo(() => {
    return (report?.stale ?? [])
      .filter((row) => row.daysSinceModified >= days)
      .filter((row) => !needle || row.name.toLowerCase().includes(needle) || row.path.toLowerCase().includes(needle))
  }, [report, days, needle])

  const groups = useMemo(() => {
    return (report?.groups ?? [])
      .filter((group) => kind === 'all' || group.kind === kind)
      .filter(
        (group) =>
          !needle ||
          group.key.toLowerCase().includes(needle) ||
          group.evidence.toLowerCase().includes(needle) ||
          group.members.some((member) => member.name.toLowerCase().includes(needle))
      )
  }, [report, kind, needle])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const group of report?.groups ?? []) map.set(group.kind, (map.get(group.kind) ?? 0) + 1)
    return [...map.entries()]
  }, [report])

  const staleAll = report?.stale.length ?? 0

  return (
    <div className="curationview">
      <div className="listhead">
        <span className="listcount">
          {report ? (tab === 'ageing' ? `${stale.length} ageing` : `${groups.length} clusters`) : 'Curation'}
        </span>
        <div className="listactions">
          <button className="ghost small" disabled={busy} onClick={onRefresh}>
            {busy ? 'Reading…' : report ? 'Re-read' : 'Read the library'}
          </button>
        </div>
      </div>

      {error && (
        <div className="draftstatus" role="alert">
          {error}
        </div>
      )}

      <div className="cv-summary">
        <button className={`iv-sev ${tab === 'ageing' ? 'on' : ''}`} onClick={() => setTab('ageing')}>
          <span className="iv-sev-count">{staleAll}</span>
          <span className="iv-sev-label">ageing</span>
        </button>
        <button className={`iv-sev ${tab === 'overlap' ? 'on' : ''}`} onClick={() => setTab('overlap')}>
          <span className="iv-sev-count">{report?.groups.length ?? 0}</span>
          <span className="iv-sev-label">overlap</span>
        </button>
        {tab === 'overlap' &&
          counts.map(([name, count]) => (
            <button
              key={name}
              className={`iv-sev ${kind === name ? 'on' : ''}`}
              onClick={() => setKind(kind === name ? 'all' : name)}
              title={CLUSTER_HINTS[name] ?? name}
            >
              <span className="iv-sev-count">{count}</span>
              <span className="iv-sev-label">{CLUSTER_LABELS[name] ?? name}</span>
            </button>
          ))}
      </div>

      <div className="iv-filters">
        <input
          className="iv-search"
          placeholder={tab === 'ageing' ? 'Filter by name or path' : 'Filter clusters'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter curation"
          spellCheck={false}
        />
        {tab === 'ageing' && (
          <select
            className="iv-rule"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            aria-label="Minimum days since the last edit"
          >
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>1 year</option>
          </select>
        )}
      </div>

      <div className="iv-rule-note">
        {tab === 'ageing'
          ? 'Age is the last edit to the folder. The app cannot see who loaded a skill, so a skill that is old here may still be in daily use: nothing is archived from this list.'
          : CLUSTER_HINTS[kind] ?? 'Deterministic clusters, built from the index. Merging happens in Consolidate, where every write is gated.'}
      </div>

      <div className="iv-list">
        {!report && !busy && <div className="empty">Read the library to see what has aged and what overlaps.</div>}
        {!report && busy && <div className="empty">Reading the index…</div>}

        {report && tab === 'ageing' && stale.length === 0 && (
          <div className="empty">Nothing in this library has gone {days} days without an edit.</div>
        )}
        {tab === 'ageing' &&
          stale.map((row) => (
            <div
              key={row.id}
              className="iv-row"
              role="button"
              tabIndex={0}
              onClick={() => onOpenSkill(row.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpenSkill(row.id)
                }
              }}
            >
              <div className="iv-row-top">
                <span className="iv-badge">{row.daysSinceModified}d</span>
                <span className="iv-skill">{row.name}</span>
              </div>
              <div className="iv-path" title={row.path}>
                {row.path}
              </div>
            </div>
          ))}

        {report && tab === 'overlap' && groups.length === 0 && (
          <div className="empty">No clusters match this filter.</div>
        )}
        {tab === 'overlap' &&
          groups.map((group) => (
            <div key={`${group.kind}:${group.key}`} className="cv-row">
              <div className="cv-row-top">
                <span className="cv-kind">{CLUSTER_LABELS[group.kind] ?? group.kind}</span>
                <span className="cv-name">{group.members[0]?.name ?? group.key}</span>
                <span className="cv-count">{group.members.length}</span>
              </div>
              <div className="cv-members">
                {group.members.slice(0, 6).map((member) => (
                  <button
                    key={member.id}
                    className="cv-member cv-member-btn"
                    onClick={() => onOpenSkill(member.id)}
                    title={member.path}
                  >
                    {member.name}
                  </button>
                ))}
                {group.members.length > 6 ? <span className="cv-member">+{group.members.length - 6}</span> : null}
              </div>
              <div className="cv-evidence">{group.evidence}</div>
              <div className="cv-flag muted">suggested: {ACTION_LABELS[group.action] ?? group.action}</div>
            </div>
          ))}
      </div>

      {report && (
        <div className="iv-foot">
          {report.scanned} skills read · {report.ms} ms
          {report.similar.length > 0 ? ` · ${report.similar.length} close description pairs` : ''}
        </div>
      )}
    </div>
  )
}

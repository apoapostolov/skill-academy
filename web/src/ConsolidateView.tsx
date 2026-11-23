import { useMemo, useState } from 'react'
import type { ConsolidateGroupView, ConsolidateReport } from './consolidateTypes'

export type { ConsolidateGroupView, ConsolidateMemberView, ConsolidatePlan, ConsolidateReport } from './consolidateTypes'

export const KIND_LABELS: Record<string, string> = {
  'near-duplicate': 'Near duplicate',
  'partial-overlap': 'Partial overlap',
  'intentional-family': 'Intentional family',
  'weak-evidence': 'Weak evidence',
  'cross-root-placement': 'Cross-root placement',
  'shape-only': 'Shape only'
}

const KIND_ORDER: Record<string, number> = {
  'near-duplicate': 0,
  'partial-overlap': 1,
  'weak-evidence': 2,
  'shape-only': 3,
  'cross-root-placement': 4,
  'intentional-family': 5
}

/** What each verdict means for the person reading it, in one line. */
export const KIND_HINTS: Record<string, string> = {
  'near-duplicate': 'No unique section. One copy can become a pointer at the other.',
  'partial-overlap': 'The smaller copy owns sections the larger one lacks, so it becomes a router.',
  'intentional-family': 'A router and its children. Architecture, not duplication: nothing is proposed.',
  'weak-evidence': 'Shape matches, evidence does not clear the bar.',
  'cross-root-placement': 'The same skill reachable from more than one root. Placement, not duplication.',
  'shape-only': 'Same section shape, different rules. Two subjects, not one.'
}

export function ConsolidateView({
  report,
  busy,
  error,
  selectedKey,
  onRefresh,
  onSelect
}: {
  report: ConsolidateReport | null
  busy: boolean
  error: string
  selectedKey: string | null
  onRefresh: () => void
  onSelect: (group: ConsolidateGroupView) => void
}) {
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [plannable, setPlannable] = useState(false)

  const all = report?.groups ?? []

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all
      .filter((group) => kind === 'all' || group.mergeType === kind)
      .filter((group) => !plannable || Boolean(group.plan))
      .filter((group) => {
        if (!q) return true
        if (group.key.toLowerCase().includes(q)) return true
        if (group.evidence.toLowerCase().includes(q)) return true
        return group.members.some(
          (member) => member.name.toLowerCase().includes(q) || member.path.toLowerCase().includes(q)
        )
      })
      .sort(
        (a, b) =>
          (KIND_ORDER[a.mergeType] ?? 9) - (KIND_ORDER[b.mergeType] ?? 9) || a.key.localeCompare(b.key)
      )
  }, [all, kind, query, plannable])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const group of all) map.set(group.mergeType, (map.get(group.mergeType) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => (KIND_ORDER[a[0]] ?? 9) - (KIND_ORDER[b[0]] ?? 9))
  }, [all])

  // A plan is what makes a group worth opening. A protected root still lets you read the plan; it
  // only refuses the write, so it must not be counted as nothing-to-do.
  const planned = all.filter((group) => Boolean(group.plan)).length

  return (
    <div className="consolidateview">
      <div className="listhead">
        <span className="listcount">
          {report ? `${groups.length} of ${all.length} group${all.length === 1 ? '' : 's'}` : 'Consolidate'}
        </span>
        <div className="listactions">
          <button className="ghost small" disabled={busy} onClick={onRefresh}>
            {busy ? 'Comparing…' : report ? 'Recompare' : 'Compare'}
          </button>
        </div>
      </div>

      {error && (
        <div className="draftstatus" role="alert">
          {error}
        </div>
      )}

      {report && counts.length > 0 && (
        <div className="cv-summary">
          <button className={`iv-sev ${kind === 'all' ? 'on' : ''}`} onClick={() => setKind('all')}>
            <span className="iv-sev-count">{all.length}</span>
            <span className="iv-sev-label">all</span>
          </button>
          {counts.map(([name, count]) => (
            <button
              key={name}
              className={`iv-sev ${kind === name ? 'on' : ''}`}
              onClick={() => setKind(kind === name ? 'all' : name)}
              title={KIND_HINTS[name] ?? name}
            >
              <span className="iv-sev-count">{count}</span>
              <span className="iv-sev-label">{KIND_LABELS[name] ?? name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="iv-filters">
        <input
          className="iv-search"
          placeholder="Filter by skill, path or evidence"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter consolidation groups"
          spellCheck={false}
        />
        <button
          className={`iv-sev ${plannable ? 'on' : ''}`}
          onClick={() => setPlannable((value) => !value)}
          title="Hide verdicts that carry no plan, such as a router family or a shape-only match"
          aria-pressed={plannable}
        >
          <span className="iv-sev-count">{planned}</span>
          <span className="iv-sev-label">with a plan</span>
        </button>
      </div>

      {kind !== 'all' && KIND_HINTS[kind] && <div className="iv-rule-note">{KIND_HINTS[kind]}</div>}

      <div className="iv-list">
        {!report && !busy && <div className="empty">Compare the library to find copies and overlaps.</div>}
        {!report && busy && <div className="empty">Comparing skill bodies…</div>}
        {report && all.length === 0 && (
          <div className="empty">No copies found. Every skill in this library is unique.</div>
        )}
        {report && all.length > 0 && groups.length === 0 && <div className="empty">No group matches this filter.</div>}
        {groups.map((group) => {
          const writable = !group.liveRoot && !group.blocked && Boolean(group.plan)
          return (
            <div
              key={group.key}
              className={`cv-row ${selectedKey === group.key ? 'selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={selectedKey === group.key}
              onClick={() => onSelect(group)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(group)
                }
              }}
            >
              <div className="cv-row-top">
                <span className={`cv-kind ${group.mergeType}`}>{KIND_LABELS[group.mergeType] ?? group.mergeType}</span>
                <span className="cv-name">{group.plan?.survivor ?? group.members[0]?.name ?? group.key}</span>
                <span className="cv-count">
                  {group.members.length} {group.members.length === 1 ? 'copy' : 'copies'}
                </span>
              </div>
              <div className="cv-members">
                {group.members.map((member) => (
                  <span key={member.path} className="cv-member">
                    {member.name}
                    {member.version ? ` v${member.version}` : ''}
                  </span>
                ))}
              </div>
              <div className="cv-evidence">{group.evidence}</div>
              {group.liveRoot && <div className="cv-flag">live agent library · writes blocked</div>}
              {!group.liveRoot && group.blocked && <div className="cv-flag muted">{group.blocked}</div>}
              {!group.blocked && !writable && group.plan === null && (
                <div className="cv-flag muted">no plan for this verdict</div>
              )}
            </div>
          )
        })}
      </div>

      {report && (
        <div className="iv-foot">
          {report.scanned} skills compared
          {typeof report.roots === 'number' ? ` · ${report.roots} roots` : ''} · {report.ms} ms · {planned}{' '}
          {planned === 1 ? 'group carries a plan' : 'groups carry a plan'}
        </div>
      )}
    </div>
  )
}

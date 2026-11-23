import { useMemo, useState } from 'react'
import type { CheckJob, InstallationView, Overview, Unrecorded } from './versioningTypes'
import { needsAttention, STATE_LABELS, STATE_TONE, stateOf } from './versioningTypes'

const FILTERS = ['all', 'attention', 'behind', 'conflict', 'local-drift', 'up-to-date', 'gone'] as const

function StateDot({ state }: { state: string }) {
  return <span className={`vdot ${STATE_TONE[state] ?? 'quiet'}`} title={STATE_LABELS[state] ?? 'Not checked yet'} />
}

/**
 * The middle column. One row per installation, grouped by the repository it came from, because the
 * repository is the container the user thinks in: three skills from one repo move together.
 */
export function VersioningView({
  overview,
  unrecorded,
  busy,
  note,
  job,
  selectedId,
  onSelect,
  onCheck,
  onAdopt,
  onOpenSources
}: {
  overview: Overview | null
  unrecorded: Unrecorded[]
  busy: string
  note: string
  job: CheckJob | null
  selectedId: number | null
  onSelect: (row: InstallationView) => void
  onCheck: (scope: { repo?: string } | { all: true }) => void
  onAdopt: (row: Unrecorded) => void
  onOpenSources: () => void
}) {
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')

  const repos = overview?.repos ?? []
  const total = repos.reduce((sum, repo) => sum + repo.installations.length, 0)

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const repo of repos) {
      for (const row of repo.installations) {
        const state = stateOf(row)
        map.set(state, (map.get(state) ?? 0) + 1)
      }
    }
    return map
  }, [repos])

  const attention = useMemo(
    () => [...counts.entries()].reduce((sum, [state, count]) => sum + (needsAttention(state) ? count : 0), 0),
    [counts]
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return repos
      .map((repo) => ({
        ...repo,
        installations: repo.installations.filter((row) => {
          const state = stateOf(row)
          if (filter === 'attention' && !needsAttention(state)) return false
          if (filter !== 'all' && filter !== 'attention' && state !== filter) return false
          if (!needle) return true
          return (
            row.name.toLowerCase().includes(needle) ||
            repo.repo.toLowerCase().includes(needle) ||
            row.remote_path.toLowerCase().includes(needle)
          )
        })
      }))
      .filter((repo) => repo.installations.length > 0 || (!query && filter === 'all'))
  }, [repos, filter, query])

  return (
    <div className="versioningview">
      <div className="listhead">
        <span className="listcount">
          {total === 0 ? 'Versioning' : `${attention} need attention of ${total}`}
        </span>
        <div className="listactions">
          <button className="ghost small" disabled={busy === 'check'} onClick={() => onCheck({ all: true })}>
            {busy === 'check' ? `Checking ${job?.checked ?? 0}/${job?.total ?? 0}` : 'Check all'}
          </button>
          <a className="ghost small" href="/api/monitor/export" download>
            Export
          </a>
        </div>
      </div>

      {note && (
        <div className="draftstatus" role="alert">
          {note}
        </div>
      )}

      {total > 0 && (
        <div className="cv-summary">
          {FILTERS.map((name) => {
            const count = name === 'all' ? total : name === 'attention' ? attention : counts.get(name) ?? 0
            if (name !== 'all' && name !== 'attention' && count === 0) return null
            return (
              <button
                key={name}
                className={`iv-sev ${filter === name ? 'on' : ''}`}
                onClick={() => setFilter(name)}
                aria-pressed={filter === name}
              >
                <span className="iv-sev-count">{count}</span>
                <span className="iv-sev-label">
                  {name === 'all' ? 'all' : name === 'attention' ? 'attention' : STATE_LABELS[name] ?? name}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="iv-filters">
        <input
          className="iv-search"
          placeholder="Filter by skill, repository or path"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter installations"
          spellCheck={false}
        />
      </div>

      <div className="iv-list">
        {!overview && <div className="empty">Reading the installations…</div>}

        {overview && total === 0 && (
          <div className="empty">
            Nothing is recorded from a repository yet.
            <button className="ghost small vempty-action" onClick={onOpenSources}>
              Open Sources
            </button>
          </div>
        )}

        {overview && total > 0 && visible.length === 0 && <div className="empty">No installation matches this filter.</div>}

        {visible.map((repo) => (
          <div className="vrepo" key={repo.repo}>
            <div className="vrepo-head">
              <button
                className="vrepo-name"
                onClick={() => onCheck({ repo: repo.repo })}
                disabled={busy === 'check'}
                title="Check every installation from this repository"
              >
                {repo.repo}
              </button>
              <span className="vrepo-count">
                {repo.changed} of {repo.installations.length} changed
              </span>
            </div>
            {repo.installations.map((row) => {
              const state = stateOf(row)
              return (
                <div
                  key={row.id}
                  className={`vrow ${selectedId === row.id ? 'selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedId === row.id}
                  onClick={() => onSelect(row)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelect(row)
                    }
                  }}
                >
                  <StateDot state={state} />
                  <span className="vrow-name">{row.name}</span>
                  {row.pin_ref && (
                    <span className="vrow-pin" title={row.pin_note ?? 'Pinned, so updates are refused'}>
                      pinned
                    </span>
                  )}
                  <span className="vrow-ver">
                    {row.version ?? 'no version'}
                    {row.last_remote_ref && row.last_remote_ref !== row.ref ? ' · ahead' : ''}
                  </span>
                  <span className="vrow-state">{STATE_LABELS[state] ?? 'Not checked'}</span>
                </div>
              )
            })}
          </div>
        ))}

        {unrecorded.length > 0 && (
          <div className="vrepo">
            <div className="vrepo-head">
              <span className="vrepo-name">Without a baseline</span>
              <span className="vrepo-count">{unrecorded.length}</span>
            </div>
            {unrecorded.map((row) => (
              <div className="vrow plain" key={row.path}>
                <StateDot state="unchecked" />
                <span className="vrow-name">{row.name}</span>
                <span className="vrow-state" title={row.reason}>
                  {row.repo ?? 'no repository found'}
                </span>
                <button
                  className="ghost small"
                  disabled={busy === 'adopt' || !row.repo}
                  onClick={() => onAdopt(row)}
                  title={row.repo ? 'Record where this copy came from' : row.reason}
                >
                  Record
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {overview && (
        <div className="iv-foot">
          {total} installation{total === 1 ? '' : 's'}
          {overview.rateLimit.remaining !== null
            ? ` · GitHub ${overview.rateLimit.remaining}/${overview.rateLimit.limit} left`
            : ''}
          {overview.events.length > 0 ? ` · ${overview.events.length} event${overview.events.length === 1 ? '' : 's'}` : ''}
        </div>
      )}
    </div>
  )
}

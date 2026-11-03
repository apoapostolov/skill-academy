import { useEffect, useState } from 'react'

/**
 * Sources are where skills come from: a GitHub repository, or a checkout on this machine. A source
 * is checked (what commit is it on?), mapped (which folders hold skills?), planned (what would
 * change) and only then applied. Every step is separate on purpose.
 */

interface SourceRow {
  id: number
  repo: string
  kind: 'github' | 'local' | 'zip'
  added_at: string
  last_commit: string | null
  last_release: string | null
  checked_at: string | null
}

interface PlanFile {
  path: string
  status: number
  hash: string | null
  bytes: number
}

interface Plan {
  planId: string
  from: { commit: string | null; release: string | null }
  to: { commit: string | null; release: string | null }
  changes: Array<{ kind: string; from: string | null; to: string | null }>
  files: PlanFile[]
}

interface EventRow {
  id: number
  repo: string
  kind: string
  value: string
  seen_at: string
}

export function SourcesDialog({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<SourceRow[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [kind, setKind] = useState<'github' | 'local' | 'zip'>('local')
  const [entry, setEntry] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [mapping, setMapping] = useState<Record<number, string>>({})
  const [plan, setPlan] = useState<{ sourceId: number; plan: Plan } | null>(null)
  const [conflict, setConflict] = useState<{
    edited: Array<{ name: string; path: string; changed: Array<{ file: string; state: string }> }>
  } | null>(null)

  const load = async (): Promise<void> => {
    const [sourceResponse, eventResponse] = await Promise.all([fetch('/api/sources'), fetch('/api/sources/events')])
    const sourceData = (await sourceResponse.json()) as { sources?: SourceRow[] }
    const eventData = (await eventResponse.json()) as { events?: EventRow[] }
    setSources(sourceData.sources ?? [])
    setEvents(eventData.events ?? [])
    setMapping((current) => {
      const next = { ...current }
      for (const source of sourceData.sources ?? []) next[source.id] ??= ''
      return next
    })
  }

  useEffect(() => {
    void load()
  }, [])

  const add = async (): Promise<void> => {
    if (!entry.trim()) return
    setBusy(true)
    setNote('')
    try {
      const response = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          kind === 'local'
            ? { path: entry.trim(), kind: 'local' }
            : kind === 'zip'
              ? { url: entry.trim(), kind: 'zip' }
              : { repo: entry.trim(), kind: 'github' }
        )
      })
      const data = (await response.json()) as { source?: SourceRow; error?: string; detail?: string; branch?: string }
      if (data.error) {
        setNote(`${data.error}${data.detail ? ' — ' + data.detail : ''}`)
        return
      }
      setEntry('')
      setNote(data.branch ? `added on ${data.branch}` : 'added')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const check = async (source: SourceRow): Promise<void> => {
    setBusy(true)
    setNote('')
    try {
      const response = await fetch(`/api/sources/${source.id}/check`, { method: 'POST' })
      const data = (await response.json()) as { commit?: string; release?: string | null; changed?: boolean; error?: string }
      setNote(data.error ? data.error : `${data.commit ?? 'no commit'}${data.release ? ' · ' + data.release : ''}${data.changed ? ' · changed' : ''}`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const saveMap = async (source: SourceRow): Promise<void> => {
    const skills = (mapping[source.id] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    setBusy(true)
    try {
      const response = await fetch(`/api/sources/${source.id}/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skills })
      })
      const data = (await response.json()) as { skills?: string[]; error?: string }
      setNote(data.error ?? `${data.skills?.length ?? 0} path(s) mapped`)
    } finally {
      setBusy(false)
    }
  }

  const makePlan = async (source: SourceRow): Promise<void> => {
    setBusy(true)
    setNote('')
    try {
      const response = await fetch(`/api/sources/${source.id}/plan-update`, { method: 'POST' })
      const data = (await response.json()) as Plan & { error?: string }
      if (data.error) {
        setNote(data.error)
        return
      }
      setPlan({ sourceId: source.id, plan: data })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const apply = async (replace: boolean, force = false): Promise<void> => {
    if (!plan) return
    setBusy(true)
    setNote('')
    try {
      const response = await fetch(`/api/sources/${plan.sourceId}/apply-update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: plan.plan.planId, confirm: true, replace, force })
      })
      const data = (await response.json()) as {
        staged?: string[]
        replaced?: unknown[]
        error?: string
        edited?: Array<{ name: string; path: string; changed: Array<{ file: string; state: string }> }>
      }
      if (data.error === 'local-edit') {
        setConflict({ edited: data.edited ?? [] })
        setNote('')
        return
      }
      setNote(
        data.error
          ? data.error
          : `${data.staged?.length ?? 0} file(s) staged${replace ? `, ${data.replaced?.length ?? 0} package(s) replaced` : ''}`
      )
      if (replace) {
        setPlan(null)
        setConflict(null)
      }
      await load()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (source: SourceRow): Promise<void> => {
    await fetch(`/api/sources/${source.id}`, { method: 'DELETE' })
    setPlan((current) => (current?.sourceId === source.id ? null : current))
    await load()
  }

  return (
    <div className="sourcesdlg">
      <div className="sdhead">
        <div>
          <div className="mergetitle">Sources</div>
          <div className="mergesub">
            A repository, or a checkout on this machine. Checking reads the commit; a plan says what would change; applying
            stages the files, and replacing puts the package in the library.
          </div>
        </div>
        <button className="ghost small" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="sdadd">
        <div className="seg" role="group" aria-label="Source kind">
          {(
            [
              ['local', 'Local checkout'],
              ['github', 'GitHub repo'],
              ['zip', 'Zip from a URL']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`segbtn ${kind === key ? 'on' : ''}`}
              aria-pressed={kind === key}
              onClick={() => setKind(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          placeholder={kind === 'local' ? 'C:\\git\\my-skills' : 'owner/name'}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add()
          }}
        />
        <button className="mergeapply" disabled={busy || !entry.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>

      {note && <div className="draftstatus">{note}</div>}

      {conflict && (
        <div className="sdconflict">
          <div className="mergetitle">The library copy changed here</div>
          <div className="mergesub">
            These files are not what the source left behind. Replacing now would overwrite that work, so it is refused until
            you say otherwise.
          </div>
          {conflict.edited.map((entry) => (
            <div className="sdconflictrow" key={entry.name}>
              <span className="sdname">{entry.name}</span>
              <span className="sdbytes">{entry.changed.map((change) => `${change.file} ${change.state}`).join(' · ')}</span>
            </div>
          ))}
          <div className="sdactions">
            <button className="mergeapply" disabled={busy} onClick={() => void apply(true, true)}>
              Replace anyway
            </button>
            <button className="ghost small" onClick={() => setConflict(null)}>
              Keep my copy
            </button>
          </div>
        </div>
      )}

      {sources.length === 0 && <div className="empty">No sources yet.</div>}

      {sources.map((source) => (
        <div className="sdcard" key={source.id}>
          <div className="sdrowtitle">
            <span className="sdname" title={source.repo}>
              {source.repo}
            </span>
            <span className={`wspill ${source.kind === 'local' ? 'same' : 'workspace-only'}`}>{source.kind}</span>
            <button className="ghost small" onClick={() => void remove(source)} title="Remove this source">
              Remove
            </button>
          </div>
          <div className="sdmeta">
            {source.last_commit ?? 'not checked'}
            {source.last_release ? ` · ${source.last_release}` : ''}
            {source.checked_at ? ` · checked ${new Date(source.checked_at).toLocaleTimeString()}` : ''}
          </div>
          <div className="sdactions">
            <button className="ghost small" disabled={busy} onClick={() => void check(source)}>
              Check
            </button>
            <button className="ghost small" disabled={busy} onClick={() => void makePlan(source)}>
              Plan update
            </button>
          </div>
          <div className="sdmap">
            <input
              value={mapping[source.id] ?? ''}
              onChange={(event) => setMapping((current) => ({ ...current, [source.id]: event.target.value }))}
              placeholder="skills/ask-matt, skills/other"
            />
            <button className="ghost small" disabled={busy} onClick={() => void saveMap(source)}>
              Map
            </button>
          </div>
        </div>
      ))}

      {plan && (
        <div className="sdplan">
          <div className="mergetitle">Plan · source {plan.sourceId}</div>
          <div className="sdmeta">
            {plan.plan.from.commit ?? '—'} → {plan.plan.to.commit ?? '—'}
            {plan.plan.to.release ? ` · ${plan.plan.to.release}` : ''}
          </div>
          {plan.plan.changes.length ? (
            plan.plan.changes.map((change) => (
              <div className="sdchange" key={`${change.kind}-${change.to}`}>
                <span className="wsdlabel">{change.kind}</span>
                <code className="wsdhash">
                  {change.from ?? '—'} → {change.to ?? '—'}
                </code>
              </div>
            ))
          ) : (
            <div className="mergenote">No commit or release change since the last check.</div>
          )}
          {plan.plan.files.map((file) => (
            <div className="sdchange" key={file.path}>
              <span className="wsdlabel">{file.status === 200 ? 'present' : file.status}</span>
              <code className="wsdhash">{file.path}</code>
              <span className="sdbytes">{file.bytes} file(s)</span>
            </div>
          ))}
          <div className="sdactions">
            <button className="ghost small" disabled={busy} onClick={() => void apply(false)}>
              Stage files
            </button>
            <button className="mergeapply" disabled={busy} onClick={() => void apply(true)}>
              Replace in library
            </button>
            <button className="ghost small" onClick={() => setPlan(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="sdevents">
          <div className="wstitle">Events</div>
          {events.slice(0, 8).map((event) => (
            <div className="sdchange" key={event.id}>
              <span className="wsdlabel">{event.kind}</span>
              <code className="wsdhash">{event.value}</code>
              <span className="sdbytes">{event.repo.length > 48 ? event.repo.slice(0, 46) + '…' : event.repo}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

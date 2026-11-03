import { useCallback, useEffect, useMemo, useState } from 'react'

/* ---------------------------------- types ---------------------------------- */

interface DriftReport {
  localChanged: string[]
  localAdded: string[]
  localRemoved: string[]
}

interface InstallationView {
  id: number
  repo: string
  remote_path: string
  name: string
  ref: string
  tag: string | null
  installed_at: string
  version: string | null
  library_path: string
  pin_ref: string | null
  pin_note: string | null
  baseline_lost: number
  policy_channel: 'release' | 'head' | 'pinned'
  policy_auto: 'off' | 'notify' | 'apply-minor' | 'apply-any'
  last_check_at: string | null
  last_state: string | null
  last_remote_ref: string | null
  drift: DriftReport
  hasLocalEdits: boolean
}

interface RepoView {
  repo: string
  installations: InstallationView[]
  states: Record<string, number>
  changed: number
  watched: boolean
}

interface MonitorEvent {
  id: number
  installation_id: number | null
  repo: string
  kind: string
  summary: string
  severity: 'info' | 'attention' | 'destructive'
  seen_at: string
  acknowledged: number
}

interface Overview {
  repos: RepoView[]
  events: MonitorEvent[]
  rateLimit: { remaining: number | null; limit: number | null; resetAt: string | null }
}

interface DiffFileRow {
  path: string
  remotePath?: string | null
  status: 'same' | 'changed' | 'added' | 'removed' | 'moved' | 'local-changed' | 'local-added' | 'local-removed'
  installedBytes: number | null
  remoteBytes: number | null
  movedFrom?: string
}

interface DiffLine {
  kind: 'same' | 'add' | 'del'
  left: number | null
  right: number | null
  text: string
}

interface FileDiff {
  path: string
  status: string
  binary: boolean
  tooLarge: boolean
  normalised: boolean
  additions: number
  deletions: number
  lines: DiffLine[]
  note?: string
}

interface Plan {
  planId: string
  fromRef: string
  toRef: string
  targetKind: string
  fileCount: number
  additions: number
  deletions: number
  versionFrom: string | null
  versionTo: string | null
  gate: { required: boolean; reasons: string[] }
  refusals: string[]
  drift: DriftReport
  localChoiceRequired: boolean
  expiresAt: string
}

interface Job {
  id: string
  status: 'running' | 'done' | 'failed'
  checked: number
  total: number
  events: number
  requests: number
  error?: string
}

interface Unrecorded {
  name: string
  path: string
  repo: string | null
  remotePath: string | null
  ref: string | null
  reason: string
}

async function post<T>(url: string, body: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, data: (await response.json()) as T }
}

function stateGlyph(state: string | null): string {
  if (state === 'behind') return '↓'
  if (state === 'conflict') return '≠'
  if (state === 'local-drift') return '✎'
  if (state === 'unreachable') return '!'
  if (state === 'gone') return '×'
  if (state === 'up-to-date') return '·'
  return '?'
}

function statusGlyph(status: string): string {
  if (status === 'added') return '+'
  if (status === 'removed') return '−'
  if (status === 'moved') return '→'
  if (status === 'changed') return '~'
  if (status.startsWith('local-')) return '✎'
  return '·'
}

/* -------------------------------- component -------------------------------- */

export default function Versioning({ onClose }: { onClose: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [unrecorded, setUnrecorded] = useState<Unrecorded[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [selectedInstallation, setSelectedInstallation] = useState<number | null>(null)
  const [tab, setTab] = useState<'overview' | 'files' | 'plan' | 'history'>('overview')
  const [files, setFiles] = useState<DiffFileRow[] | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null)
  const [diffSource, setDiffSource] = useState<'remote' | 'local'>('remote')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [job, setJob] = useState<Job | null>(null)
  const [confirmGate, setConfirmGate] = useState(false)
  const [takeUpstream, setTakeUpstream] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/monitor')
    const data = (await response.json()) as Overview
    setOverview(data)
    const orphan = await fetch('/api/monitor/unrecorded')
    const orphanData = (await orphan.json()) as { rows: Unrecorded[] }
    setUnrecorded(orphanData.rows ?? [])
    if (!selectedRepo && data.repos.length) setSelectedRepo(data.repos[0].repo)
  }, [selectedRepo])

  useEffect(() => {
    void load()
  }, [])

  const repo = useMemo(
    () => overview?.repos.find((entry) => entry.repo === selectedRepo) ?? null,
    [overview, selectedRepo]
  )

  const installation = useMemo(() => {
    if (!repo) return null
    const byId = repo.installations.find((entry) => entry.id === selectedInstallation)
    return byId ?? repo.installations[0] ?? null
  }, [repo, selectedInstallation])

  const loadFiles = useCallback(async () => {
    if (!installation) return
    setBusy('diff')
    setFileDiff(null)
    try {
      const response = await fetch(`/api/monitor/installation/${installation.id}/diff?level=tree`)
      const data = (await response.json()) as {
        files?: DiffFileRow[]
        local?: DiffFileRow[]
        target?: string
        error?: string
      }
      if (data.error) {
        setNote(data.error)
        setFiles([])
      } else {
        const upstream = (data.files ?? []).filter((file) => file.status !== 'same')
        setFiles([...upstream, ...(data.local ?? [])])
        setTarget(data.target ?? null)
        setNote('')
      }
    } finally {
      setBusy('')
    }
  }, [installation])

  useEffect(() => {
    setFiles(null)
    setPlan(null)
    setFileDiff(null)
    setNote('')
    if (tab === 'files') void loadFiles()
  }, [installation?.id, tab])

  async function runCheck(): Promise<void> {
    setBusy('check')
    setNote('')
    const scope = selectedRepo ? { repo: selectedRepo } : { all: true }
    const started = await post<{ job?: Job; error?: string; detail?: string }>('/api/monitor/check', scope)
    if (!started.data.job) {
      setNote(started.data.detail ?? started.data.error ?? 'the check could not start')
      setBusy('')
      return
    }
    let current = started.data.job
    setJob(current)
    for (let attempt = 0; attempt < 120 && current.status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const polled = await fetch(`/api/monitor/job/${current.id}`)
      const data = (await polled.json()) as { job?: Job }
      if (data.job) current = data.job
      setJob(current)
    }
    setBusy('')
    await load()
    if (tab === 'files') await loadFiles()
  }

  async function openFile(path: string, status?: string): Promise<void> {
    if (!installation) return
    // A file upstream left alone is worth reading against the local copy, which is the only side
    // that changed.
    const source = status?.startsWith('local-') ? 'local' : diffSource
    if (source !== diffSource) setDiffSource(source)
    setBusy('file')
    try {
      const response = await fetch(
        `/api/monitor/installation/${installation.id}/diff?level=file&path=${encodeURIComponent(path)}&source=${source}`
      )
      const data = (await response.json()) as { diff?: FileDiff; error?: string }
      setFileDiff(data.diff ?? null)
      if (data.error) setNote(data.error)
    } finally {
      setBusy('')
    }
  }

  async function makePlan(): Promise<void> {
    if (!installation) return
    setBusy('plan')
    setConfirmGate(false)
    setTakeUpstream(false)
    try {
      const result = await post<{ plan?: Plan; error?: string; detail?: unknown }>(
        `/api/monitor/installation/${installation.id}/plan`,
        {}
      )
      if (result.data.plan) {
        setPlan(result.data.plan)
        setTab('plan')
        setNote('')
      } else {
        setNote(`${result.data.error ?? 'no plan'}: ${JSON.stringify(result.data.detail ?? '')}`)
      }
    } finally {
      setBusy('')
    }
  }

  async function applyPlan(): Promise<void> {
    if (!installation || !plan) return
    setBusy('update')
    try {
      const result = await post<{ result?: { files: number; ref: string; trashed: string | null }; error?: string; detail?: unknown }>(
        `/api/monitor/installation/${installation.id}/update`,
        { planId: plan.planId, confirm: true, choice: takeUpstream ? 'take-upstream' : undefined }
      )
      if (result.data.result) {
        setNote(`updated ${result.data.result.files} file(s) at ${result.data.result.ref.slice(0, 8)}${result.data.result.trashed ? `, previous copy in the trash` : ''}`)
        setPlan(null)
        await load()
        if (tab === 'files') await loadFiles()
      } else {
        setNote(`${result.data.error ?? 'update refused'}: ${JSON.stringify(result.data.detail ?? '')}`)
      }
    } finally {
      setBusy('')
    }
  }

  async function pin(ref: string | null): Promise<void> {
    if (!installation) return
    setBusy('pin')
    try {
      await post(`/api/monitor/installation/${installation.id}/pin`, { ref })
      await load()
    } finally {
      setBusy('')
    }
  }

  async function setChannel(channel: 'release' | 'head', auto: 'off' | 'notify'): Promise<void> {
    if (!installation) return
    setBusy('policy')
    try {
      await post(`/api/monitor/installation/${installation.id}/policy`, { channel, auto })
      await load()
    } finally {
      setBusy('')
    }
  }

  async function adopt(row: Unrecorded): Promise<void> {
    setBusy('adopt')
    try {
      const result = await post<{ id?: number; error?: string; detail?: unknown }>('/api/monitor/adopt', {
        path: row.path,
        repo: row.repo,
        remotePath: row.remotePath,
        ref: row.ref ?? undefined
      })
      if (result.data.error) setNote(`${result.data.error}: ${JSON.stringify(result.data.detail)}`)
      await load()
    } finally {
      setBusy('')
    }
  }

  async function acknowledgeAll(): Promise<void> {
    const ids = (overview?.events ?? []).map((event) => event.id)
    if (!ids.length) return
    await post('/api/monitor/events/ack', { ids })
    await load()
  }

  const states = repo?.states ?? {}

  return (
    <div className="installscrim" onClick={onClose}>
      <div className="installmodal monitormodal" onClick={(event) => event.stopPropagation()}>
        <div className="imhead">
          <span>
            Versioning
            {job && job.status === 'running' ? ` · checking ${job.checked}/${job.total}` : ''}
          </span>
          <span className="monheadtools">
            <button className="btn" disabled={busy === 'check'} onClick={() => void runCheck()}>
              {busy === 'check' ? 'Checking…' : 'Check'}
            </button>
            <a className="btn ghost" href="/api/monitor/export" download>
              Export
            </a>
            <button className="iconbtn crossbtn" aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        </div>

        <div className="monbody">
          <aside className="monlist">
            {(overview?.repos ?? []).map((row) => (
              <div key={row.repo} className="monrepoblock">
                <button
                  className={`monrepo${row.repo === selectedRepo ? ' on' : ''}`}
                  onClick={() => {
                    setSelectedRepo(row.repo)
                    setSelectedInstallation(null)
                  }}
                >
                  <span className="monreponame">{row.repo}</span>
                  <span className="monrepocount">{row.installations.length}</span>
                  {row.changed > 0 && <span className="monrepodirty">{row.changed}</span>}
                </button>
                {row.repo === selectedRepo &&
                  row.installations.map((entry) => (
                    <button
                      key={entry.id}
                      className={`moninst${installation?.id === entry.id ? ' on' : ''}`}
                      onClick={() => setSelectedInstallation(entry.id)}
                      title={`${entry.remote_path} · ${entry.ref.slice(0, 8)}`}
                    >
                      <span className="monglyph" data-state={entry.last_state ?? 'unknown'}>
                        {stateGlyph(entry.last_state)}
                      </span>
                      <span className="moninstname">{entry.name}</span>
                      <span className="moninstver">{entry.version ?? '—'}</span>
                    </button>
                  ))}
              </div>
            ))}
            {!overview?.repos.length && <div className="monempty">Nothing is installed from a repository yet.</div>}
            {unrecorded.length > 0 && (
              <div className="monrepoblock">
                <div className="monrepo plain">Without a baseline</div>
                {unrecorded.map((row) => (
                  <div className="moninst plain" key={row.path} title={row.reason}>
                    <span className="monglyph" data-state="unknown">
                      ?
                    </span>
                    <span className="moninstname">{row.name}</span>
                    <button className="monadopt" disabled={busy === 'adopt'} onClick={() => void adopt(row)}>
                      Record
                    </button>
                  </div>
                ))}
              </div>
            )}
          </aside>

          <section className="monmain">
            <div className="montabs">
              {(['overview', 'files', 'plan', 'history'] as const).map((entry) => (
                <button key={entry} className={`montab${tab === entry ? ' on' : ''}`} onClick={() => setTab(entry)}>
                  {entry === 'overview' ? 'Overview' : entry === 'files' ? 'Files' : entry === 'plan' ? 'Update' : 'History'}
                  {entry === 'history' && overview?.events.length ? ` ${overview.events.length}` : ''}
                  {entry === 'files' && files ? ` ${files.length}` : ''}
                </button>
              ))}
              {installation && (
                <span className="monactions">
                  <button className="btn ghost" disabled={busy === 'plan'} onClick={() => void makePlan()}>
                    Plan update
                  </button>
                  <button
                    className="btn ghost"
                    disabled={busy === 'pin' || installation.policy_channel === 'pinned'}
                    onClick={() => void pin(installation.pin_ref ? null : installation.last_remote_ref ?? installation.ref)}
                  >
                    {installation.pin_ref ? 'Unpin' : 'Pin at installed ref'}
                  </button>
                </span>
              )}
            </div>

            {note && <div className="monnote">{note}</div>}

            {tab === 'overview' && (
              <div className="monpane">
                {repo && !installation && (
                  <div className="moncard">
                    <div className="moncardhead">{repo.repo}</div>
                    <div className="moncardrows">
                      <span>installations {repo.installations.length}</span>
                      <span>changed {repo.changed}</span>
                      {Object.entries(states).map(([state, count]) => (
                        <span key={state}>
                          {state} {count}
                        </span>
                      ))}
                      <span>
                        rate limit {overview?.rateLimit.remaining ?? '—'}/{overview?.rateLimit.limit ?? '—'}
                      </span>
                    </div>
                  </div>
                )}
                {installation && (
                  <div className="moncard">
                    <div className="moncardhead">
                      {installation.repo} / {installation.remote_path}
                    </div>
                    <div className="moncardrows">
                      <span>installed {installation.ref.slice(0, 8)}</span>
                      <span>remote {installation.last_remote_ref?.slice(0, 8) ?? '—'}</span>
                      <span>version {installation.version ?? '—'}</span>
                      <span>checked {installation.last_check_at ? new Date(installation.last_check_at).toLocaleTimeString() : 'never'}</span>
                      <span>state {installation.last_state ?? 'unknown'}</span>
                      <span>channel {installation.policy_channel}</span>
                      {installation.pin_ref && <span>pinned {installation.pin_ref.slice(0, 8)}</span>}
                      {installation.baseline_lost ? <span className="warn">baseline recorded after the fact</span> : null}
                    </div>
                    <div className="moncardrows">
                      <button className="btn ghost" onClick={() => void setChannel(installation.policy_channel === 'head' ? 'release' : 'head', 'off')}>
                        follow {installation.policy_channel === 'head' ? 'releases' : 'the branch head'}
                      </button>
                      <span className={`monstate ${installation.last_state ?? ''}`}>{installation.last_state ?? 'unknown'}</span>
                    </div>
                    {installation.hasLocalEdits && (
                      <div className="moncardrows warn">
                        local edits: {installation.drift.localChanged.length} changed, {installation.drift.localAdded.length} added,{' '}
                        {installation.drift.localRemoved.length} removed
                      </div>
                    )}
                  </div>
                )}
                {!repo && <div className="monempty">Select a repository on the left.</div>}
              </div>
            )}

            {tab === 'files' && (
              <div className="monpane">
                {!files && <div className="monempty">{busy === 'diff' ? 'Comparing…' : 'Open this tab to compare.'}</div>}
                {files && !files.length && <div className="monempty">No file differs from {target?.slice(0, 8) ?? 'the target'}.</div>}
                {files?.map((file) => (
                  <button key={file.path} className="monfile" onClick={() => void openFile(file.path, file.status)}>
                    <span className="mondiffglyph" data-status={file.status}>
                      {statusGlyph(file.status)}
                    </span>
                    <span className="monfilepath">{file.path}</span>
                    {file.movedFrom && <span className="monfilemove">from {file.movedFrom}</span>}
                    {file.status.startsWith('local-') && <span className="monfilemove">your edit</span>}
                    <span className="monfilesize">
                      {file.installedBytes ?? '—'} → {file.remoteBytes ?? '—'}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {tab === 'plan' && (
              <div className="monpane">
                {!plan && <div className="monempty">No plan yet. “Plan update” reads the target ref and counts what would move.</div>}
                {plan && (
                  <div className="moncard">
                    <div className="moncardhead">
                      {plan.fromRef.slice(0, 8)} → {plan.toRef.slice(0, 8)} · {plan.targetKind}
                    </div>
                    <div className="moncardrows">
                      <span>{plan.fileCount} file(s)</span>
                      <span>+{plan.additions} / −{plan.deletions} lines</span>
                      <span>
                        version {plan.versionFrom ?? '—'} → {plan.versionTo ?? '—'}
                      </span>
                      <span>expires {new Date(plan.expiresAt).toLocaleTimeString()}</span>
                    </div>
                    {plan.gate.required && (
                      <div className="moncardrows warn">
                        gate: {plan.gate.reasons.join('; ')}
                        <label className="moncheck">
                          <input type="checkbox" checked={confirmGate} onChange={(event) => setConfirmGate(event.target.checked)} />
                          I read the plan
                        </label>
                      </div>
                    )}
                    {plan.localChoiceRequired && (
                      <div className="moncardrows warn">
                        local edits would be replaced
                        <label className="moncheck">
                          <input type="checkbox" checked={takeUpstream} onChange={(event) => setTakeUpstream(event.target.checked)} />
                          take upstream and keep my copy in the trash
                        </label>
                      </div>
                    )}
                    <div className="moncardrows">
                      <button
                        className="btn"
                        disabled={busy === 'update' || (plan.gate.required && !confirmGate) || (plan.localChoiceRequired && !takeUpstream)}
                        onClick={() => void applyPlan()}
                      >
                        {busy === 'update' ? 'Updating…' : 'Update now'}
                      </button>
                      <span className="monmuted">the previous copy is archived first</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'history' && (
              <div className="monpane">
                <div className="moncardrows">
                  <button className="btn ghost" onClick={() => void acknowledgeAll()}>
                    Acknowledge all
                  </button>
                </div>
                {(overview?.events ?? []).map((event) => (
                  <div key={event.id} className="monevent" data-severity={event.severity}>
                    <span className="moneventkind">{event.kind}</span>
                    <span className="moneventrepo">{event.repo}</span>
                    <span className="moneventsummary">{event.summary}</span>
                    <span className="moneventtime">{new Date(event.seen_at).toLocaleString()}</span>
                  </div>
                ))}
                {!overview?.events.length && <div className="monempty">No events.</div>}
              </div>
            )}
          </section>

          <aside className="mondetail">
            <div className="mondetailhead">
              <span>{fileDiff ? fileDiff.path : 'Detail'}</span>
              {fileDiff && (
                <span className="monseg">
                  <button
                    className={diffSource === 'remote' ? 'on' : ''}
                    onClick={() => {
                      setDiffSource('remote')
                      void openFile(fileDiff.path)
                    }}
                  >
                    Remote
                  </button>
                  <button
                    className={diffSource === 'local' ? 'on' : ''}
                    onClick={() => {
                      setDiffSource('local')
                      void openFile(fileDiff.path)
                    }}
                  >
                    Local
                  </button>
                </span>
              )}
            </div>
            {fileDiff && (
              <>
                <div className="mondiffmeta">
                  {diffSource === 'local' ? (
                    <>
                      <span className="del">local only {fileDiff.deletions}</span>
                      <span className="add">upstream only {fileDiff.additions}</span>
                    </>
                  ) : (
                    <>
                      <span className="add">+{fileDiff.additions}</span>
                      <span className="del">−{fileDiff.deletions}</span>
                    </>
                  )}
                  {fileDiff.normalised && <span className="monmuted">line endings normalised</span>}
                  {fileDiff.binary && <span className="monmuted">binary</span>}
                  {fileDiff.tooLarge && <span className="monmuted">too large</span>}
                  {fileDiff.note && <span className="monmuted">{fileDiff.note}</span>}
                </div>
                <div className="mondifflines">
                  {fileDiff.lines.map((line, index) => (
                    <div key={index} className={`mondiffline ${line.kind}`}>
                      <span className="monln">{line.left ?? ''}</span>
                      <span className="monln">{line.right ?? ''}</span>
                      <span className="moncode">{line.text || ' '}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {!fileDiff && <div className="monempty">Choose a file to read the change line by line.</div>}
          </aside>
        </div>
      </div>
    </div>
  )
}

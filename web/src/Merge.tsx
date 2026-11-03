import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * The merge planning surfaces: move a skill between agents, improve one skill through a job, and the
 * trash the merge flows leave behind.
 *
 * Every dialog here reads before it writes, shows what will change, and asks once for the things
 * that cannot be undone from inside the app.
 */

interface RootRow {
  path: string
  owners: string[]
  scope: string
  exists: boolean
}

interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
  before: number | null
  after: number | null
}

interface FileEntry {
  path: string
  kind: string
  status: string
  stats: { added: number; removed: number; lines: number }
  lines: DiffLine[]
  binary?: { beforeBytes: number | null; afterBytes: number | null; afterDataUrl?: string; mime?: string }
  truncated?: boolean
  note?: string
}

interface PackageDiff {
  files: FileEntry[]
  totals: {
    files: number
    changed: number
    added: number
    removed: number
    same: number
    addedLines: number
    removedLines: number
    assets: number
    scripts: number
  }
  manifest: Array<{ path: string; kind: string; status: string; bytes: number | null; beforeBytes: number | null }>
}

const KB = (bytes: number | null): string => (bytes === null ? '—' : bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`)

export function DiffView({ diff, empty }: { diff: PackageDiff | null; empty: string }) {
  const [picked, setPicked] = useState<string | null>(null)
  const files = useMemo(() => (diff?.files ?? []).filter((file) => file.status !== 'same'), [diff])
  const current = files.find((file) => file.path === picked) ?? files[0]

  useEffect(() => {
    if (current && current.path !== picked) setPicked(current.path)
  }, [current, picked])

  if (!diff || !files.length) return <div className="mergenote">{empty}</div>

  return (
    <div className="mergediff">
      <div className="mergedifflist">
        <div className="mergedifftotals">
          {diff.totals.changed} file{diff.totals.changed === 1 ? '' : 's'} · <span className="add">+{diff.totals.addedLines}</span> ·{' '}
          <span className="del">−{diff.totals.removedLines}</span>
          {diff.totals.assets ? ` · ${diff.totals.assets} asset` : ''}
          {diff.totals.scripts ? ` · ${diff.totals.scripts} script` : ''}
        </div>
        {files.map((file) => (
          <button
            key={file.path}
            className={`mergediffrow ${current?.path === file.path ? 'on' : ''} ${file.status}`}
            onClick={() => setPicked(file.path)}
          >
            <span className={`mergediffmark ${file.status}`}>
              {file.status === 'added' ? '+' : file.status === 'removed' ? '−' : '~'}
            </span>
            <span className="mergediffpath">{file.path}</span>
            <span className="mergediffcount">
              {file.binary ? KB(file.binary.afterBytes) : `+${file.stats.added} −${file.stats.removed}`}
            </span>
          </button>
        ))}
        {diff.manifest.filter((entry) => entry.kind === 'asset' || entry.kind === 'script').length > 0 && (
          <div className="mergemanifest">
            <div className="mergemanifesthead">Not prose</div>
            {diff.manifest
              .filter((entry) => entry.kind === 'asset' || entry.kind === 'script')
              .map((entry) => (
                <div className="mergemanifestrow" key={entry.path}>
                  <span className={`mergediffmark ${entry.status}`}>
                    {entry.status === 'added' ? '+' : entry.status === 'removed' ? '−' : '~'}
                  </span>
                  <span className="mergediffpath">{entry.path}</span>
                  <span className="mergemanifestkind">
                    {entry.kind} · {KB(entry.bytes ?? entry.beforeBytes)}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
      <div className="mergediffpane">
        {current ? (
          <>
            <div className="mergediffhead">
              <span>{current.path}</span>
              {current.note && <span className="mergenote">{current.note}</span>}
            </div>
            {current.binary ? (
              <div className="mergebinary">
                {current.binary.afterDataUrl ? (
                  <img src={current.binary.afterDataUrl} alt={current.path} />
                ) : (
                  <div className="mergenote">an image or asset, not text</div>
                )}
                <div className="mergenote">
                  {KB(current.binary.beforeBytes)} → {KB(current.binary.afterBytes)}
                </div>
              </div>
            ) : (
              <div className="mergelines">
                {current.lines.map((line, index) => (
                  line.kind === 'same' && index > 0 && current.lines[index - 1].kind === 'same' ? null : (
                    <div key={index} className={`mergeline ${line.kind}`}>
                      <span className="mergenum">{line.before ?? ''}</span>
                      <span className="mergenum">{line.after ?? ''}</span>
                      <span className="mergeglyph">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
                      <span className="mergetext">{line.text || ' '}</span>
                    </div>
                  )
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

export function MoveDialog({ skill, onClose }: { skill: { id: number; name: string; path: string }; onClose: () => void }) {
  const [roots, setRoots] = useState<RootRow[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [core, setCore] = useState<string>('')
  const [mode, setMode] = useState<'link' | 'move'>('link')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Array<{ root: string; action: string; ok: boolean; reason?: string }> | null>(null)

  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/roots')
      const data = (await response.json()) as { roots?: RootRow[] }
      const usable = (data.roots ?? []).filter((root) => root.exists)
      setRoots(usable)
      const current = usable.find((root) => skill.path.toLowerCase().startsWith(root.path.toLowerCase()))
      if (current) {
        setCore(current.path)
        setChecked(new Set([current.path]))
      }
    })()
  }, [skill.path])

  const toggle = (path: string): void => {
    setChecked((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      if (!next.has(core) && current0(next)) setCore(current0(next) ?? '')
      return next
    })
  }

  function current0(set: Set<string>): string | null {
    const first = [...set][0]
    return first ?? null
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await fetch(`/api/skills/${skill.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coreRoot: core, roots: [...checked].filter((entry) => entry !== core), mode })
      })
      const data = (await response.json()) as { results?: Array<{ root: string; action: string; ok: boolean; reason?: string }> }
      setResults(data.results ?? [])
    } finally {
      setBusy(false)
    }
  }

  const label = (root: RootRow): string => root.owners.join(', ') || root.scope

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="mergedialog" onClick={(event) => event.stopPropagation()}>
        <div className="mergehead">
          <div>
            <div className="mergetitle">Move {skill.name}</div>
            <div className="mergesub">Choose where the real package lives, and where the others point at it.</div>
          </div>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="mergelist">
          {roots.map((root) => (
            <div className={`mergeroot ${checked.has(root.path) ? 'on' : ''}`} key={root.path}>
              <button className={`pick ${checked.has(root.path) ? 'on' : ''}`} onClick={() => toggle(root.path)} role="checkbox" aria-checked={checked.has(root.path)} />
              <div className="mergerootmeta">
                <div className="mergerootname">{label(root)}</div>
                <div className="mergerootpath">{root.path}</div>
              </div>
              <label className="mergecoreradio" title="The real package lives here">
                <input
                  type="radio"
                  name="core-root"
                  checked={core === root.path}
                  disabled={!checked.has(root.path)}
                  onChange={() => setCore(root.path)}
                />
                core
              </label>
            </div>
          ))}
          {!roots.length && <div className="mergenote">No agent root was detected on this machine.</div>}
        </div>

        <div className="mergefoot">
          <div className="mergeswitch" role="group" aria-label="How the other roots receive the skill">
            <button className={mode === 'link' ? 'on' : ''} onClick={() => setMode('link')}>
              Link
            </button>
            <button className={mode === 'move' ? 'on' : ''} onClick={() => setMode('move')}>
              Move
            </button>
          </div>
          <div className="mergesub">
            {mode === 'link' ? 'the other roots get a link to the core package' : 'the other roots get their own copy of the package'}
          </div>
          <button className="mergeapply" disabled={busy || !core || checked.size === 0} onClick={() => void apply()}>
            {busy ? 'Working…' : `Apply to ${checked.size} root${checked.size === 1 ? '' : 's'}`}
          </button>
        </div>

        {results && (
          <div className="mergeresults">
            {results.map((entry) => (
              <div className={`mergeresult ${entry.ok ? 'ok' : 'bad'}`} key={entry.root}>
                <span>{entry.ok ? '✓' : '✕'}</span>
                <span className="mergerootpath">{entry.root}</span>
                <span>{entry.action}</span>
                {entry.reason && <span className="mergenote">{entry.reason}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface ImproveStep {
  name: string
  status: string
  ms: number
  note?: string
}

interface ImproveJob {
  jobId: number
  status: string
  steps: ImproveStep[]
  files: Array<{ path: string; status: string; why: string; unsupported: string[] }>
  diff: PackageDiff
  notes: string[]
  blockers: string[]
  error?: string
  model: string
}

export function ImproveDialog({ skill, onClose }: { skill: { id: number; name: string }; onClose: () => void }) {
  const [instruction, setInstruction] = useState('')
  const [job, setJob] = useState<ImproveJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [applied, setApplied] = useState<'none' | 'applied' | 'undone'>('none')
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const timer = useRef<number | null>(null)

  // Every proposed file starts accepted; unticking one holds it back from the apply.
  useEffect(() => {
    if (!job || job.status !== 'ready') return
    setAccepted(new Set(job.files.map((file) => file.path)))
  }, [job?.status, job?.jobId])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const poll = async (jobId: number): Promise<void> => {
    const response = await fetch(`/api/improve/job/${jobId}`)
    const data = (await response.json()) as { job?: ImproveJob }
    if (!data.job) return
    setJob(data.job)
    if (data.job.status === 'running') timer.current = window.setTimeout(() => void poll(jobId), 1200)
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch('/api/improve/job', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillId: skill.id, instruction })
      })
      const data = (await response.json()) as { job?: ImproveJob; error?: string }
      if (data.job) {
        setJob(data.job)
        void poll(data.job.jobId)
      } else setMessage(data.error ?? 'the job could not start')
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!job) return
    setBusy(true)
    try {
      const response = await fetch('/api/improve/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: job.jobId,
          confirm: true,
          files: job.files.filter((file) => accepted.has(file.path)).map((file) => file.path)
        })
      })
      const data = (await response.json()) as { result?: unknown; error?: string }
      if (data.error) setMessage(data.error)
      else {
        setApplied('applied')
        setMessage('applied')
      }
    } finally {
      setBusy(false)
    }
  }

  const undo = async (): Promise<void> => {
    if (!job) return
    setBusy(true)
    try {
      const response = await fetch('/api/improve/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: job.jobId })
      })
      const data = (await response.json()) as { result?: { hash?: string }; error?: string }
      if (data.error) setMessage(data.error)
      else {
        setApplied('undone')
        setMessage(`restored ${data.result?.hash ?? ''}`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="mergedialog wide" onClick={(event) => event.stopPropagation()}>
        <div className="mergehead">
          <div>
            <div className="mergetitle">Improve {skill.name}</div>
            <div className="mergesub">The job reads the package, proposes edits per file, and writes nothing until you apply.</div>
          </div>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="mergeinstruct">
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="What should this skill do better? One sentence is enough."
            rows={2}
            disabled={busy || Boolean(job)}
          />
          <button className="mergeapply" disabled={busy || instruction.trim().length < 8 || Boolean(job)} onClick={() => void start()}>
            {busy && !job ? 'Starting…' : 'Start job'}
          </button>
        </div>

        {job && (
          <div className="mergesteps">
            {job.steps.map((step, index) => (
              <div className={`mergestep ${step.status}`} key={`${step.name}-${step.at}-${index}`}>
                <span className="mergestepname">{step.name}</span>
                <span className="mergestepms">{step.ms} ms</span>
                {step.note && <span className="mergestepnote" title={step.note}>{step.note.slice(0, 140)}</span>}
              </div>
            ))}
            {job.status === 'running' && <div className="mergestep running">working…</div>}
          </div>
        )}

        {job?.blockers?.length ? (
          <div className="mergeerrors">
            {job.blockers.map((blocker) => (
              <div key={blocker}>✕ {blocker}</div>
            ))}
          </div>
        ) : null}

        {job?.error && <div className="mergenote">✕ {job.error}</div>}

        {job && <DiffView diff={job.diff} empty="the job proposed no change" />}

        {job && job.files.length > 0 && (
          <div className="mergewhys">
            {job.files.map((file) => (
              <div className={`mergewhy ${accepted.has(file.path) ? '' : 'off'}`} key={file.path}>
                <input
                  type="checkbox"
                  className="mergewhycheck"
                  checked={accepted.has(file.path)}
                  disabled={job.status !== 'ready' || applied !== 'none'}
                  onChange={() => {
                    setAccepted((previous) => {
                      const next = new Set(previous)
                      if (next.has(file.path)) next.delete(file.path)
                      else next.add(file.path)
                      return next
                    })
                  }}
                  title="include this file in the apply"
                />
                <span className="mergediffpath">{file.path}</span>
                <span className="mergenote">{file.why}</span>
                {file.unsupported.length > 0 && (
                  <span className="mergeunsupported" title={file.unsupported.join('\n')}>
                    {file.unsupported.length} unsupported line{file.unsupported.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mergefoot">
          <div className="mergesub">{message}</div>
          <div className="mergeactions">
            {job?.status === 'ready' && applied === 'none' && (
              <button
                className="mergeapply"
                disabled={busy || job.blockers.length > 0 || accepted.size === 0}
                onClick={() => void apply()}
              >
                Apply {accepted.size} of {job.files.length} file{job.files.length === 1 ? '' : 's'}
              </button>
            )}
            {applied === 'applied' && (
              <button className="ghost" disabled={busy} onClick={() => void undo()}>
                Undo
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface TrashRow {
  id: number
  name: string
  skill_path: string
  moved_to: string
  at: string
  expires_at: string
}

export function TrashView({
  onChanged,
  selecting,
  onSelectingChange,
  wipeAsk,
  onWipeHandled
}: {
  onChanged: () => void
  selecting: boolean
  onSelectingChange: (value: boolean) => void
  wipeAsk: boolean
  onWipeHandled: () => void
}) {
  const [rows, setRows] = useState<TrashRow[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<TrashRow | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; row: TrashRow } | null>(null)
  const [message, setMessage] = useState('')

  const load = async (): Promise<void> => {
    const response = await fetch('/api/trash')
    const data = (await response.json()) as { entries?: TrashRow[] }
    setRows((data.entries ?? []).filter((entry) => !('restored_at' in entry) || !(entry as { restored_at?: string }).restored_at))
    // The sidebar count is the same number: keep the two from disagreeing.
    onChanged()
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (!wipeAsk) return
    setConfirmWipe(true)
    onWipeHandled()
  }, [wipeAsk, onWipeHandled])

  const recover = async (row: TrashRow): Promise<void> => {
    const response = await fetch(`/api/trash/${row.id}/restore`, { method: 'POST' })
    const data = (await response.json()) as { error?: string; state?: string }
    setMessage(data.error ? `✕ ${data.error}` : `restored ${row.name}`)
    await load()
    onChanged()
  }

  const remove = async (row: TrashRow): Promise<void> => {
    const response = await fetch(`/api/trash/${row.id}/purge`, { method: 'POST' })
    const data = (await response.json()) as { error?: string }
    setMessage(data.error ? `✕ ${data.error}` : `deleted ${row.name}`)
    setConfirmDelete(null)
    await load()
    onChanged()
  }

  const wipe = async (ids: number[]): Promise<void> => {
    if (ids.length === 0) {
      const response = await fetch('/api/trash/wipe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true })
      })
      const data = (await response.json()) as { wiped?: number; error?: string }
      setMessage(data.error ? `✕ ${data.error}` : `wiped ${data.wiped ?? 0}`)
    } else {
      for (const id of ids) await fetch(`/api/trash/${id}/purge`, { method: 'POST' })
      setMessage(`deleted ${ids.length}`)
    }
    setConfirmWipe(false)
    setChecked(new Set())
    await load()
    onChanged()
  }

  const selectedRows = rows.filter((row) => checked.has(row.id))

  return (
    <div className="trashview">
      <div className="trashlist">
          {rows.map((row) => (
            <div
              className={`mergeroot ${checked.has(row.id) ? 'on' : ''}`}
              key={row.id}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, row })
              }}
            >
              {selecting && (
                <button
                  className={`pick ${checked.has(row.id) ? 'on' : ''}`}
                  onClick={() => {
                    setChecked((previous) => {
                      const next = new Set(previous)
                      if (next.has(row.id)) next.delete(row.id)
                      else next.add(row.id)
                      return next
                    })
                  }}
                  role="checkbox"
                  aria-checked={checked.has(row.id)}
                />
              )}
              <div className="mergerootmeta">
                <div className="mergerootname">{row.name}</div>
                <div className="mergerootpath">{row.skill_path}</div>
              </div>
              <div className="mergeexpiry">{new Date(row.expires_at).toLocaleDateString()}</div>
            </div>
          ))}
          {!rows.length && <div className="mergenote">Nothing has been deleted.</div>}
        </div>

        <div className="trashfoot">
          <span className="mergenote">{message}</span>
          <div className="mergeactions">
            {selecting && selectedRows.length > 0 && (
              <>
                <button className="ghost" onClick={() => setConfirmDelete(selectedRows[0])}>
                  Delete selected
                </button>
                <button
                  className="recoverbtn"
                  onClick={() => {
                    void (async () => {
                      for (const row of selectedRows) await fetch(`/api/trash/${row.id}/restore`, { method: 'POST' })
                      setChecked(new Set())
                      await load()
                      onChanged()
                    })()
                  }}
                >
                  Recover selected
                </button>
              </>
            )}
          </div>
        </div>

        {menu && (
          <div className="rowmenu" style={{ left: menu.x, top: menu.y, position: 'fixed' }} onClick={(event) => event.stopPropagation()}>
            <button
              className="rowmenu-item recoveritem"
              onClick={() => {
                const row = menu.row
                setMenu(null)
                void recover(row)
              }}
            >
              Recover
            </button>
            <button
              className="rowmenu-item danger"
              onClick={() => {
                const row = menu.row
                setMenu(null)
                setConfirmDelete(row)
              }}
            >
              Delete
            </button>
          </div>
        )}

        {confirmWipe && (
          <div className="modal-backdrop inner" onClick={() => setConfirmWipe(false)}>
            <div className="confirmbox" onClick={(event) => event.stopPropagation()}>
              <div className="mergetitle">Delete {rows.length} skill{rows.length === 1 ? '' : 's'}?</div>
              <div className="mergesub">They leave the app and go to the operating system's Recycle Bin. This cannot be undone from Skill Academy.</div>
              <div className="mergeactions">
                <button className="ghost" onClick={() => setConfirmWipe(false)}>
                  Keep them
                </button>
                <button className="dangerbtn" onClick={() => void wipe([...checked])}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {confirmDelete && (
          <div className="modal-backdrop inner" onClick={() => setConfirmDelete(null)}>
            <div className="confirmbox" onClick={(event) => event.stopPropagation()}>
              <div className="mergetitle">Delete {confirmDelete.name}?</div>
              <div className="mergesub">{confirmDelete.skill_path}</div>
              <div className="mergesub">This is irrevocable inside the app; the package goes to the OS Recycle Bin.</div>
              <div className="mergeactions">
                <button className="ghost" onClick={() => setConfirmDelete(null)}>
                  Keep it
                </button>
                <button className="dangerbtn" onClick={() => void remove(confirmDelete)}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  )
}

interface PlacementRow {
  root: string
  scope: string
  name: string
  path: string
  kind: 'directory' | 'symlink' | 'other'
  loses: boolean
}

interface GroupMemberView {
  name: string
  path: string
  version: string | null
  chars: number
}

interface PromotePlanView {
  planId: string
  winner: { path: string; name: string; version: string | null; hash: string }
  loser: { path: string; name: string; version: string | null; hash: string }
  drift: { lines: Array<{ text: string; carriedByDefault: boolean }>; files: Array<{ path: string; kind: string; bytes: number }> }
  moved: Array<{ text: string; where: string }>
  frontmatter: Array<{ field: string; loser: string; winner: string; resolution: string }>
  contradictions: Array<{ local: string; upstream: string; why?: string }>
  reverted: boolean
  requiresAck: string[]
  diff: PackageDiff
  placements?: PlacementRow[]
  blockers: string[]
}

interface MergeXPlanView {
  planId: string
  name: string
  directory: string
  existing?: boolean
  members: Array<{ name: string; path: string; version: string | null; files: number; bytes: number }>
  diff: PackageDiff
  blockers: string[]
  placements?: PlacementRow[]
  carriedFiles: Array<{ from: string; to: string }>
  audit: { keptRules: number; totalRules: number; droppedRules: string[]; status: string } | null
}

/**
 * The planning dialog for one group: promote a newer copy with its drift carried, or fold the group
 * into a new skill and send the sources to the trash. Nothing is written before Apply.
 */
export function GroupPlanDialog({
  group,
  onClose,
  onApplied
}: {
  group: { key: string; members: GroupMemberView[]; plan: { survivor: string } | null; liveRoot?: boolean }
  onClose: () => void
  onApplied: () => void
}) {
  const [mode, setMode] = useState<'promote' | 'x'>('promote')
  const ordered = useMemo(
    () => [...group.members].sort((a, b) => (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true })),
    [group.members]
  )
  const [winner, setWinner] = useState(ordered[0]?.path ?? '')
  const [loser, setLoser] = useState(ordered[1]?.path ?? '')
  const [name, setName] = useState(group.plan?.survivor ?? ordered[0]?.name ?? '')
  const [promote, setPromote] = useState<PromotePlanView | null>(null)
  const [merged, setMerged] = useState<MergeXPlanView | null>(null)
  const [target, setTarget] = useState<{ name: string; path: string } | null>(null)
  const [targetQuery, setTargetQuery] = useState('')
  const [candidates, setCandidates] = useState<Array<{ id: number; name: string; path: string }>>([])
  const [dropped, setDropped] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [askContradictions, setAskContradictions] = useState(false)
  const [message, setMessage] = useState('')

  const planPromote = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch('/api/promote/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ winnerPath: winner, loserPath: loser, contradictions: askContradictions })
      })
      const data = (await response.json()) as { plan?: PromotePlanView; error?: string }
      if (data.plan) setPromote(data.plan)
      else setMessage(data.error ?? 'the plan could not be built')
    } finally {
      setBusy(false)
    }
  }

  // A target is a skill that already exists: the group joins it instead of a new package appearing.
  const searchTargets = async (query: string): Promise<void> => {
    setTargetQuery(query)
    if (query.trim().length < 2) {
      setCandidates([])
      return
    }
    const response = await fetch(`/api/skills?q=${encodeURIComponent(query.trim())}&limit=8&status=active`)
    const data = (await response.json()) as { rows?: Array<{ id: number; name: string; path: string }> }
    setCandidates(data.rows ?? [])
  }

  const planX = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch('/api/merge-into-x/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target ? { groupKey: group.key, targetPath: target.path } : { groupKey: group.key, name })
      })
      const data = (await response.json()) as { plan?: MergeXPlanView; error?: string }
      if (data.plan) setMerged(data.plan)
      else setMessage(data.error ?? 'the plan could not be built')
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      if (mode === 'promote' && promote) {
        const response = await fetch('/api/promote/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ planId: promote.planId, ack: true, drop: [...dropped] })
        })
        const data = (await response.json()) as { result?: { carried?: number }; error?: string; detail?: unknown }
        if (data.error) setMessage(`${data.error}: ${JSON.stringify(data.detail ?? '').slice(0, 160)}`)
        else {
          setMessage(`promoted, ${data.result?.carried ?? 0} line(s) carried`)
          onApplied()
        }
        return
      }
      if (mode === 'x' && merged) {
        const response = await fetch('/api/merge-into-x/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ planId: merged.planId, ack: true })
        })
        const data = (await response.json()) as { result?: { name?: string; files?: number }; error?: string; detail?: unknown }
        if (data.error) setMessage(`${data.error}: ${JSON.stringify(data.detail ?? '').slice(0, 160)}`)
        else {
          setMessage(
            data.result?.backup
              ? `${data.result.name} took the rules, ${data.result.files ?? 0} file(s); sources are in the trash and the previous package is kept`
              : `${data.result?.name} written, ${data.result?.files ?? 0} file(s); sources are in the trash`
          )
          onApplied()
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const diff = mode === 'promote' ? promote?.diff ?? null : merged?.diff ?? null
  const placements = (mode === 'promote' ? promote?.placements : merged?.placements) ?? []
  const ack = mode === 'promote' ? promote?.requiresAck ?? [] : merged?.blockers ?? []

  return (
    <div className="modal-backdrop raised" onClick={onClose}>
      <div className="mergedialog wide" onClick={(event) => event.stopPropagation()}>
        <div className="mergehead">
          <div>
            <div className="mergetitle">Plan for {group.key}</div>
            <div className="mergesub">{group.members.length} copies · nothing is written until Apply</div>
          </div>
          <div className="mergeheadactions">
            <div className="mergeswitch" role="group" aria-label="Which plan">
              <button className={mode === 'promote' ? 'on' : ''} onClick={() => setMode('promote')}>
                Promote
              </button>
              <button className={mode === 'x' ? 'on' : ''} onClick={() => setMode('x')}>
                Into X
              </button>
            </div>
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {mode === 'promote' ? (
          <div className="mergeform">
            <label>
              newer copy
              <select value={winner} onChange={(event) => setWinner(event.target.value)}>
                {ordered.map((member) => (
                  <option key={member.path} value={member.path}>
                    {member.name} {member.version ?? '(no version)'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              older copy
              <select value={loser} onChange={(event) => setLoser(event.target.value)}>
                {ordered.map((member) => (
                  <option key={member.path} value={member.path}>
                    {member.name} {member.version ?? '(no version)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="mergecheck">
              <input
                type="checkbox"
                checked={askContradictions}
                onChange={(event) => setAskContradictions(event.target.checked)}
              />
              check contradictions (one model call)
            </label>
            <button className="mergeapply" disabled={busy || !winner || !loser || winner === loser} onClick={() => void planPromote()}>
              {busy ? 'Reading…' : 'Read the drift'}
            </button>
          </div>
        ) : (
          <div className="mergeform">
            <label>
              new skill name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="one-skill-to-rule-them" />
            </label>
            <div className="mergesub">The sources go to the trash, not away: each one can be restored or purged.</div>
            <div className="mergeabsorb">
              {target ? (
                <div className="mergeabsorbrow">
                  <span className="mergenote">folding into {target.name}</span>
                  <button className="ghost small" onClick={() => setTarget(null)}>
                    use a new name instead
                  </button>
                </div>
              ) : (
                <>
                  <input
                    value={targetQuery}
                    onChange={(event) => void searchTargets(event.target.value)}
                    placeholder="or fold into a skill that already exists…"
                  />
                  {candidates.length > 0 && (
                    <div className="mergecandidates">
                      {candidates.map((candidate) => (
                        <button
                          className="mergecandidate"
                          key={candidate.id}
                          onClick={() => {
                            setTarget({ name: candidate.name, path: candidate.path })
                            setName(candidate.name)
                            setCandidates([])
                            setTargetQuery('')
                          }}
                          title={candidate.path}
                        >
                          {candidate.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <button className="mergeapply" disabled={busy || (!name.trim() && !target)} onClick={() => void planX()}>
              {busy ? 'Folding…' : target ? `Plan the fold into ${target.name}` : 'Plan the fold'}
            </button>
          </div>
        )}

        {ack.length > 0 && (
          <div className="mergeerrors">
            {ack.map((reason) => (
              <div key={reason}>! {reason}</div>
            ))}
          </div>
        )}

        {mode === 'promote' && promote && (
          <div className="mergedrift">
            <div className="mergemanifesthead">
              Drift · {promote.drift.lines.length} line(s), {promote.drift.files.length} file(s)
            </div>
            {promote.drift.lines.map((line) => (
              <label className={`mergedriftline ${dropped.has(line.text) ? 'off' : ''}`} key={line.text}>
                <input
                  type="checkbox"
                  checked={!dropped.has(line.text)}
                  onChange={() => {
                    setDropped((previous) => {
                      const next = new Set(previous)
                      if (next.has(line.text)) next.delete(line.text)
                      else next.add(line.text)
                      return next
                    })
                  }}
                />
                <span>{line.text}</span>
              </label>
            ))}
            {promote.drift.files.map((file) => (
              <div className="mergedriftline" key={file.path}>
                <span className="mergediffmark added">+</span>
                <span>
                  {file.path} <span className="mergenote">carried as a file</span>
                </span>
              </div>
            ))}
            {promote.moved.length > 0 && (
              <div className="mergenote">{promote.moved.length} line(s) already live in a reference file of the newer copy.</div>
            )}
            {promote.contradictions.length > 0 && (
              <div className="mergeerrors">
                {promote.contradictions.map((entry) => (
                  <div key={entry.local}>! {entry.upstream} contradicts: {entry.local}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {mode === 'x' && merged && (
          <div className="mergedrift">
            <div className="mergemanifesthead">
              {merged.members.length} sources fold into {merged.name} · {merged.carriedFiles.length} support file(s) carried
            </div>
            {merged.carriedFiles.slice(0, 12).map((file) => (
              <div className="mergedriftline" key={file.to}>
                <span className="mergediffmark added">+</span>
                <span>
                  {file.to} <span className="mergenote">from {file.from}</span>
                </span>
              </div>
            ))}
            {merged.audit && (
              <div className="mergenote">
                audit {merged.audit.status} · kept {merged.audit.keptRules}/{merged.audit.totalRules}
              </div>
            )}
          </div>
        )}

        {placements.length > 0 && (
          <div className="mergedrift">
            <div className="mergemanifesthead">
              Placements · {new Set(placements.map((row) => row.root)).size} agent root(s)
            </div>
            {placements.map((row) => (
              <div className={`mergedriftline ${row.loses ? 'leaving' : 'staying'}`} key={row.path}>
                <span className={`mergediffmark ${row.loses ? 'removed' : 'added'}`}>{row.loses ? '−' : '+'}</span>
                <span className="mergeplacementroot" title={row.root}>
                  {row.root}
                </span>
                <span className="mergenote">
                  {row.loses
                    ? `holds ${row.name}, which leaves: this agent stops seeing the skill unless a link is written here`
                    : `holds ${row.name} (${row.kind})`}
                </span>
              </div>
            ))}
          </div>
        )}

        <DiffView diff={diff} empty={mode === 'promote' ? 'read the drift to see the finished skill' : 'plan the fold to see the new skill'} />

        <div className="mergefoot">
          <div className="mergesub">{message}</div>
          <div className="mergeactions">
            <button
              className="mergeapply"
              disabled={busy || !diff || (mode === 'x' && (merged?.blockers?.length ?? 0) > 0)}
              onClick={() => void apply()}
            >
              {mode === 'promote'
                ? 'Promote'
                : merged?.existing
                  ? `Fold into ${merged.name}`
                  : `Create ${merged?.name ?? 'X'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

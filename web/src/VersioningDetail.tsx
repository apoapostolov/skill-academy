import { useCallback, useEffect, useState } from 'react'
import type { DiffFileRow, FileDiff, InstallationView, MonitorEvent, Plan } from './versioningTypes'
import { EVENT_LABELS, needsAttention, STATE_LABELS, stateOf } from './versioningTypes'

type Tab = 'overview' | 'changes' | 'update' | 'history' | 'policy'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'changes', label: 'Changes' },
  { id: 'update', label: 'Update' },
  { id: 'history', label: 'History' },
  { id: 'policy', label: 'Policy' }
]

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

function statusLabel(status: string): string {
  if (status === 'added') return '+'
  if (status === 'removed') return '−'
  if (status === 'moved') return '→'
  if (status === 'changed') return '~'
  if (status === 'local-changed') return 'edit'
  if (status === 'local-added') return 'new'
  if (status === 'local-removed') return 'gone'
  return '·'
}

/**
 * The detail pane for one installation. It reads only what the pane needs: the comparison costs a
 * GitHub request, so it waits for the Changes tab rather than fetching on selection.
 */
export function VersioningDetail({
  installation,
  events,
  onChanged
}: {
  installation: InstallationView
  events: MonitorEvent[]
  onChanged: () => void
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const [files, setFiles] = useState<DiffFileRow[] | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null)
  const [source, setSource] = useState<'remote' | 'local'>('remote')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [readPlan, setReadPlan] = useState(false)
  const [takeUpstream, setTakeUpstream] = useState(false)
  const [pinNote, setPinNote] = useState(installation.pin_note ?? '')

  useEffect(() => {
    setTab('overview')
    setFiles(null)
    setFileDiff(null)
    setChosen(null)
    setPlan(null)
    setNote('')
    setReadPlan(false)
    setTakeUpstream(false)
    setPinNote(installation.pin_note ?? '')
  }, [installation.id])

  const loadFiles = useCallback(async () => {
    setBusy('diff')
    setNote('')
    try {
      const response = await fetch(`/api/monitor/installation/${installation.id}/diff?level=tree`)
      const data = (await response.json()) as {
        files?: DiffFileRow[]
        local?: DiffFileRow[]
        target?: string
        truncated?: boolean
        error?: string
        detail?: string
      }
      if (data.error) {
        setNote(`${data.error}${data.detail ? `: ${data.detail}` : ''}`)
        setFiles([])
        return
      }
      const upstream = (data.files ?? []).filter((file) => file.status !== 'same')
      setFiles([...upstream, ...(data.local ?? [])])
      setTarget(data.target ?? null)
      setTruncated(Boolean(data.truncated))
    } finally {
      setBusy('')
    }
  }, [installation.id])

  useEffect(() => {
    if (tab === 'changes' && files === null) void loadFiles()
  }, [tab, files, loadFiles])

  async function openFile(row: DiffFileRow): Promise<void> {
    const nextSource = row.status.startsWith('local-') ? 'local' : source
    if (nextSource !== source) setSource(nextSource)
    setChosen(row.path)
    setBusy('file')
    setNote('')
    try {
      const response = await fetch(
        `/api/monitor/installation/${installation.id}/diff?level=file&path=${encodeURIComponent(row.path)}&source=${nextSource}`
      )
      const data = (await response.json()) as { diff?: FileDiff; error?: string; detail?: string }
      if (data.error) {
        setFileDiff(null)
        setNote(`${data.error}${data.detail ? `: ${data.detail}` : ''}`)
        return
      }
      setFileDiff(data.diff ?? null)
    } finally {
      setBusy('')
    }
  }

  async function makePlan(): Promise<void> {
    setBusy('plan')
    setNote('')
    setReadPlan(false)
    try {
      const response = await fetch(`/api/monitor/installation/${installation.id}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      const data = (await response.json()) as { plan?: Plan; error?: string; detail?: unknown }
      if (data.plan) {
        setPlan(data.plan)
        setTab('update')
      } else {
        setNote(`${data.error ?? 'no plan'}: ${JSON.stringify(data.detail ?? '')}`)
      }
    } finally {
      setBusy('')
    }
  }

  async function applyPlan(): Promise<void> {
    if (!plan) return
    setBusy('update')
    setNote('')
    try {
      const response = await fetch(`/api/monitor/installation/${installation.id}/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planId: plan.planId,
          confirm: true,
          choice: takeUpstream ? 'take-upstream' : undefined
        })
      })
      const data = (await response.json()) as {
        result?: { files: number; ref: string; trashed: string | null }
        error?: string
        detail?: unknown
      }
      if (data.result) {
        setNote(
          `Updated ${data.result.files} file(s) to ${data.result.ref.slice(0, 8)}` +
            (data.result.trashed ? ', previous copy in the trash' : '')
        )
        setPlan(null)
        setFiles(null)
        onChanged()
      } else {
        setNote(`${data.error ?? 'update refused'}: ${JSON.stringify(data.detail ?? '')}`)
      }
    } finally {
      setBusy('')
    }
  }

  async function savePolicy(channel: InstallationView['policy_channel'], auto: InstallationView['policy_auto']): Promise<void> {
    setBusy('policy')
    setNote('')
    try {
      await fetch(`/api/monitor/installation/${installation.id}/policy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, auto })
      })
      onChanged()
    } finally {
      setBusy('')
    }
  }

  async function togglePin(): Promise<void> {
    setBusy('pin')
    setNote('')
    try {
      await fetch(`/api/monitor/installation/${installation.id}/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ref: installation.pin_ref ? null : installation.last_remote_ref ?? installation.ref,
          note: installation.pin_ref ? undefined : pinNote.trim() || undefined
        })
      })
      onChanged()
    } finally {
      setBusy('')
    }
  }

  const state = stateOf(installation)
  const rowEvents = events.filter((event) => event.installation_id === installation.id)
  const drift = installation.drift
  const driftCount = drift.localChanged.length + drift.localAdded.length + drift.localRemoved.length

  return (
    <div className="vdetail">
      <div className="vdetail-head">
        <div className="vdetail-title">
          <span className={`vpill ${state}`}>{STATE_LABELS[state] ?? 'Not checked'}</span>
          <h2>{installation.name}</h2>
        </div>
        <div className="vdetail-sub">
          {installation.repo} · {installation.remote_path}
        </div>
      </div>

      {needsAttention(state) && (
        <div className={`vdetail-warn ${state === 'conflict' || state === 'gone' ? 'bad' : ''}`}>
          {state === 'conflict'
            ? 'Local edits and upstream edits both exist. Read the changes, then pick a side.'
            : state === 'behind'
              ? 'Upstream has moved. Review the changes before updating.'
              : state === 'local-drift'
                ? 'Your copy has local edits. An update would replace them.'
                : state === 'gone'
                  ? 'This skill is no longer in the repository. It stays here until you remove it.'
                  : 'The repository could not be reached on the last check.'}
        </div>
      )}

      <div className="vtabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className={`vtab ${tab === entry.id ? 'on' : ''}`}
            onClick={() => setTab(entry.id)}
            aria-pressed={tab === entry.id}
          >
            {entry.label}
            {entry.id === 'changes' && files ? ` ${files.length}` : ''}
            {entry.id === 'history' && rowEvents.length ? ` ${rowEvents.length}` : ''}
          </button>
        ))}
      </div>

      {note && (
        <div className="vnote" role="status">
          {note}
        </div>
      )}

      {tab === 'overview' && (
        <div className="vpane">
          <div className="vrows">
            <div className="vrowline">
              <span className="vk">Installed</span>
              <span>
                {installation.version ?? 'no version'} at{' '}
                <code>{installation.ref.slice(0, 8)}</code>
                {installation.tag ? ` (${installation.tag})` : ''}
              </span>
            </div>
            <div className="vrowline">
              <span className="vk">Upstream</span>
              <span>
                {installation.last_remote_ref ? <code>{installation.last_remote_ref.slice(0, 8)}</code> : 'unknown'}
                {installation.last_remote_ref && installation.last_remote_ref !== installation.ref ? ' (moved)' : ''}
              </span>
            </div>
            <div className="vrowline">
              <span className="vk">Checked</span>
              <span>{ago(installation.last_check_at)}</span>
            </div>
            <div className="vrowline">
              <span className="vk">Installed at</span>
              <span>{new Date(installation.installed_at).toLocaleString()}</span>
            </div>
            <div className="vrowline">
              <span className="vk">Channel</span>
              <span>
                {installation.policy_channel} · auto {installation.policy_auto}
              </span>
            </div>
            {installation.pin_ref && (
              <div className="vrowline">
                <span className="vk">Pinned</span>
                <span>
                  <code>{installation.pin_ref.slice(0, 8)}</code>
                  {installation.pin_note ? ` — ${installation.pin_note}` : ''}
                </span>
              </div>
            )}
            <div className="vrowline">
              <span className="vk">Local edits</span>
              <span>{driftCount === 0 ? 'none' : `${driftCount} file(s)`}</span>
            </div>
            {installation.baseline_lost ? (
              <div className="vrowline">
                <span className="vk">Baseline</span>
                <span className="vwarn">the recorded file list is missing, so a diff cannot be trusted</span>
              </div>
            ) : null}
            <div className="vrowline">
              <span className="vk">Path</span>
              <span className="vpath">{installation.library_path}</span>
            </div>
          </div>

          <div className="vactions">
            <button className="mergeapply" disabled={busy === 'plan'} onClick={() => void makePlan()}>
              {busy === 'plan' ? 'Planning…' : 'Review update'}
            </button>
            <button className="ghost" onClick={() => setTab('changes')}>
              See what changed
            </button>
          </div>
        </div>
      )}

      {tab === 'changes' && (
        <div className="vpane">
          <div className="vchangesbar">
            <button className="ghost small" disabled={busy === 'diff'} onClick={() => void loadFiles()}>
              {busy === 'diff' ? 'Comparing…' : 'Recompare'}
            </button>
            {target && <span className="vhint">against {target.slice(0, 12)}</span>}
            {truncated && <span className="vwarn">the tree came back truncated, so some files may be missing</span>}
          </div>

          {files && files.length === 0 && <div className="empty">Nothing differs, upstream or locally.</div>}

          {files && files.length > 0 && (
            <div className="vsplit">
              <div className="vfilelist">
                {files.map((file) => (
                  <button
                    key={`${file.status}:${file.path}`}
                    className={`vfile ${chosen === file.path ? 'selected' : ''} ${file.status}`}
                    onClick={() => void openFile(file)}
                  >
                    <span className="vfile-glyph">{statusLabel(file.status)}</span>
                    <span className="vfile-path" title={file.path}>
                      {file.path}
                    </span>
                    {file.remoteBytes !== null && file.installedBytes !== null && file.status === 'changed' ? (
                      <span className="vfile-bytes">
                        {Math.round(file.installedBytes / 1024)}→{Math.round(file.remoteBytes / 1024)}K
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>

              <div className="vdiffpane">
                {!fileDiff && !busy && <div className="empty">Pick a file to read the change.</div>}
                {busy === 'file' && <div className="empty">Reading…</div>}
                {fileDiff && (
                  <>
                    <div className="vdiffhead">
                      <span className="vfile-path">{fileDiff.path}</span>
                      <span className="vdiffstat">
                        +{fileDiff.additions} −{fileDiff.deletions}
                      </span>
                      <div className="vsourceswitch">
                        <button className={source === 'remote' ? 'on' : ''} onClick={() => setSource('remote')}>
                          Upstream
                        </button>
                        <button className={source === 'local' ? 'on' : ''} onClick={() => setSource('local')}>
                          Local
                        </button>
                      </div>
                    </div>
                    {fileDiff.binary && <div className="vhint">Binary file: size and hash only, never bytes.</div>}
                    {fileDiff.tooLarge && <div className="vhint">Too large to diff as text.</div>}
                    {fileDiff.normalised && <div className="vhint">Only the line endings differ.</div>}
                    {fileDiff.note && <div className="vhint">{fileDiff.note}</div>}
                    {!fileDiff.binary && !fileDiff.tooLarge && (
                      <div className="vdifflines">
                        {fileDiff.lines.map((line, index) => (
                          <div className={`vdiffline ${line.kind}`} key={`${index}-${line.left ?? ''}-${line.right ?? ''}`}>
                            <span className="vln">{line.left ?? ''}</span>
                            <span className="vln">{line.right ?? ''}</span>
                            <span className="vsign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
                            <span className="vtext">{line.text || ' '}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'update' && (
        <div className="vpane">
          {!plan && (
            <>
              <div className="vhint">
                A plan lists every file, the line counts and the version move before anything is written.
              </div>
              <div className="vactions">
                <button className="mergeapply" disabled={busy === 'plan'} onClick={() => void makePlan()}>
                  {busy === 'plan' ? 'Planning…' : 'Plan the update'}
                </button>
              </div>
            </>
          )}

          {plan && (
            <div className="vplan">
              <div className="vrows">
                <div className="vrowline">
                  <span className="vk">Files</span>
                  <span>{plan.fileCount}</span>
                </div>
                <div className="vrowline">
                  <span className="vk">Lines</span>
                  <span>
                    +{plan.additions} −{plan.deletions}
                  </span>
                </div>
                <div className="vrowline">
                  <span className="vk">Version</span>
                  <span>
                    {plan.versionFrom ?? 'none'} → {plan.versionTo ?? 'none'}
                  </span>
                </div>
                <div className="vrowline">
                  <span className="vk">Ref</span>
                  <span>
                    <code>{plan.fromRef.slice(0, 8)}</code> → <code>{plan.toRef.slice(0, 8)}</code>
                  </span>
                </div>
                <div className="vrowline">
                  <span className="vk">Target</span>
                  <span>{plan.targetKind}</span>
                </div>
              </div>

              {plan.gate.required && (
                <div className="vdetail-warn">
                  This update needs a second look: {plan.gate.reasons.join('; ')}.
                </div>
              )}
              {plan.refusals.length > 0 && (
                <div className="vdetail-warn bad">
                  This update cannot be applied: {plan.refusals.join('; ')}.
                </div>
              )}

              {plan.localChoiceRequired && (
                <label className="vcheck">
                  <input type="checkbox" checked={takeUpstream} onChange={(event) => setTakeUpstream(event.target.checked)} />
                  Replace my local edits with the upstream copy. They go to the trash, recoverable for 30 days.
                </label>
              )}

              <label className="vcheck">
                <input type="checkbox" checked={readPlan} onChange={(event) => setReadPlan(event.target.checked)} />
                I read the plan and the changes
              </label>

              <div className="vactions">
                <button
                  className="mergeapply"
                  disabled={!readPlan || busy === 'update' || plan.refusals.length > 0}
                  onClick={() => void applyPlan()}
                >
                  {busy === 'update' ? 'Updating…' : `Update ${plan.fileCount} file(s)`}
                </button>
                <button className="ghost" onClick={() => setPlan(null)}>
                  Discard the plan
                </button>
              </div>
              <div className="vhint">The replaced copy goes to the trash, so this is reversible for 30 days.</div>
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="vpane">
          {rowEvents.length === 0 && <div className="empty">Nothing recorded for this installation yet.</div>}
          {rowEvents.map((event) => (
            <div className={`vevent ${event.severity}`} key={event.id}>
              <span className="vevent-kind">{EVENT_LABELS[event.kind] ?? event.kind}</span>
              <span className="vevent-summary">{event.summary}</span>
              <span className="vevent-when">{ago(event.seen_at)}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'policy' && (
        <div className="vpane">
          <div className="vrows">
            <div className="vrowline">
              <span className="vk">Channel</span>
              <span className="vchoices">
                {(['release', 'head', 'pinned'] as const).map((name) => (
                  <button
                    key={name}
                    className={`vchoice ${installation.policy_channel === name ? 'on' : ''}`}
                    disabled={busy === 'policy'}
                    onClick={() => void savePolicy(name, installation.policy_auto)}
                  >
                    {name}
                  </button>
                ))}
              </span>
            </div>
            <div className="vrowline">
              <span className="vk">Auto-apply</span>
              <span className="vchoices">
                {(['off', 'notify', 'apply-minor', 'apply-any'] as const).map((name) => (
                  <button
                    key={name}
                    className={`vchoice ${installation.policy_auto === name ? 'on' : ''}`}
                    disabled={busy === 'policy'}
                    onClick={() => void savePolicy(installation.policy_channel, name)}
                  >
                    {name}
                  </button>
                ))}
              </span>
            </div>
          </div>

          <div className="vhint">
            <b>release</b> follows the newest tag, <b>head</b> follows the default branch, <b>pinned</b> checks but never
            updates. Auto-apply writes the same journal entry a manual update does.
          </div>

          <div className="vpinbox">
            <div className="vrowline">
              <span className="vk">Pin</span>
              <span>{installation.pin_ref ? <code>{installation.pin_ref.slice(0, 8)}</code> : 'not pinned'}</span>
            </div>
            {!installation.pin_ref && (
              <input
                className="iv-search vpininput"
                placeholder="Why is this copy frozen? The reason matters more than the pin."
                value={pinNote}
                onChange={(event) => setPinNote(event.target.value)}
                aria-label="Pin reason"
              />
            )}
            <div className="vactions">
              <button className="ghost" disabled={busy === 'pin'} onClick={() => void togglePin()}>
                {installation.pin_ref ? 'Unpin' : 'Pin at the installed ref'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

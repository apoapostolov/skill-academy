import { useCallback, useEffect, useState } from 'react'
import { useDialogFocus } from './dialogFocus'

interface SyncState {
  config: { repo: string; branch: string }
  initialized: boolean
  branch: string | null
  commit: string | null
  ahead: number | null
  behind: number | null
  clean: boolean | null
}

interface Conflict {
  file: string
  keptLocalAs: string
  keptLocalPath: string
}

interface PushResult {
  ok?: boolean
  error?: string
  commit?: string
  pushed?: boolean
  files?: number
  findings?: Array<{ file: string; line: number; kind: string }>
}

interface PullResult {
  ok?: boolean
  error?: string
  restored?: number
  commit?: string
  conflicts?: Conflict[]
}

/**
 * Sync is git over a repository the user owns. The app holds no token and no account: it makes a
 * checkout, commits what the library holds, and lets git's own credential helper do the signing in.
 */
export function SyncDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SyncState | null>(null)
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [findings, setFindings] = useState<Array<{ file: string; line: number; kind: string }>>([])
  const panel = useDialogFocus<HTMLDivElement>()

  const load = useCallback(async (): Promise<void> => {
    const response = await fetch('/api/sync')
    const data = (await response.json()) as SyncState
    setState(data)
    setRepo(data.config.repo)
    setBranch(data.config.branch)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const saveConfig = async (): Promise<void> => {
    if (!repo.trim()) {
      setNote('A repository is required.')
      return
    }
    setBusy(true)
    try {
      await fetch('/api/sync/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: repo.trim(), branch: branch.trim() || 'main' })
      })
      await load()
      setNote('Saved. Push to publish what this machine has.')
    } finally {
      setBusy(false)
    }
  }

  const push = async (): Promise<void> => {
    setBusy(true)
    setNote('')
    setFindings([])
    setConflicts([])
    try {
      const response = await fetch('/api/sync/push', { method: 'POST' })
      const data = (await response.json()) as PushResult
      if (data.error === 'secrets-found') {
        setFindings(data.findings ?? [])
        setNote('Nothing was committed. A key-shaped string was found in the files that would be pushed.')
        return
      }
      if (data.error) {
        setNote(data.error)
        return
      }
      setNote(data.pushed ? `Pushed ${data.commit} · ${data.files} files` : 'Nothing to push: the repository is up to date.')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const pull = async (): Promise<void> => {
    setBusy(true)
    setNote('')
    setFindings([])
    setConflicts([])
    try {
      const response = await fetch('/api/sync/pull', { method: 'POST' })
      const data = (await response.json()) as PullResult
      if (data.error) {
        setNote(data.error)
        return
      }
      setConflicts(data.conflicts ?? [])
      setNote(
        `Pulled ${data.commit ?? ''} · ${data.restored ?? 0} entr${data.restored === 1 ? 'y' : 'ies'} restored` +
          (data.conflicts?.length ? ` · ${data.conflicts.length} conflict${data.conflicts.length === 1 ? '' : 's'}` : '')
      )
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-label="Sync" aria-modal="true">
      <div className="sourcesdlg syncdlg" ref={panel} tabIndex={-1}>
        <div className="sdhead">
          <div>
            <div className="mergetitle">Sync</div>
            <div className="mergesub">
              A private repository you own. The library, the drafts and the lock travel; the database does not.
            </div>
          </div>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="sdadd">
          <input
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="git@github.com:you/skills-private.git"
            aria-label="Repository"
          />
          <input
            className="syncbranch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="main"
            aria-label="Branch"
          />
          <button className="ghost small" disabled={busy} onClick={() => void saveConfig()}>
            Save
          </button>
          <button className="mergeapply" disabled={busy} onClick={() => void push()}>
            Push
          </button>
          <button className="ghost small" disabled={busy} onClick={() => void pull()}>
            Pull
          </button>
        </div>

        {state && (
          <div className="sdmeta">
            {state.initialized ? `on ${state.branch} at ${state.commit}` : 'no checkout yet'}
            {state.ahead !== null ? ` · ${state.ahead} to push` : ''}
            {state.behind !== null ? ` · ${state.behind} to pull` : ''}
            {state.clean === false ? ' · uncommitted changes here' : ''}
          </div>
        )}

        {note && <div className="draftstatus">{note}</div>}

        {findings.length > 0 && (
          <div className="sdconflict">
            <div className="mergetitle">A key-shaped string stops the push</div>
            <div className="mergesub">Nothing was committed. Remove the value, or move it into the keychain.</div>
            {findings.map((finding) => (
              <div className="sdconflictrow" key={`${finding.file}:${finding.line}`}>
                <span className="sdname">{finding.file}</span>
                <span className="sdbytes">
                  line {finding.line} · {finding.kind}
                </span>
              </div>
            ))}
          </div>
        )}

        {conflicts.length > 0 && (
          <div className="sdconflict">
            <div className="mergetitle">Both machines changed these</div>
            <div className="mergesub">
              The shared version is in place and your copy is beside it. Nothing was overwritten without a copy.
            </div>
            {conflicts.map((conflict) => (
              <div className="sdconflictrow" key={conflict.file}>
                <span className="sdname">{conflict.file}</span>
                <span className="sdbytes">yours: {conflict.keptLocalAs}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

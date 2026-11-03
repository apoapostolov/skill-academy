import { useEffect, useState } from 'react'

/**
 * A workspace is a folder that keeps its own skills. The screen does one thing a library cannot:
 * it compares a workspace with the library by name and by the hash of each SKILL.md, and it copies
 * a workspace skill into the library, keeping the package it replaced.
 */

export interface WorkspaceRow {
  id: number
  name: string
  path: string
}

export interface CompareRow {
  name: string
  state: 'same' | 'different' | 'workspace-only'
  hash: string
  libraryHash?: string
  libraryPath?: string
  skillId?: number
}

export interface CompareView {
  workspace: string
  path: string
  total: number
  same: number
  different: number
  workspaceOnly: number
  rows: CompareRow[]
}

const STATE_LABEL: Record<CompareRow['state'], string> = {
  same: 'same',
  different: 'differs',
  'workspace-only': 'library lacks it'
}

export function WorkspaceSidebar({
  workspaces,
  activeId,
  onOpen,
  onAdd,
  onRemove
}: {
  workspaces: WorkspaceRow[]
  activeId: number | null
  onOpen: (id: number) => void
  onAdd: (path: string) => void
  onRemove: (id: number) => void
}) {
  const [draft, setDraft] = useState('')
  return (
    <div className="wsside">
      {workspaces.map((workspace) => (
        <div key={workspace.id} className={`wsnav ${activeId === workspace.id ? 'active' : ''}`}>
          <button className="wsnavname" onClick={() => onOpen(workspace.id)} title={workspace.path}>
            {workspace.name}
          </button>
          <button className="wsnavdrop" onClick={() => onRemove(workspace.id)} title="Remove this workspace">
            ×
          </button>
        </div>
      ))}
      <div className="wsadd">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Workspace folder"
          placeholder="C:\path\to\workspace"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft.trim()) {
              onAdd(draft.trim())
              setDraft('')
            }
          }}
        />
        <button
          className="ghost small"
          disabled={!draft.trim()}
          onClick={() => {
            onAdd(draft.trim())
            setDraft('')
          }}
        >
          Add
        </button>
      </div>
    </div>
  )
}

export function WorkspaceRows({
  workspaceId,
  refresh,
  selected,
  onSelect,
  onCompare
}: {
  workspaceId: number
  refresh: number
  selected: string | null
  onSelect: (name: string) => void
  onCompare: (view: CompareView) => void
}) {
  const [view, setView] = useState<CompareView | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setView(null)
    setError('')
    void fetch(`/api/workspaces/${workspaceId}/compare`)
      .then((response) => response.json())
      .then((data: CompareView & { error?: string }) => {
        if (!live) return
        if (data.error) {
          setError(data.error)
          return
        }
        setView(data)
        onCompare(data)
      })
      .catch(() => live && setError('the comparison did not answer'))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, refresh])

  if (error) return <div className="empty">{error}</div>
  if (!view) return <div className="empty">Reading the workspace…</div>
  if (!view.total) return <div className="empty">This workspace has no skills yet.</div>

  return (
    <div className="wsrows">
      {view.rows.map((row) => (
        <button
          key={row.name}
          className={`wsrow ${selected === row.name ? 'selected' : ''}`}
          onClick={() => onSelect(row.name)}
        >
          <span className="wsrowname">{row.name}</span>
          <span className={`wspill ${row.state}`}>{STATE_LABEL[row.state]}</span>
        </button>
      ))}
    </div>
  )
}

export function WorkspaceDetail({
  workspaceId,
  view,
  row,
  onPromoted,
  onClose
}: {
  workspaceId: number
  view: CompareView | null
  row: CompareRow | null
  onPromoted: () => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    setAsking(false)
    setStatus('')
  }, [row?.name])

  if (!view) return <div className="empty">Pick a workspace.</div>

  const promote = async (replace: boolean): Promise<void> => {
    if (!row) return
    setBusy(true)
    setStatus('')
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: row.name, replace })
      })
      const data = (await response.json()) as { ok?: boolean; error?: string; replaced?: boolean; target?: string }
      if (data.error) {
        setStatus(data.error === 'exists' ? 'the library has a different copy; replace it?' : data.error)
        if (data.error === 'exists') setAsking(true)
        return
      }
      setStatus(`${data.replaced ? 'replaced' : 'promoted'} · ${data.target ?? ''}`)
      setAsking(false)
      onPromoted()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wsdetail">
      <div className="wsdhead">
        <div className="mergetitle">{view.workspace}</div>
        <div className="mergesub">{view.path}</div>
      </div>
      <div className="wsdcounts">
        {view.total} skills · {view.same} same · {view.different} differ · {view.workspaceOnly} only here
      </div>

      {row ? (
        <div className="wsdcard">
          <div className="mergetitle">{row.name}</div>
          <div className="wsdrow">
            <span className="wsdlabel">state</span>
            <span className={`wspill ${row.state}`}>{STATE_LABEL[row.state]}</span>
          </div>
          <div className="wsdrow">
            <span className="wsdlabel">workspace</span>
            <code className="wsdhash">{row.hash.slice(0, 12)}</code>
          </div>
          {row.libraryHash && (
            <div className="wsdrow">
              <span className="wsdlabel">library</span>
              <code className="wsdhash">{row.libraryHash.slice(0, 12)}</code>
            </div>
          )}
          {row.libraryPath && <div className="wsdpath">{row.libraryPath}</div>}

          {asking ? (
            <div className="wsdask">
              <span>The library copy differs. Replacing keeps the old package aside so undo can put it back.</span>
              <button className="mergeapply" disabled={busy} onClick={() => void promote(true)}>
                Replace
              </button>
              <button className="ghost small" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="mergeapply"
              disabled={busy || row.state === 'same'}
              onClick={() => void promote(false)}
            >
              {row.state === 'same' ? 'Already in the library' : 'Promote to library'}
            </button>
          )}
          {status && <div className="draftstatus">{status}</div>}
        </div>
      ) : (
        <div className="mergenote">Pick a skill to compare it with the library.</div>
      )}

      <button className="ghost small wsdclose" onClick={onClose}>
        Close
      </button>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { DiffView, type PackageDiff } from './Merge'
import { useDialogFocus } from './dialogFocus'

interface Side {
  id: number
  name: string
  path: string
  root: string
  version: string | null
}

interface CompareResult {
  left: Side
  right: Side
  latestId: number
  newer: 'left' | 'right' | null
  diff: PackageDiff
}

/**
 * Two copies side by side, read-only. Nothing here writes: a comparison that also plans an update
 * would make "look" and "do" the same click, and the plan dialog already exists for the second one.
 */
export function CompareCopies({
  leftId,
  rightId,
  onClose,
  onOpenCopy
}: {
  leftId: number
  rightId: number
  onClose: () => void
  onOpenCopy: (id: number) => void
}) {
  const panel = useDialogFocus<HTMLDivElement>()
  const [result, setResult] = useState<CompareResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setResult(null)
    setError('')
    fetch(`/api/skills/${leftId}/compare?with=${rightId}`)
      .then(async (response) => {
        const data = (await response.json()) as CompareResult & { error?: string }
        if (!alive) return
        if (!response.ok || data.error) {
          setError(data.error ?? `HTTP ${response.status}`)
          return
        }
        setResult(data)
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [leftId, rightId])

  return (
    <div
      className="modal-backdrop raised"
      role="dialog"
      aria-label="Compare copies"
      aria-modal="true"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div
        className="mergedialog wide"
        ref={panel}
        tabIndex={-1}
        role="presentation"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="mergehead">
          <div>
            <div className="mergetitle">Compare copies</div>
            <div className="mergesub">
              {result
                ? `${result.left.version ?? 'no version'} in ${result.left.root.split(/[\\/]/).slice(-2).join('/')} · against ${result.right.version ?? 'no version'} in ${result.right.root.split(/[\\/]/).slice(-2).join('/')}`
                : 'reading both packages…'}
              {result && result.newer === null ? ' · same version, so neither copy is newer' : ''}
            </div>
          </div>
          <div className="mergeheadactions">
            <button className="ghost" onClick={onOpenCopy.bind(null, leftId)}>
              This copy
            </button>
            <button className="ghost" onClick={onOpenCopy.bind(null, rightId)}>
              Other copy
            </button>
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {error && <div className="mergeerrors">{error}</div>}
        {!error && (
          <DiffView
            diff={result?.diff ?? null}
            empty={result ? 'The two packages are byte-identical.' : 'Reading both packages…'}
          />
        )}
      </div>
    </div>
  )
}

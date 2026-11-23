import { useEffect, useState } from 'react'
import type { ConsolidateGroupView, ConsolidateMemberView } from './consolidateTypes'

interface FoldView {
  key: string
  mode: 'merge' | 'router'
  survivor: string
  model: string
  ms: number
  chars: number
  keptRules: number
  totalRules: number
  droppedRules: string[]
  inventedLines: string[]
  status: 'clean' | 'lossy' | 'error'
  message?: string
  text: string
}

const KIND_LABELS: Record<string, string> = {
  'near-duplicate': 'Near duplicate',
  'partial-overlap': 'Partial overlap',
  'intentional-family': 'Intentional family',
  'weak-evidence': 'Weak evidence',
  'cross-root-placement': 'Cross-root placement',
  'shape-only': 'Shape only'
}

/** One member's SKILL.md, read on demand: the read gate is worthless if the body is not here. */
function MemberBody({ member }: { member: ConsolidateMemberView }) {
  const [text, setText] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setText(null)
    setState('idle')
    setOpen(false)
  }, [member.path])

  const load = async () => {
    if (text !== null) {
      setOpen((value) => !value)
      return
    }
    if (member.skillId === null) {
      setState('error')
      setOpen(true)
      return
    }
    setState('loading')
    setOpen(true)
    try {
      const response = await fetch(`/api/skills/${member.skillId}/file?rel=SKILL.md`)
      if (!response.ok) throw new Error(String(response.status))
      const payload = (await response.json()) as { text?: string }
      setText(payload.text ?? '')
      setState('idle')
    } catch {
      setState('error')
    }
  }

  return (
    <>
      <button className="linkbtn cdetail-member-open" onClick={() => void load()}>
        {open ? 'Hide body' : 'Read body'}
      </button>
      {open && (
        <div className="cdetail-body">
          {state === 'loading' && <span className="cdetail-hint">Reading…</span>}
          {state === 'error' && <span className="cdetail-hint">This copy has no index row, so its body cannot be read here.</span>}
          {text !== null && <pre className="cdetail-bodytext">{text}</pre>}
        </div>
      )}
    </>
  )
}

export function ConsolidateDetail({
  group,
  onPlan,
  onChanged
}: {
  group: ConsolidateGroupView
  onPlan: (group: ConsolidateGroupView) => void
  onChanged: () => void
}) {
  const [fold, setFold] = useState<FoldView | null>(null)
  const [foldBusy, setFoldBusy] = useState(false)
  const [foldRead, setFoldRead] = useState(false)
  const [note, setNote] = useState('')
  const [applyBusy, setApplyBusy] = useState(false)
  const [planRead, setPlanRead] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [survivorBody, setSurvivorBody] = useState<string | null>(null)

  useEffect(() => {
    setFold(null)
    setFoldBusy(false)
    setFoldRead(false)
    setNote('')
    setApplyBusy(false)
    setPlanRead(false)
    setPreview(null)
    setSurvivorBody(null)
  }, [group.key])

  const proposeFold = async () => {
    setFoldBusy(true)
    setNote('')
    setFold(null)
    setFoldRead(false)
    try {
      const response = await fetch('/api/consolidate/fold', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: group.key })
      })
      const data = (await response.json()) as FoldView & { error?: string; detail?: unknown }
      if (!response.ok || data.error) {
        setNote(
          data.error
            ? `${data.error}: ${typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? '')}`
            : `HTTP ${response.status}`
        )
        return
      }
      setFold(data)
    } finally {
      setFoldBusy(false)
    }
  }

  const writeFold = async () => {
    if (!fold) return
    setFoldBusy(true)
    setNote('')
    try {
      const response = await fetch('/api/consolidate/fold/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: fold.key, text: fold.text, read: foldRead, confirm: true, dryRun: false })
      })
      const data = (await response.json()) as {
        applied?: boolean
        archive?: string
        error?: string
        detail?: { path?: string; hint?: string } | unknown
      }
      if (data.error === 'protected-root') {
        const detail = data.detail as { path?: string; hint?: string } | undefined
        setNote(`Nothing written. ${detail?.path ?? 'This skill'} is in a protected root. ${detail?.hint ?? ''}`)
        return
      }
      if (!response.ok || data.error) {
        setNote(data.error ? `${data.error}: ${JSON.stringify(data.detail ?? '')}` : `HTTP ${response.status}`)
        return
      }
      setNote(`Written. Archived at ${data.archive ?? 'unknown'}.`)
      onChanged()
    } finally {
      setFoldBusy(false)
    }
  }

  /** The body the merge replaces, so the merged text can be read against it rather than alone. */
  const loadSurvivor = async () => {
    if (survivorBody !== null) {
      setSurvivorBody(null)
      return
    }
    const survivor = group.members.find((member) => member.name === group.plan?.survivor)
    if (!survivor || survivor.skillId === null) {
      setNote('The survivor has no index row, so its body cannot be read here.')
      return
    }
    try {
      const response = await fetch(`/api/skills/${survivor.skillId}/file?rel=SKILL.md`)
      const data = (await response.json()) as { text?: string }
      setSurvivorBody(data.text ?? '')
    } catch {
      setNote('The survivor body could not be read.')
    }
  }

  const applyPlan = async () => {
    setApplyBusy(true)
    setNote('')
    try {
      const response = await fetch('/api/consolidate/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: group.key, read: planRead, confirm: true })
      })
      const data = (await response.json()) as {
        error?: string
        detail?: unknown
        closeOut?: { ok: boolean; problems: string[] }
      }
      if (!response.ok || data.error) {
        setNote(data.error ? `${data.error}: ${JSON.stringify(data.detail ?? '')}` : `HTTP ${response.status}`)
        return
      }
      const problems = data.closeOut?.problems?.length ? ` Close-out: ${data.closeOut.problems.join('; ')}` : ''
      setNote(`Applied.${problems}`)
      onChanged()
    } finally {
      setApplyBusy(false)
    }
  }

  // The protected root is the one real gate. `blocked` on a group that carries a plan is a caution
  // written by the classifier ("read both bodies first"), not a refusal, so it must not disable the
  // button: the server is what refuses a merge that would drop content.
  const canWrite = !group.liveRoot
  const plan = group.plan

  return (
    <div className="cdetail">
      <div className="cdetail-head">
        <div className="cdetail-title">
          <span className={`cv-kind ${group.mergeType}`}>{KIND_LABELS[group.mergeType] ?? group.mergeType}</span>
          <h2>{plan?.survivor ?? group.members[0]?.name ?? group.key}</h2>
        </div>
        <div className="cdetail-sub">
          {group.members.length} {group.members.length === 1 ? 'copy' : 'copies'} · {group.evidence}
        </div>
      </div>

      {group.liveRoot && (
        <div className="cdetail-warn">
          Live agent library, so every write is refused here. Prove the flow on a fixture root, or set the deliberate
          override for a real merge.
        </div>
      )}
      {group.blocked && !group.liveRoot && (
        <div className="cdetail-warn muted">{group.blocked}</div>
      )}

      <section className="cdetail-section">
        <div className="cdetail-section-head">Copies</div>
        <div className="cdetail-members">
          {group.members.map((member) => (
            <div className="cdetail-member" key={member.path}>
              <div className="cdetail-member-top">
                <span className="cdetail-member-name">{member.name}</span>
                <span className="cdetail-member-ver">{member.version ? `v${member.version}` : 'no version'}</span>
                <span className="cdetail-member-size">{member.chars} chars</span>
                <MemberBody member={member} />
              </div>
              <div className="cdetail-member-path" title={member.path}>
                {member.path}
              </div>
              <div className="cdetail-member-meta">
                {member.uniqueHeadings.length > 0 ? (
                  <span>unique sections: {member.uniqueHeadings.join(', ')}</span>
                ) : (
                  <span>no unique sections</span>
                )}
                {member.uniqueRules.length > 0 ? <span>{member.uniqueRules.length} unique rule(s)</span> : null}
                {member.supportFiles > 0 ? (
                  <span>
                    {member.supportFiles} support file{member.supportFiles === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      {plan && (
        <section className="cdetail-section">
          <div className="cdetail-section-head">Deterministic plan</div>
          <div className="cdetail-plan">
            <div className="cdetail-plan-row">
              <span className="cdetail-plan-k">Survivor</span>
              <span>{plan.survivor}</span>
            </div>
            <div className="cdetail-plan-row">
              <span className="cdetail-plan-k">Pointerize</span>
              <span>{plan.pointerize.length ? plan.pointerize.map((entry) => entry.name).join(', ') : 'none'}</span>
            </div>
            <div className="cdetail-plan-row">
              <span className="cdetail-plan-k">Routerize</span>
              <span>{plan.routerize.length ? plan.routerize.map((entry) => entry.name).join(', ') : 'none'}</span>
            </div>
            {plan.rewire.length > 0 && (
              <div className="cdetail-plan-row">
                <span className="cdetail-plan-k">Rewire</span>
                <span>{plan.rewire.join(', ')}</span>
              </div>
            )}
          </div>

          {(plan.pointerize.length > 0 || plan.routerize.length > 0) && (
            <>
              <div className="cdetail-actions">
                {plan.pointerize.map((entry) => (
                  <button
                    key={entry.name}
                    className="ghost small"
                    onClick={() => setPreview(preview === entry.name ? null : entry.name)}
                  >
                    {preview === entry.name ? 'Hide' : 'Preview'} {entry.name}
                  </button>
                ))}
                {plan.routerize.map((entry) => (
                  <button
                    key={entry.name}
                    className="ghost small"
                    onClick={() => setPreview(preview === entry.name ? null : entry.name)}
                  >
                    {preview === entry.name ? 'Hide' : 'Outline'} {entry.name}
                  </button>
                ))}
              </div>
              {plan.pointerize
                .filter((entry) => preview === entry.name)
                .map((entry) => (
                  <pre className="cdetail-bodytext" key={`p-${entry.name}`}>
                    {entry.body}
                  </pre>
                ))}
              {plan.routerize
                .filter((entry) => preview === entry.name)
                .map((entry) => (
                  <ul className="cdetail-outline" key={`r-${entry.name}`}>
                    {entry.outline.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ))}
              <div className="cdetail-hint">
                The pointer body above is exactly what replaces that copy. Nothing here is written until you apply.
              </div>
            </>
          )}

          <label className="cdetail-check">
            <input type="checkbox" checked={planRead} onChange={(event) => setPlanRead(event.target.checked)} />
            I read every copy and this plan
          </label>
          <div className="cdetail-actions">
            <button
              className="mergeapply"
              disabled={!canWrite || !planRead || applyBusy}
              onClick={() => void applyPlan()}
              title={canWrite ? 'Write the pointer and router bodies' : 'This group lives in a protected root'}
            >
              {applyBusy ? 'Applying…' : 'Apply deterministic plan'}
            </button>
          </div>
          <div className="cdetail-hint">Deterministic apply writes the pointer and router bodies. It calls no model.</div>
        </section>
      )}

      <section className="cdetail-section">
        <div className="cdetail-section-head">AI fold</div>
        <div className="cdetail-hint">
          Asks a model to merge the bodies into one. The answer is audited: every source rule must survive, and anything
          it invents is named. A lossy merge is refused.
        </div>
        <div className="cdetail-actions">
          <button className="ghost" disabled={!canWrite || foldBusy} onClick={() => void proposeFold()}>
            {foldBusy && !fold ? 'Asking the model…' : fold ? 'Run the fold again' : 'Propose an AI fold'}
          </button>
          {group.members.length >= 2 && (
            <button className="ghost" onClick={() => onPlan(group)}>
              Plan a promote or a fold into…
            </button>
          )}
        </div>

        {fold && (
          <div className="foldbox">
            <div className="foldaudit">
              <span className={`foldchip ${fold.status === 'clean' ? 'ok' : 'bad'}`}>{fold.status}</span>
              <span>
                kept {fold.keptRules}/{fold.totalRules} lines
              </span>
              <span>{fold.inventedLines.length} invented</span>
              <span>{fold.droppedRules.length} dropped</span>
              <span>
                {fold.model} · {(fold.ms / 1000).toFixed(1)} s · {fold.chars} chars
              </span>
            </div>
            <div className="foldcompare">
              <button className="ghost small" onClick={() => void loadSurvivor()}>
                {survivorBody === null ? 'Read it against the survivor' : 'Hide the survivor'}
              </button>
            </div>
            {survivorBody === null ? (
              <pre className="foldtext">{fold.text}</pre>
            ) : (
              <div className="foldsidebyside">
                <div className="foldcolumn">
                  <div className="foldcolumnhead">{group.plan?.survivor ?? 'survivor'} as it is</div>
                  <pre className="foldtext">{survivorBody}</pre>
                </div>
                <div className="foldcolumn">
                  <div className="foldcolumnhead">merged body, audited above</div>
                  <pre className="foldtext">{fold.text}</pre>
                </div>
              </div>
            )}
            {fold.droppedRules.length > 0 && (
              <div className="foldmissing">
                missing from the merge:
                {fold.droppedRules.slice(0, 8).map((line) => (
                  <code key={line}>{line.slice(0, 100)}</code>
                ))}
              </div>
            )}
            {fold.inventedLines.length > 0 && (
              <div className="foldmissing">
                invented by the model:
                {fold.inventedLines.slice(0, 8).map((line) => (
                  <code key={line}>{line.slice(0, 100)}</code>
                ))}
              </div>
            )}
            <label className="cdetail-check">
              <input type="checkbox" checked={foldRead} onChange={(event) => setFoldRead(event.target.checked)} />
              I read the merged body
            </label>
            <div className="cdetail-actions">
              <button
                className="mergeapply"
                disabled={!foldRead || fold.status !== 'clean' || foldBusy || !canWrite}
                onClick={() => void writeFold()}
              >
                {foldBusy ? 'Writing…' : 'Write the merged body'}
              </button>
            </div>
          </div>
        )}
      </section>

      {!plan && group.members.length >= 2 && (
        <section className="cdetail-section">
          <div className="cdetail-section-head">Manual plan</div>
          <div className="cdetail-hint">
            No deterministic plan exists for this verdict. You can still promote one copy over the other, or fold the
            group into a new or existing skill.
          </div>
          <div className="cdetail-actions">
            <button className="ghost" onClick={() => onPlan(group)}>
              Plan a promote or a fold into…
            </button>
          </div>
        </section>
      )}

      {note && (
        <div className="cdetail-note" role="status">
          {note}
        </div>
      )}
    </div>
  )
}

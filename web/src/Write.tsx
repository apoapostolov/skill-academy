import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection, highlightActiveLine, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { renderMarkdown } from './markdown'
import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Authoring is a draft first: the editor writes to the app's own drafts folder, never to an agent
 * directory, and a save is the only act that places a package. Autosave keeps the draft, not the
 * library, current.
 */

export interface DraftRow {
  id: string
  name: string
  updated: string
  origin: string
  chars: number
  clean: boolean
  links: number
}

export interface DraftIssue {
  code: string
  detail: string
}

export interface DraftValidation {
  ok: boolean
  name: string
  description: string
  tags: string[]
  chars: number
  issues: DraftIssue[]
}

export interface DraftDetail {
  meta: { id: string; name: string; created: string; updated: string; origin: string; savedTo?: string; savedHash?: string }
  text: string
  validation: DraftValidation
  links: number
  savedTo: string | null
}

interface LinkRow {
  id: number
  repo: string
  source_path: string
  source_name: string
  mode: string
  state: string
  last_ingest_sha: string | null
}

interface RootRow {
  path: string
  scope: string
  owners: string[]
  exists: boolean
}

const BASE = { background: 'transparent', color: 'rgb(214, 217, 222)' }

function theme() {
  return EditorView.theme({
    '&': { ...BASE, fontSize: '12.5px', height: '100%' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.62' },
    '.cm-content': { padding: '12px 0' },
    '.cm-gutters': { background: 'transparent', color: 'rgb(96, 100, 108)', border: 'none' },
    '.cm-activeLine': { background: 'rgba(255,255,255,0.03)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'rgba(127,163,199,0.28)' },
    '&.cm-focused': { outline: 'none' }
  })
}

/** A small markdown toolbar: each action wraps the selection and leaves the caret usable. */
function wrap(view: EditorView, before: string, after: string, placeholder: string): void {
  const { from, to } = view.state.selection.main
  const text = view.state.sliceDoc(from, to) || placeholder
  view.dispatch({
    changes: { from, to, insert: `${before}${text}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + text.length }
  })
  view.focus()
}

function linePrefix(view: EditorView, prefix: string): void {
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  view.dispatch({ changes: { from: line.from, insert: prefix } })
  view.focus()
}

export function DraftList({
  drafts,
  activeId,
  onOpen,
  onNew,
  onGenerate,
  onDeleted
}: {
  drafts: DraftRow[]
  activeId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onGenerate: (intent: string) => void
  onDeleted: (id: string) => void
}) {
  const [intent, setIntent] = useState('')
  // Deleting a draft asks twice, on the same four-second lapse every other destructive control uses.
  const [arming, setArming] = useState<string | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const removeDraft = async (id: string): Promise<void> => {
    if (arming !== id) {
      setArming(id)
      if (armTimer.current) clearTimeout(armTimer.current)
      armTimer.current = setTimeout(() => setArming(null), 4000)
      return
    }
    if (armTimer.current) clearTimeout(armTimer.current)
    setArming(null)
    await fetch(`/api/drafts/${id}`, { method: 'DELETE' })
    onDeleted(id)
  }
  return (
    <div className="draftlist">
      <div className="draftnew">
        <input
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          placeholder="One sentence: what should this skill do?"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && intent.trim()) {
              onGenerate(intent.trim())
              setIntent('')
            }
          }}
        />
        <button className="bulkbtn" disabled={!intent.trim()} onClick={() => {
          onGenerate(intent.trim())
          setIntent('')
        }}>
          Draft it
        </button>
        <button className="bulkbtn" onClick={onNew} title="Start from an empty skill">
          Empty
        </button>
      </div>
      {drafts.map((draft) => (
        <div key={draft.id} className={`draftrow ${activeId === draft.id ? 'selected' : ''}`}>
          <button className="draftopen" onClick={() => onOpen(draft.id)}>
            <span className="draftname">{draft.name}</span>
            <span className="draftmeta">
              {draft.clean ? 'valid' : 'needs work'} · {draft.chars} chars · {draft.links} source{draft.links === 1 ? '' : 's'}
            </span>
          </button>
          <button
            className={`draftdel ${arming === draft.id ? 'armed' : ''}`}
            title={arming === draft.id ? 'Press again to delete' : 'Delete this draft'}
            aria-label={arming === draft.id ? `Confirm deleting ${draft.name}` : `Delete ${draft.name}`}
            onClick={() => void removeDraft(draft.id)}
          >
            {arming === draft.id ? 'Delete?' : '×'}
          </button>
        </div>
      ))}
      {!drafts.length && <div className="empty trashempty">No drafts yet. Describe a skill above, or start empty.</div>}
    </div>
  )
}

export function DraftEditor({
  draftId,
  onChanged,
  onClose
}: {
  draftId: string
  onChanged: () => void
  onClose: () => void
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const [draft, setDraft] = useState<DraftDetail | null>(null)
  const [preview, setPreview] = useState(false)
  const [status, setStatus] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [improve, setImprove] = useState<{ text: string; before: string; lines: Array<{ kind: string; text: string }> } | null>(null)
  const [improving, setImproving] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [roots, setRoots] = useState<RootRow[]>([])
  const [links, setLinks] = useState<LinkRow[]>([])
  const [linkRepo, setLinkRepo] = useState('')
  const [linkPath, setLinkPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [tags, setTags] = useState<string[]>([])
  const [tagDraft, setTagDraft] = useState('')
  const pending = useRef<string | null>(null)

  /** Reads the tag list out of the draft's own frontmatter. */
  const readTags = (text: string): string[] => {
    const block = text.startsWith('---') ? text.slice(3, Math.max(3, text.indexOf('\n---', 3))) : ''
    const line = block.split(/\r?\n/).find((candidate) => /^tags\s*:/.test(candidate))
    if (!line) return []
    const raw = line.slice(line.indexOf(':') + 1).trim().replace(/^\[|\]$/g, '')
    return raw
      .split(',')
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }

  /** Writes the list back into the frontmatter, then shows what the server wrote. */
  const saveTags = async (next: string[]): Promise<void> => {
    const response = await fetch(`/api/drafts/${draftId}/tags`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: next })
    })
    const data = (await response.json()) as { draft?: DraftDetail }
    if (data.draft) {
      setTags(readTags(data.draft.text))
      setDraft(data.draft)
      if (view.current && view.current.state.doc.toString() !== data.draft.text) {
        view.current.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: data.draft.text } })
      }
      setSavedAt(data.draft.meta.updated)
    }
  }

  const load = async (): Promise<void> => {
    const response = await fetch(`/api/drafts/${draftId}`)
    const data = (await response.json()) as { draft?: DraftDetail }
    if (data.draft) {
      setDraft(data.draft)
      setTags(readTags(data.draft.text))
      setSavedAt(data.draft.meta.updated)
      if (view.current && view.current.state.doc.toString() !== data.draft.text) {
        view.current.dispatch({ changes: { from: 0, to: view.current.state.doc.length, insert: data.draft.text } })
      }
    }
    const linkResponse = await fetch(`/api/drafts/${draftId}/links`)
    const linkData = (await linkResponse.json()) as { links?: LinkRow[] }
    setLinks(linkData.links ?? [])
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId])

  // One editor per draft. Its document is the draft's SKILL.md, and autosave runs after a pause.
  useEffect(() => {
    if (!host.current || !draft) return
    if (view.current) {
      view.current.destroy()
      view.current = null
    }
    const state = EditorState.create({
      doc: draft.text,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        markdown(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        theme(),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          pending.current = update.state.doc.toString()
          window.clearTimeout((pending as unknown as { timer?: number }).timer)
          ;(pending as unknown as { timer?: number }).timer = window.setTimeout(() => {
            const text = pending.current
            if (text === null) return
            void fetch(`/api/drafts/${draftId}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text })
            })
              .then((response) => response.json())
              .then((data: { validation?: DraftValidation; meta?: { updated: string } }) => {
                if (data.validation) setDraft((current) => (current ? { ...current, validation: data.validation! } : current))
                setSavedAt(data.meta?.updated ?? new Date().toISOString())
                onChanged()
              })
          }, 600)
        })
      ]
    })
    view.current = new EditorView({ state, parent: host.current })
    return () => {
      view.current?.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, Boolean(draft)])

  const headings = useMemo(() => {
    const text = view.current?.state.doc.toString() ?? draft?.text ?? ''
    return [...text.matchAll(/^(#{1,3})\s+(.+)$/gm)].map((match) => ({ level: match[1].length, title: match[2].trim() }))
  }, [draft?.text, savedAt])

  const ask = async (): Promise<void> => {
    setImproving(true)
    setStatus('')
    try {
      const response = await fetch(`/api/drafts/${draftId}/improve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction })
      })
      const data = (await response.json()) as {
        text?: string
        before?: string
        changed?: boolean
        diff?: { files?: Array<{ path: string; lines?: Array<{ kind: string; text: string }> }> }
        error?: string
      }
      if (data.error || !data.text) {
        setStatus(data.error ?? 'the model did not answer')
        return
      }
      const file = data.diff?.files?.find((entry) => entry.path === 'SKILL.md')
      setImprove({ text: data.text, before: data.before ?? '', lines: file?.lines ?? [] })
    } finally {
      setImproving(false)
    }
  }

  const acceptImprove = async (): Promise<void> => {
    if (!improve) return
    await fetch(`/api/drafts/${draftId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: improve.text })
    })
    setImprove(null)
    await load()
    onChanged()
  }

  const openSave = async (): Promise<void> => {
    const response = await fetch('/api/roots')
    const data = (await response.json()) as { roots?: RootRow[] }
    setRoots((data.roots ?? []).filter((root) => root.exists))
    setSaveOpen(true)
  }

  const saveTo = async (rootPath: string, replace: boolean): Promise<void> => {
    setBusy(true)
    setStatus('')
    try {
      const response = await fetch(`/api/drafts/${draftId}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootPath, replace })
      })
      const data = (await response.json()) as {
        result?: { directory: string; hash: string; placement: { mode?: string; ok: boolean; reason?: string } }
        error?: string
        detail?: unknown
      }
      if (data.error) {
        setStatus(`${data.error}: ${JSON.stringify(data.detail ?? '').slice(0, 120)}`)
        return
      }
      setStatus(`saved to ${data.result?.directory} · ${data.result?.placement.mode ?? 'placed'}`)
      setSaveOpen(false)
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const addSource = async (): Promise<void> => {
    if (!linkRepo.trim() || !linkPath.trim()) return
    const response = await fetch(`/api/drafts/${draftId}/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: linkRepo.trim(), sourcePath: linkPath.trim(), mode: 'distill' })
    })
    const data = (await response.json()) as { error?: string }
    if (data.error) {
      setStatus(data.error)
      return
    }
    setLinkRepo('')
    setLinkPath('')
    await load()
  }

  const ingest = async (linkId: number): Promise<void> => {
    setBusy(true)
    setStatus('reading the source…')
    try {
      const planResponse = await fetch(`/api/links/${linkId}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
      const plan = (await planResponse.json()) as { proposal?: { runId: number; added_rules?: unknown[] }; error?: string; detail?: unknown }
      if (!plan.proposal) {
        setStatus(`${plan.error ?? 'the plan failed'}: ${JSON.stringify(plan.detail ?? '').slice(0, 120)}`)
        return
      }
      const applied = await fetch('/api/ingest/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: plan.proposal.runId, confirm: true })
      })
      const done = (await applied.json()) as { result?: { applied?: boolean; added?: number }; error?: string }
      setStatus(done.result?.applied ? `ingested, ${done.result.added ?? 0} rule(s) added` : `${done.error ?? 'nothing applied'}`)
      await load()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (!draft) return <div className="empty">Reading the draft…</div>

  return (
    <div className="drafteditor">
      <div className="draftbar">
        <div className="draftedhead">
          <div className="mergetitle">{draft.meta.name}</div>
          <div className="draftsub">
            {draft.meta.origin} draft · {savedAt ? `saved ${new Date(savedAt).toLocaleTimeString()}` : 'not saved'}
            {draft.savedTo ? ` · placed at ${draft.savedTo}` : ''}
          </div>
        </div>
        <div className="drafttags" role="group" aria-label="Tags">
          {tags.map((tag) => (
            <span className="tagchip" key={tag}>
              {tag}
              <button className="tagx" aria-label={`Remove ${tag}`} onClick={() => void saveTags(tags.filter((value) => value !== tag))}>
                ×
              </button>
            </span>
          ))}
          <input
            className="taginput"
            value={tagDraft}
            placeholder={tags.length ? 'add a tag' : 'no tags'}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && tagDraft.trim()) {
                void saveTags([...tags, tagDraft])
                setTagDraft('')
              }
              if (event.key === 'Backspace' && !tagDraft && tags.length) void saveTags(tags.slice(0, -1))
            }}
          />
        </div>
        <div className="drafttools">
          <button className={`ghost small ${preview ? 'on' : ''}`} onClick={() => setPreview((value) => !value)}>
            {preview ? 'Edit' : 'Preview'}
          </button>
          <button className="ghost small" disabled={improving} onClick={() => void ask()}>
            {improving ? 'Thinking…' : 'Improve'}
          </button>
          <button className="mergeapply" onClick={() => void openSave()}>
            Save…
          </button>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="draftbody">
        <div className="draftmain">
          <div className="drafttoolbar">
            <button title="Bold" onClick={() => view.current && wrap(view.current, '**', '**', 'bold')}>
              B
            </button>
            <button title="Italic" onClick={() => view.current && wrap(view.current, '_', '_', 'italic')}>
              I
            </button>
            <button title="Code" onClick={() => view.current && wrap(view.current, '`', '`', 'code')}>
              {'</>'}
            </button>
            <button title="Heading" onClick={() => view.current && linePrefix(view.current, '## ')}>
              H2
            </button>
            <button title="Rule" onClick={() => view.current && linePrefix(view.current, '- ')}>
              •
            </button>
            <button title="Link" onClick={() => view.current && wrap(view.current, '[', '](https://)', 'text')}>
              ↗
            </button>
            <input
              className="draftask"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="what should improve change?"
            />
          </div>

          {preview ? (
            // Same renderer as the detail pane: raw HTML in the file is dropped, not executed.
            <div className="draftpreview" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.text) }} />
          ) : (
            <div className="draftcode" ref={host} />
          )}

          {improve && (
            <div className="draftproposal">
              <div className="mergemanifesthead">Proposed change</div>
              <div className="mergelinediff">
                {improve.lines.slice(0, 200).map((line, index) => (
                  <div key={index} className={`mergeline ${line.kind}`}>
                    <span className="mergeglyph">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
                    <span className="mergetext">{line.text || ' '}</span>
                  </div>
                ))}
              </div>
              <div className="draftproposalactions">
                <button className="mergeapply" onClick={() => void acceptImprove()}>
                  Take it
                </button>
                <button className="ghost small" onClick={() => setImprove(null)}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="draftside">
          <div className="draftsection">
            <div className="mergemanifesthead">Outline</div>
            {headings.length ? (
              headings.map((heading, index) => (
                <div key={index} className={`draftoutline l${heading.level}`}>
                  {heading.title}
                </div>
              ))
            ) : (
              <div className="mergenote">No headings yet.</div>
            )}
          </div>

          <div className="draftsection">
            <div className="mergemanifesthead">Validation</div>
            {draft.validation.ok ? (
              <div className="draftok">valid · {draft.validation.chars} chars</div>
            ) : (
              draft.validation.issues.map((issue) => (
                <div key={issue.code} className="draftissue">
                  {issue.detail}
                </div>
              ))
            )}
            {draft.validation.tags.length > 0 && (
              <div className="mergenote">{draft.validation.tags.join(' · ')}</div>
            )}
          </div>

          <div className="draftsection">
            <div className="mergemanifesthead">Sources</div>
            {links.map((link) => (
              <div className="draftlink" key={link.id}>
                <div>
                  <div className="mergerootname">{link.source_name}</div>
                  <div className="mergerootpath">
                    {link.repo} · {link.mode}
                  </div>
                </div>
                <button className="ghost small" disabled={busy} onClick={() => void ingest(link.id)}>
                  Ingest
                </button>
              </div>
            ))}
            <input value={linkRepo} onChange={(event) => setLinkRepo(event.target.value)} placeholder="owner/repo" />
            <input value={linkPath} onChange={(event) => setLinkPath(event.target.value)} placeholder="skills/the-skill" />
            <button className="bulkbtn" disabled={!linkRepo.trim() || !linkPath.trim()} onClick={() => void addSource()}>
              Add source
            </button>
          </div>
        </div>
      </div>

      {status && <div className="draftstatus">{status}</div>}

      {saveOpen && (
        <div className="modal-backdrop inner" onClick={() => setSaveOpen(false)}>
          <div className="mergedialog narrow" onClick={(event) => event.stopPropagation()}>
            <div className="mergehead">
              <div>
                <div className="mergetitle">Save {draft.meta.name}</div>
                <div className="mergesub">The package goes into the library, then this agent points at it.</div>
              </div>
              <button className="ghost" onClick={() => setSaveOpen(false)}>
                Close
              </button>
            </div>
            <div className="mergelist">
              {roots.map((root) => (
                <button key={root.path} className="mergeroot savetarget" disabled={busy} onClick={() => void saveTo(root.path, true)}>
                  <div className="mergerootmeta">
                    <div className="mergerootname">{root.owners.join(', ') || root.scope}</div>
                    <div className="mergerootpath">{root.path}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

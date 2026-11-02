import { useEffect, useMemo, useRef, useState } from 'react'
import { highlight } from './highlight'
import { renderMarkdown } from './markdown'

interface State {
  version: string
  dataDir: string
  dbPath: string
  uptimeMs: number
  registry: { roots: number; detected: number; codes: number }
  library: { skills: number; tokens: number; issues: number; roots: number }
  watching: number
  lastScanAt: string | null
  lastEventAt: string | null
  lastEvent: { added: number; changed: number; removed: number; root: string } | null
}

interface Issue {
  code: string
  detail: string
}

interface Skill {
  id: number
  name: string
  description: string
  path: string
  root_path: string
  tokens: number
  body_chars: number
  tags: string[]
  category: string
  risk: 'clean' | 'low' | 'medium' | 'high'
  findings: Finding[]
  health: Issue[]
  mtime: string
  version?: string
  repo?: string
}

interface Finding {
  file: string
  line: number
  code: string
  severity: 'high' | 'medium' | 'low'
  excerpt: string
}

interface Drift {
  thisVersion: string
  latestVersion: string
  latestId: number
  latestRoot: string
}

interface Placement {
  agent: string
  root: string
  target: string
  state: 'native' | 'on' | 'off'
  mode: string | null
}

interface PackageEntry {
  kind: 'reference' | 'script' | 'asset'
  name: string
  relPath: string
  size: number
  ext: string
  description?: string
}

interface Facets {
  agents: { agent: string; path: string; origin: string; count: number; tokens: number }[]
  hidden: string[]
  tags: { tag: string; count: number }[]
  categories: { category: string; count: number }[]
  issues: number
}

type Scope =
  | { kind: 'all' }
  | { kind: 'health' }
  | { kind: 'agent'; agent: string; path: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'category'; category: string }

const fmt = new Intl.NumberFormat()
const PAGE = 120

function AcademyMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#000" strokeWidth="2.1" strokeLinecap="square" strokeLinejoin="miter">
        <path d="M3 6.6 8 3.4l5 3.2" />
        <path d="M3 10.8 8 14l5-3.2" />
      </svg>
    </span>
  )
}

function GearGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" strokeLinecap="round" />
    </svg>
  )
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      className={`chevron ${open ? 'open' : ''}`}
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}

/** A block header that collapses its body to this single line. State persists per block. */
function BlockHead({
  label,
  meta,
  open,
  onToggle
}: {
  label: string
  meta?: React.ReactNode
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      className={`block-head ${open ? 'open' : 'closed'}`}
      onClick={onToggle}
      aria-expanded={open}
      title={open ? `Collapse ${label}` : `Expand ${label}`}
    >
      <ChevronGlyph open={open} />
      <span className="bh-label">{label}</span>
      <span className="bh-meta">{meta}</span>
    </button>
  )
}

function SelectAllGlyph({ checked }: { checked: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {checked && (
        <path
          d="M5.2 8.2l2 2 3.6-3.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

function PencilGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.3 2.2a1.6 1.6 0 0 1 2.3 2.3L5.2 12.9 2 14l1.1-3.2 8.2-8.6Z" />
      <path d="M10.2 3.4 12.6 5.8" />
    </svg>
  )
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 8.5 6 12l7.5-8" />
    </svg>
  )
}

/**
 * Scroll container with a mobile-style thumb: it overlays the content instead of
 * reserving a lane, fades in while scrolling and fades out shortly after the last
 * scroll event. The native bar is hidden, so the content keeps its full width.
 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg'])

function isImagePath(rel: string): boolean {
  const dot = rel.lastIndexOf('.')
  return dot !== -1 && IMAGE_EXT.has(rel.slice(dot).toLowerCase())
}

function extensionOf(rel: string): string {
  const dot = rel.lastIndexOf('.')
  return dot === -1 ? '' : rel.slice(dot).toLowerCase()
}

interface PkgNode {
  name: string
  path: string
  entry?: PackageEntry
  children: PkgNode[]
}

/** Nests package entries by their real folders instead of flattening them per kind. */
function buildPackageTree(entries: PackageEntry[]): PkgNode[] {
  const root: PkgNode = { name: '', path: '', children: [] }
  for (const entry of entries) {
    // relPath arrives with Windows separators; the tree is built on '/'.
    const parts = entry.relPath.replace(/\\/g, '/').split('/')
    let node = root
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const folderPath = parts.slice(0, depth + 1).join('/')
      let child = node.children.find((candidate) => candidate.path === folderPath && !candidate.entry)
      if (!child) {
        child = { name: parts[depth], path: folderPath, children: [] }
        node.children.push(child)
      }
      node = child
    }
    node.children.push({ name: parts[parts.length - 1], path: entry.relPath, entry, children: [] })
  }
  return root.children
}

function RestoreGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M3.5 8a4.5 4.5 0 1 0 1.5-3.4" strokeLinecap="round" />
      <path d="M3 2.5V5h2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrashGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.2h4.8l.6-8.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PreviewGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M3 2.5h7.5L13 5v8.5H3z" strokeLinejoin="round" />
      <path d="M5 6.5h6M5 9h6M5 11.5h3.5" strokeLinecap="round" />
    </svg>
  )
}

function RawGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MarkdownModeSwitch({
  mode,
  onChange
}: {
  mode: 'preview' | 'raw'
  onChange: (next: 'preview' | 'raw') => void
}) {
  return (
    <div className="seg" role="group" aria-label="Markdown view">
      <button
        type="button"
        className={mode === 'preview' ? 'on' : ''}
        aria-pressed={mode === 'preview'}
        aria-label="Markdown preview"
        title="Preview"
        onClick={() => onChange('preview')}
      >
        <PreviewGlyph />
      </button>
      <button
        type="button"
        className={mode === 'raw' ? 'on' : ''}
        aria-pressed={mode === 'raw'}
        aria-label="Raw markdown"
        title="Raw"
        onClick={() => onChange('raw')}
      >
        <RawGlyph />
      </button>
    </div>
  )
}

function ScrollPane({
  className = '',
  axis = 'y',
  bodyRef: externalRef,
  onScroll,
  children
}: {
  className?: string
  axis?: 'y' | 'x' | 'both'
  bodyRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: (element: HTMLDivElement) => void
  children: React.ReactNode
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const [thumb, setThumb] = useState({
    yTop: 0,
    ySize: 0,
    xLeft: 0,
    xSize: 0,
    visible: false
  })

  function update(show: boolean) {
    const element = bodyRef.current
    if (!element) return

    const measure = (client: number, total: number, offset: number) => {
      const ratio = client / total
      if (ratio >= 0.999) return { offset: 0, size: 0 }
      const size = Math.max(28, Math.round(client * ratio))
      const travel = total - client
      return { offset: Math.round((offset / Math.max(travel, 1)) * (client - size)), size }
    }

    const vertical = measure(element.clientHeight, element.scrollHeight, element.scrollTop)
    // A pane that clips horizontally cannot scroll sideways, so it must not advertise a bar.
    const overflowX = window.getComputedStyle(element).overflowX
    const horizontal =
      overflowX === 'hidden' || overflowX === 'clip'
        ? { offset: 0, size: 0 }
        : measure(element.clientWidth, element.scrollWidth, element.scrollLeft)
    const scrollable = vertical.size > 0 || horizontal.size > 0
    if (!scrollable) {
      setThumb((current) => (current.visible ? { ...current, visible: false } : current))
      return
    }

    // Geometry updates on every render; only a real scroll makes the thumb appear,
    // otherwise the hide timer would be undone by the next render. Returning the same
    // object when nothing moved keeps React from re-rendering forever, which would also
    // restart the opacity transition on every frame.
    setThumb((current) => {
      const unchanged =
        current.yTop === vertical.offset &&
        current.ySize === vertical.size &&
        current.xLeft === horizontal.offset &&
        current.xSize === horizontal.size &&
        (show ? current.visible : true)
      if (unchanged) return current
      return {
        yTop: vertical.offset,
        ySize: vertical.size,
        xLeft: horizontal.offset,
        xSize: horizontal.size,
        visible: show || current.visible
      }
    })
    if (show) {
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        setThumb((current) => ({ ...current, visible: false }))
      }, 650)
    }
  }

  useEffect(() => {
    update(false)
  })

  useEffect(() => {
    const element = bodyRef.current
    if (!element) return
    const observer = new ResizeObserver(() => update(false))
    observer.observe(element)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={`scrollpane ${className}`}>
      <div
        className="scrollbody"
        ref={(node) => {
          bodyRef.current = node
          if (externalRef) externalRef.current = node
        }}
        onScroll={(event) => {
          update(true)
          onScroll?.(event.currentTarget)
        }}
      >
        {children}
      </div>
      {(axis === 'y' || axis === 'both') && thumb.ySize > 0 && (
        <div
          className={`scrollthumb ${thumb.visible ? 'on' : ''}`}
          style={{ top: thumb.yTop, height: thumb.ySize }}
          aria-hidden="true"
        />
      )}
      {(axis === 'x' || axis === 'both') && thumb.xSize > 0 && (
        <div
          className={`scrollthumb horizontal ${thumb.visible ? 'on' : ''}`}
          style={{ left: thumb.xLeft, width: thumb.xSize }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}

function Switch({ on }: { on: boolean }) {
  return (
    <span className={`switch ${on ? 'on' : ''}`} aria-hidden="true">
      <span className="knob" />
    </span>
  )
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

function WrapGlyph({ wrapped }: { wrapped: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4h12M2 8h12" />
      {wrapped ? (
        <>
          <path d="M2 12h7" />
          <path d="M11 10.5a2.5 2.5 0 0 1 2.5 2.5v1.2" />
          <path d="M12 13l1.5 1.5L15 13" />
        </>
      ) : (
        <path d="M2 12h12" />
      )}
    </svg>
  )
}

/** Facet axes get their own group: a family or an env is a different question than a tag. */
const TAG_AXES = ['family', 'env', 'tool', 'artifact', 'risk', 'locale', 'role', 'rev'] as const
const AXIS_LABEL: Record<string, string> = {
  family: 'Families',
  env: 'Env',
  tool: 'Tool',
  artifact: 'Artifact',
  risk: 'Risk',
  locale: 'Locale',
  role: 'Role',
  rev: 'Rev'
}

function splitFacetTags(entries: Array<{ tag: string; count: number }>) {
  const axes: Record<string, Array<{ tag: string; count: number }>> = {}
  const plain: Array<{ tag: string; count: number }> = []
  for (const entry of entries) {
    const match = entry.tag.match(/^([a-z]+):/)
    if (match && (TAG_AXES as readonly string[]).includes(match[1])) {
      ;(axes[match[1]] ??= []).push(entry)
    } else {
      plain.push(entry)
    }
  }
  for (const key of Object.keys(axes)) axes[key].sort((a, b) => b.count - a.count)
  return { axes, plain }
}

function FacetRow({ entry, active, onPick }: { entry: { tag: string; count: number }; active: boolean; onPick: () => void }) {
  return (
    <button className={`nav ${active ? 'active' : ''}`} onClick={onPick}>
      <TagLabel tag={entry.tag} /> <span>{entry.count.toLocaleString()}</span>
    </button>
  )
}

/** A tag written as `family:peer-review` reads better as the name plus a quiet pill. */
// Facet axes that get a pill: env, tool, artifact, risk, locale, role. A family is a
// workflow bundle and rev is a revision marker, both asked for earlier; they keep the
// same treatment until told otherwise.
const TAG_PREFIX = /^(env|tool|artifact|risk|locale|role|family|rev):(.+)$/i

function TagLabel({ tag }: { tag: string }) {
  const match = tag.match(TAG_PREFIX)
  if (!match) return <>#{tag}</>
  const prefix = match[1].toLowerCase()
  // One inline unit, so a flex row cannot push the pill away from its own tag.
  return (
    <span className="tag-text">
      <span className="tag-name">{match[2]}</span>
      <span className={`tag-prefix ${prefix}`}>{prefix}</span>
    </span>
  )
}

/**
 * Rendered markdown, with the one behaviour a document needs from its tables: a horizontal
 * bar that stays hidden until the reader reaches the bottom edge or starts scrolling, then
 * fades once the scrolling settles.
 */
function MarkdownBody({ text, className }: { text: string; className: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const cleanups: Array<() => void> = []
    for (const scroller of element.querySelectorAll<HTMLDivElement>('.md-table')) {
      let timer: number | undefined
      const reveal = () => {
        scroller.classList.add('is-active')
        window.clearTimeout(timer)
      }
      const settle = (delay: number) => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => scroller.classList.remove('is-active'), delay)
      }
      const onPointerMove = (event: PointerEvent) => {
        const box = scroller.getBoundingClientRect()
        if (event.clientY >= box.bottom - 14) reveal()
      }
      const onScroll = () => {
        reveal()
        settle(650)
      }
      const onLeave = () => settle(240)
      scroller.addEventListener('pointermove', onPointerMove)
      scroller.addEventListener('scroll', onScroll, { passive: true })
      scroller.addEventListener('pointerleave', onLeave)
      cleanups.push(() => {
        window.clearTimeout(timer)
        scroller.removeEventListener('pointermove', onPointerMove)
        scroller.removeEventListener('scroll', onScroll)
        scroller.removeEventListener('pointerleave', onLeave)
      })
    }
    return () => cleanups.forEach((run) => run())
  }, [text])

  return <div ref={host} className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
}

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [facets, setFacets] = useState<Facets | null>(null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [axisOpen, setAxisOpen] = useState<Record<string, boolean>>({})
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<
    (Skill & { body: string; package?: { entries: PackageEntry[]; counts: Record<string, number> }; drift?: Drift | null }) | null
  >(null)
  const [openRef, setOpenRef] = useState<{ name: string; rel: string; text: string; image: string | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [closedFolders, setClosedFolders] = useState<Record<string, boolean>>({})
  // Remembers whether markdown reads as prose or as source, across sessions.
  const [trashList, setTrashList] = useState<
    { id: number; name: string; moved_to: string; expires_at: string }[]
  >([])
  const [mdMode, setMdMode] = useState<'preview' | 'raw'>(() =>
    localStorage.getItem('skill-academy:md-mode') === 'raw' ? 'raw' : 'preview'
  )
  const [collapsedBlocks, setCollapsedBlocks] = useState<Record<string, boolean>>(() => {
    try {
      const stored = window.localStorage.getItem('skill-academy.collapsed-blocks')
      return stored ? (JSON.parse(stored) as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })

  function toggleBlock(key: string) {
    setCollapsedBlocks((current) => {
      const next = { ...current, [key]: !current[key] }
      try {
        window.localStorage.setItem('skill-academy.collapsed-blocks', JSON.stringify(next))
      } catch {
        /* a private window is not a reason to lose the toggle */
      }
      return next
    })
  }
  const [wrap, setWrap] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('skill-academy.wrap') === '1'
    } catch {
      return false
    }
  })

  function toggleWrap() {
    setWrap((value) => {
      const next = !value
      try {
        window.localStorage.setItem('skill-academy.wrap', next ? '1' : '0')
      } catch {
        /* private window */
      }
      return next
    })
  }
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [widths, setWidths] = useState<{ sidebar: number; detail: number | null }>({ sidebar: 236, detail: null })
  const [live, setLive] = useState(false)
  const [pending, setPending] = useState(0)
  const [editingAgents, setEditingAgents] = useState(false)
  const [hiddenAgents, setHiddenAgents] = useState<string[]>([])
  const [placements, setPlacements] = useState<Placement[] | null>(null)
  const [placementBusy, setPlacementBusy] = useState<string | null>(null)
  const [showAllAgents, setShowAllAgents] = useState(false)

  const dragRef = useRef<{ kind: 'sidebar' | 'detail'; x: number; value: number } | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)
  const loadingRef = useRef(false)

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

  function startDrag(kind: 'sidebar' | 'detail') {
    return (event: React.PointerEvent<HTMLDivElement>) => {
      const current = kind === 'detail' ? (widths.detail ?? event.currentTarget.previousElementSibling?.clientWidth ?? 568) : widths.sidebar
      dragRef.current = { kind, x: event.clientX, value: current }
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    const delta = event.clientX - drag.x
    if (drag.kind === 'sidebar') {
      setWidths((current) => ({ ...current, sidebar: clamp(drag.value + delta, 180, 380) }))
    } else {
      setWidths((current) => ({ ...current, detail: clamp(drag.value - delta, 420, 1100) }))
    }
  }

  function endDrag() {
    dragRef.current = null
  }

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 120)
    return () => clearTimeout(timer)
  }, [query])

  async function loadTrash() {
    try {
      const response = await fetch('/api/trash')
      if (!response.ok) return
      const payload = (await response.json()) as {
        entries?: { id: number; name: string; moved_to: string; expires_at: string }[]
      }
      setTrashList(payload.entries ?? [])
    } catch {
      /* offline is not an error worth a message */
    }
  }

  async function archiveCurrent() {
    if (!detail) return
    await fetch(`/api/skills/${detail.id}/archive`, { method: 'POST' })
    setSelected(null)
    await loadTrash()
    await loadState()
  }

  async function restoreFromTrash(id: number) {
    await fetch(`/api/trash/${id}/restore`, { method: 'POST' })
    await loadTrash()
    await loadState()
  }

  async function purgeFromTrash(id: number) {
    const entry = trashList.find((row) => row.id === id)
    if (!entry) return
    if (!window.confirm(`Send ${entry.name} to the Recycle Bin? This cannot be undone here.`)) return
    await fetch(`/api/trash/${id}/purge`, { method: 'POST' })
    await loadTrash()
  }

  async function loadState() {
    try {
      const [stateRes, facetsRes] = await Promise.all([fetch('/api/state'), fetch('/api/facets')])
      if (!stateRes.ok || !facetsRes.ok) throw new Error(`API ${stateRes.status}/${facetsRes.status}`)
      setState(await stateRes.json())
      const facetsPayload = await facetsRes.json()
      setFacets(facetsPayload)
      setHiddenAgents(facetsPayload.hidden ?? [])
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    loadState()
  }, [])

  function paramsFor(offset: number): string {
    const params = new URLSearchParams()
    if (debounced) params.set('q', debounced)
    if (scope.kind === 'agent') params.set('root', scope.path)
    if (scope.kind === 'tag') params.set('tag', scope.tag)
    if (scope.kind === 'category') params.set('category', scope.category)
    if (scope.kind === 'health') params.set('health', '1')
    params.set('limit', String(PAGE))
    params.set('offset', String(offset))
    return params.toString()
  }

  async function fetchPage(offset: number, replace: boolean) {
    const requestId = ++requestRef.current
    loadingRef.current = true
    setLoadingMore(true)
    try {
      const response = await fetch(`/api/skills?${paramsFor(offset)}`)
      if (!response.ok) throw new Error(`skills ${response.status}`)
      const payload = await response.json()
      if (requestId !== requestRef.current) return
      setSkills((previous) => {
        if (replace) return payload.rows
        const seen = new Set(previous.map((skill) => skill.id))
        return [...previous, ...payload.rows.filter((skill: Skill) => !seen.has(skill.id))]
      })
      setTotal(payload.total)
      setHasMore(offset + payload.rows.length < payload.total)
      setError(null)
    } catch (cause) {
      if (requestId === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestId === requestRef.current) {
        loadingRef.current = false
        setLoadingMore(false)
      }
    }
  }

  const fetchPageRef = useRef(fetchPage)
  fetchPageRef.current = fetchPage

  useEffect(() => {
    const source = new EventSource('/api/events')
    source.onopen = () => setLive(true)
    source.onerror = () => setLive(false)
    source.onmessage = (event) => {
      setLive(true)
      try {
        const payload = JSON.parse(event.data)
        if (payload?.type !== 'library') return
      } catch {
        return
      }
      loadState()
      if ((pageRef.current?.scrollTop ?? 0) < 120) {
        fetchPageRef.current(0, true)
        setPending(0)
      } else {
        setPending((value) => value + 1)
      }
    }
    return () => source.close()
    // The stream is opened once; it reads the current fetch through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setSelected(null)
    setDetail(null)
    if (pageRef.current) pageRef.current.scrollTop = 0
    fetchPage(0, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, scope])

  function loadMore() {
    if (!hasMore || loadingRef.current) return
    fetchPage(skills.length, false)
  }

  function onPageScroll(element: HTMLDivElement) {
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 900) loadMore()
  }

  useEffect(() => {
    if (selected === null) {
      setDetail(null)
      setPlacements(null)
      return
    }
    let alive = true
    fetch(`/api/skills/${selected}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((payload) => alive && setDetail(payload))
      .catch(() => alive && setDetail(null))
    setOpenRef(null)
    fetch(`/api/placements?skillId=${selected}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((payload) => alive && setPlacements(payload.placements))
      .catch(() => alive && setPlacements(null))
    return () => {
      alive = false
    }
  }, [selected])

  async function togglePlacement(placement: Placement) {
    if (!detail || placement.state === 'native') return
    const action = placement.state === 'on' ? 'off' : 'on'
    setPlacementBusy(placement.agent)
    try {
      const response = await fetch('/api/placements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: detail.id, agent: placement.agent, action })
      })
      const payload = await response.json()
      if (!response.ok && payload.error === 'blocked-by-scan') {
        const lines = (payload.findings as Finding[])
          .map((finding) => `${finding.file}:${finding.line}  ${finding.code}`)
          .join('\n')
        const go = window.confirm(
          `This skill failed the content scan.\n\n${lines}\n\nEnable it anyway? The override is recorded.`
        )
        if (go) {
          const retry = await fetch('/api/placements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skillId: detail.id, agent: placement.agent, action, override: true, reason: 'confirmed in app' })
          })
          const retried = await retry.json()
          if (!retry.ok) throw new Error(retried.error ?? `placement ${retry.status}`)
          setPlacements((current) =>
            current
              ? current.map((row) => (row.agent === placement.agent ? { ...row, state: retried.state, mode: retried.mode } : row))
              : current
          )
          setError(null)
          return
        }
        throw new Error('blocked by content scan')
      }
      if (!response.ok) throw new Error(payload.error ?? `placement ${response.status}`)
      setPlacements((current) =>
        current
          ? current.map((row) => (row.agent === placement.agent ? { ...row, state: payload.state, mode: payload.mode } : row))
          : current
      )
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPlacementBusy(null)
    }
  }

  async function openReference(entry: PackageEntry) {
    if (!detail) return
    try {
      const response = await fetch(`/api/skills/${detail.id}/file?rel=${encodeURIComponent(entry.relPath)}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `file ${response.status}`)
      setOpenRef({
        name: entry.name,
        rel: entry.relPath,
        text: payload.image ? '' : payload.text,
        image: payload.image ?? null
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function reveal(entry: PackageEntry) {
    if (!detail) return
    const absolute = `${detail.path.replace(/[\\/]+$/, '')}\\${entry.relPath.replace(/\//g, '\\')}`
    try {
      const response = await fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: absolute })
      })
      if (!response.ok) throw new Error((await response.json()).error ?? `reveal ${response.status}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function toggleAllAgents(hidden: boolean) {
    const previous = hiddenAgents
    const agents = (facets?.agents ?? []).map((entry) => entry.agent)
    setHiddenAgents(hidden ? [...new Set([...hiddenAgents, ...agents])] : [])
    if (hidden) setScope({ kind: 'all' })
    try {
      const response = await fetch('/api/agents/visibility-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden })
      })
      if (!response.ok) throw new Error(`visibility ${response.status}`)
      const payload = await response.json()
      setHiddenAgents(payload.hiddenAgents)
    } catch (cause) {
      setHiddenAgents(previous)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function scan() {
    setScanning(true)
    try {
      const response = await fetch('/api/scan', { method: 'POST' })
      if (!response.ok) throw new Error(`scan ${response.status}`)
      await loadState()
      setScope({ kind: 'all' })
      setQuery('')
      await fetchPage(0, true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setScanning(false)
    }
  }

  async function toggleAgent(agent: string) {
    const shouldHide = !hiddenAgents.includes(agent)
    const previous = hiddenAgents
    setHiddenAgents(shouldHide ? [...hiddenAgents, agent] : hiddenAgents.filter((name) => name !== agent))
    if (shouldHide && scope.kind === 'agent' && scope.agent === agent) setScope({ kind: 'all' })
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent)}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: shouldHide })
      })
      if (!response.ok) throw new Error(`visibility ${response.status}`)
      const payload = await response.json()
      setHiddenAgents(payload.hiddenAgents)
    } catch (cause) {
      setHiddenAgents(previous)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const scopeLabel = useMemo(() => {
    if (scope.kind === 'all') return 'All skills'
    if (scope.kind === 'health') return 'Needs attention'
    if (scope.kind === 'tag') return `#${scope.tag}`
    if (scope.kind === 'category') return scope.category
    if (scope.kind === 'agent') return scope.agent
    return 'All skills'
  }, [scope, facets])

  function renderTree(nodes: PkgNode[], depth: number, kind: string) {
    return nodes.flatMap((node) => {
      const indent = 8 + depth * 11
      if (!node.entry) {
        const key = `${kind}:${node.path}`
        const isOpen = !closedFolders[key]
        const files = node.children.reduce((sum, child) => sum + (child.entry ? 1 : child.children.length), 0)
        return [
          <button
            className="pkg-folder"
            key={node.path}
            style={{ paddingLeft: indent }}
            aria-expanded={isOpen}
            onClick={() => setClosedFolders((previous) => ({ ...previous, [key]: !previous[key] }))}
          >
            <svg className={`folder-chevron${isOpen ? ' open' : ''}`} width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
              <path d="M2.4 1.2 5.2 4 2.4 6.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <svg className="folder-icon" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M1.6 3.4a.9.9 0 0 1 .9-.9h3.1l1.3 1.6h6.6a.9.9 0 0 1 .9.9v7.2a.9.9 0 0 1-.9.9H2.5a.9.9 0 0 1-.9-.9z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            <span className="pkg-folder-name">{node.name}</span>
            <span className="pkg-meta">{files}</span>
          </button>,
          ...(isOpen ? renderTree(node.children, depth + 1, kind) : [])
        ]
      }
      const entry = node.entry
      const image = isImagePath(entry.relPath)
      return [
        <button
          className={`pkg-row${image ? ' is-image' : ''}`}
          key={entry.relPath}
          style={{ paddingLeft: indent }}
          title={`${entry.relPath}${entry.description ? ` — ${entry.description}` : ''}`}
          onClick={() => (kind === 'asset' && !image ? void reveal(entry) : void openReference(entry))}
        >
          <span className="pkg-name">{entry.name}</span>
          <span className="pkg-meta">
            {image ? 'image' : entry.description ? entry.description.slice(0, 70) : entry.relPath}
          </span>
        </button>
      ]
    })
  }

  return (
    <div className="app">
      <div className="menubar">
        <div className="mb-left">
          <span className="brand">
            <AcademyMark />
            <span className="brand-name">Skill Academy</span>
          </span>
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Skills</span>
          <span>Sources</span>
          <span>Help</span>
        </div>
        <div className="searchwrap">
          <input
            className="search"
            placeholder="Filter by name, description or tag"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="toolbar-right">
          <a className="ghost btn-quiet" href="/dev">
            Dev panel
          </a>
          <button className="btn primary" onClick={scan} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
          <button
            className="ghost iconbtn"
            onClick={() => setSettingsOpen((value) => !value)}
            title="Settings"
            aria-label="Settings"
            aria-expanded={settingsOpen}
          >
            <GearGlyph />
          </button>
          {settingsOpen && state && (
            <div className="settings-pop" role="dialog" aria-label="Settings">
              <div className="sp-head">Settings</div>
              <div className="sp-row">
                <span>Data folder</span>
                <code>{state.dataDir}</code>
              </div>
              <div className="sp-row">
                <span>Index</span>
                <code>{state.dbPath}</code>
              </div>
              <div className="sp-row">
                <span>Roots detected</span>
                <span>
                  {state.registry.detected} of {state.registry.roots}
                </span>
              </div>
              <div className="sp-row">
                <span>Skills indexed</span>
                <span>
                  {fmt.format(state.library.skills)} · {fmt.format(state.library.tokens)} tokens
                </span>
              </div>
              <div className="sp-row">
                <span>Version</span>
                <span>{state.version}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <div className="banner error">API error: {error}</div>}
      {pending > 0 && (
        <div className="banner">
          {pending} {pending === 1 ? 'change' : 'changes'} while you were reading ·{' '}
          <button
            className="ghost"
            onClick={() => {
              setPending(0)
              fetchPage(0, true)
              if (pageRef.current) pageRef.current.scrollTop = 0
            }}
          >
            Refresh
          </button>
        </div>
      )}

      <div className="panes">
        <aside className="sidebar" style={{ width: widths.sidebar, flexBasis: widths.sidebar }}>
          <ScrollPane className="sidebar-scroll">
          <button className={`nav ${scope.kind === 'all' ? 'active' : ''}`} onClick={() => setScope({ kind: 'all' })}>
            All skills <span>{state ? fmt.format(state.library.skills) : ''}</span>
          </button>
          <button
            className={`nav ${scope.kind === 'health' ? 'active' : ''}`}
            onClick={() => setScope({ kind: 'health' })}
          >
            Needs attention <span>{state ? fmt.format(state.library.issues) : ''}</span>
          </button>
          {trashList.length > 0 && <div className="group">Trash</div>}
          {trashList.map((entry) => (
            <div className="nav trash-row" key={entry.id} title={`Archived to ${entry.moved_to}`}>
              <span className="name">{entry.name}</span>
              <div className="head-actions">
                <button
                  className="ghost iconbtn"
                  title="Restore"
                  aria-label={`Restore ${entry.name}`}
                  onClick={() => void restoreFromTrash(entry.id)}
                >
                  <RestoreGlyph />
                </button>
                <button
                  className="ghost iconbtn"
                  title="Delete permanently"
                  aria-label={`Delete ${entry.name}`}
                  onClick={() => void purgeFromTrash(entry.id)}
                >
                  <TrashGlyph />
                </button>
              </div>
            </div>
          ))}

          <div className="group head">
            <span>Agents</span>
            <div className="head-actions">
              {editingAgents && (() => {
                const all = (facets?.agents ?? []).map((entry) => entry.agent)
                const everyHidden = all.length > 0 && all.every((agent) => hiddenAgents.includes(agent))
                return (
                  <button
                    className="ghost iconbtn"
                    onClick={() => void toggleAllAgents(!everyHidden)}
                    title={everyHidden ? 'Select all agents' : 'Deselect all agents'}
                    aria-label={everyHidden ? 'Select all agents' : 'Deselect all agents'}
                    aria-pressed={!everyHidden}
                  >
                    <SelectAllGlyph checked={!everyHidden} />
                  </button>
                )
              })()}
              <button
                className="ghost iconbtn"
                onClick={() => setEditingAgents((value) => !value)}
                title={editingAgents ? 'Done editing' : 'Edit agent visibility'}
                aria-label={editingAgents ? 'Done editing' : 'Edit agent visibility'}
                aria-pressed={editingAgents}
              >
                <PencilGlyph />
              </button>
            </div>
          </div>
          {facets?.agents
            .filter((agent) => editingAgents || !hiddenAgents.includes(agent.agent))
            .map((agent) => {
              const isHidden = hiddenAgents.includes(agent.agent)
              const active =
                scope.kind === 'agent' && scope.path === agent.path && scope.agent === agent.agent && !editingAgents
              return (
                <button
                  key={`${agent.agent}:${agent.path}`}
                  className={`nav root ${active ? 'active' : ''} ${isHidden ? 'is-hidden' : ''}`}
                  onClick={() => (editingAgents ? void toggleAgent(agent.agent) : setScope({ kind: 'agent', agent: agent.agent, path: agent.path }))}
                  title={editingAgents ? `${agent.agent} — ${isHidden ? 'hidden' : 'shown'}` : agent.path}
                >
                  <span className="name">{agent.agent}{agent.origin === 'host' && <em className="badge">host</em>}</span>
                  {editingAgents ? (
                    <Switch on={!isHidden} />
                  ) : (
                    <span>{fmt.format(agent.count)}</span>
                  )}
                </button>
              )
            })}

          {facets && facets.categories.length > 0 && <div className="group">Categories</div>}
          {facets?.categories.slice(0, 10).map((entry) => (
            <button
              key={entry.category}
              className={`nav root ${scope.kind === 'category' && scope.category === entry.category ? 'active' : ''}`}
              onClick={() => setScope({ kind: 'category', category: entry.category })}
              title="Category declared in frontmatter"
            >
              {entry.category} <span>{fmt.format(entry.count)}</span>
            </button>
          ))}
          {facets &&
            (() => {
              const { axes, plain } = splitFacetTags(facets.tags)
              const axisNames = TAG_AXES.filter((axis) => (axes[axis]?.length ?? 0) > 0)
              return (
                <>
                  {axisNames.map((axis) => {
                    const entries = axes[axis]
                    const open = axisOpen[axis] === true
                    const visible = open ? entries : entries.slice(0, 8)
                    return (
                      <div key={axis}>
                        <div className="group">
                          {AXIS_LABEL[axis]} <span className="groupcount">{entries.length}</span>
                        </div>
                        {visible.map((entry) => (
                          <FacetRow
                            key={entry.tag}
                            entry={entry}
                            active={scope.kind === 'tag' && scope.tag === entry.tag}
                            onPick={() => setScope({ kind: 'tag', tag: entry.tag })}
                          />
                        ))}
                        {entries.length > 8 && (
                          <button
                            className="nav more"
                            onClick={() => setAxisOpen((previous) => ({ ...previous, [axis]: !open }))}
                          >
                            {open ? 'Show fewer' : `${entries.length - 8} more`}
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {plain.length > 0 && <div className="group">Tags</div>}
                  {plain.slice(0, 10).map((entry) => (
                    <FacetRow
                      key={entry.tag}
                      entry={entry}
                      active={scope.kind === 'tag' && scope.tag === entry.tag}
                      onPick={() => setScope({ kind: 'tag', tag: entry.tag })}
                    />
                  ))}
                </>
              )
            })()}
          {compareOpen && detail?.drift && (
            <div className="compare-panel" role="dialog" aria-label="Compare with latest">
              <div className="cp-head">
                <span>Compare with latest</span>
                <button className="ghost iconbtn" onClick={() => setCompareOpen(false)} aria-label="Close">
                  ×
                </button>
              </div>
              <p>
                This copy is <b>v{detail.drift.thisVersion}</b>. The newest copy is{' '}
                <b>v{detail.drift.latestVersion}</b> in <code>{detail.drift.latestRoot}</code>.
              </p>
              <p className="cp-planned">
                Planned: an AI pass reads both copies, reports anything only this copy knows, folds it into the newest
                text, then replaces this copy with that result.
              </p>
            </div>
          )}
          </ScrollPane>
        </aside>

        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startDrag('sidebar')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />

        <section className="list">
          <ScrollPane bodyRef={pageRef} onScroll={onPageScroll}>
          <div className="listhead">
            <span className="scope">{scopeLabel}</span>
            <span className="count">
              {fmt.format(total)} {total === 1 ? 'skill' : 'skills'}
              {skills.length < total ? ` · ${fmt.format(skills.length)} loaded` : ''}
            </span>
          </div>
          {skills.map((skill) => (
            <button
              key={skill.id}
              className={`row ${selected === skill.id ? 'selected' : ''}`}
              onClick={() => setSelected(skill.id)}
            >
              <span
                className={`dot ${skill.health.length ? 'warn' : ''} ${skill.risk === 'high' ? 'risk' : ''}`}
                title={skill.risk === 'high' ? 'Content scan: high risk' : undefined}
              />
              <span className="meta">
                <span className="title">
                  {skill.name}
                  {skill.version ? <span className="ver">v{skill.version.replace(/^v/i, '')}</span> : null}
                  {skill.repo ? <span className="repo">{skill.repo}</span> : null}
                </span>
                <span className="desc">{skill.description || 'No description'}</span>
              </span>
              <span className="tokens">{fmt.format(skill.tokens)}</span>
            </button>
          ))}
          {loadingMore && <div className="listfoot">Loading…</div>}
          {!hasMore && skills.length > 0 && <div className="listfoot">{fmt.format(total)} total</div>}
          {skills.length === 0 && !loadingMore && (
            <div className="empty">Nothing matches. Clear the filter or scan.</div>
          )}
          </ScrollPane>
        </section>

        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startDrag('detail')}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />

        <aside className="detail" style={widths.detail ? { width: widths.detail, flexBasis: widths.detail } : undefined}>
          <ScrollPane axis={wrap ? 'y' : 'both'} className="detail-scroll">
          {!detail && <div className="empty">Select a skill to read it.</div>}
          {detail && (
            <div className="detail-inner">
              <div className="detailhead">
                <h1>{detail.name}</h1>
                <button className="btn archive" onClick={() => void archiveCurrent()}>
                  Archive
                </button>
                <MarkdownModeSwitch mode={mdMode} onChange={setMdMode} />
                <button
                  className="ghost wrapbtn"
                  onClick={toggleWrap}
                  title={wrap ? 'Unwrap lines' : 'Wrap lines'}
                  aria-label={wrap ? 'Unwrap lines' : 'Wrap lines'}
                  aria-pressed={wrap}
                >
                  <WrapGlyph wrapped={wrap} />
                </button>
              </div>
              <div className="path">{detail.path}</div>
              <div className="chips">
                {detail.version ? <span className="chip version">v{detail.version.replace(/^v/i, '')}</span> : null}
                {detail.category ? <span className="chip category">{detail.category}</span> : null}
                {detail.tags.map((tag) => (
                  <span className="chip" key={tag}>
                    <TagLabel tag={tag} />
                  </span>
                ))}
                <span className="chip">{fmt.format(detail.tokens)} tokens</span>
                <span className="chip">{fmt.format(detail.body_chars)} chars</span>
              </div>
              {detail.risk === 'high' && detail.findings.length > 0 && (
                <div className="scanblock" role="note">
                  <div className="scanhead">
                    Content scan
                    <span className="riskpill">high</span>
                  </div>
                  <ul className="scanlist">
                    {detail.findings.slice(0, 6).map((finding) => (
                      <li key={`${finding.file}:${finding.line}`}>
                        <button
                          className="scanwhere"
                          onClick={() =>
                            void openReference({
                              name: finding.file.split('/').pop() ?? finding.file,
                              relPath: finding.file
                            } as PackageEntry)
                          }
                          title={finding.excerpt}
                        >
                          {finding.file}:{finding.line}
                        </button>
                        <span className="scanwhy">{finding.code}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.drift && (
                <div className="drift">
                  <span className="drift-text">
                    Behind: this copy is <b>v{detail.drift.thisVersion}</b>, and <b>v{detail.drift.latestVersion}</b> exists
                    in another folder.
                  </span>
                  <button className="btn primary drift-action" onClick={() => setCompareOpen(true)}>
                    Compare with latest
                  </button>
                </div>
              )}
              {placements && (
                <div className="placements">
                  <BlockHead
                    label="Agents"
                    meta={`${placements.filter((row) => row.state !== 'off').length} of ${placements.length}`}
                    open={!collapsedBlocks.agents}
                    onToggle={() => toggleBlock('agents')}
                  />
                  {!collapsedBlocks.agents && (
                    <>
                  {placements
                    .filter((row) => showAllAgents || row.state !== 'off')
                    .map((row) => (
                      <div className="pl-row" key={`${row.agent}:${row.root}`}>
                        <span className="pl-name">{row.agent}</span>
                        {row.state === 'native' ? (
                          <button
                            className="pl-switch"
                            disabled
                            aria-pressed="true"
                            title={`Lives in ${row.root}`}
                            aria-label={`${detail.name} lives in ${row.agent}'s own folder`}
                          >
                            <Switch on />
                          </button>
                        ) : (
                          <button
                            className="pl-switch"
                            onClick={() => void togglePlacement(row)}
                            disabled={placementBusy === row.agent}
                            title={`${row.state === 'on' ? 'Disable' : 'Enable'} in ${row.agent}${row.mode ? ` (${row.mode})` : ''}`}
                            aria-pressed={row.state === 'on'}
                            aria-label={`${row.state === 'on' ? 'Disable' : 'Enable'} ${detail.name} in ${row.agent}`}
                          >
                            <Switch on={row.state === 'on'} />
                          </button>
                        )}
                      </div>
                    ))}
                  {placements.some((row) => row.state === 'off') && (
                    <button className="ghost tiny pl-more" onClick={() => setShowAllAgents((value) => !value)}>
                      {showAllAgents
                        ? 'Fewer agents'
                        : `Show ${placements.filter((row) => row.state === 'off').length} available`}
                    </button>
                  )}
                    </>
                  )}
                </div>
              )}
              {detail.package && detail.package.entries.length > 0 && (
                <div className="pkg">
                  {(
                    [
                      ['reference', 'References'],
                      ['script', 'Scripts'],
                      ['asset', 'Assets']
                    ] as const
                  ).map(([kind, label]) => {
                    const rows = detail.package!.entries.filter((entry) => entry.kind === kind)
                    if (rows.length === 0) return null
                    return (
                      <div className="pkg-group" key={kind}>
                        <BlockHead
                          label={label}
                          meta={rows.length}
                          open={!collapsedBlocks[`pkg:${kind}`]}
                          onToggle={() => toggleBlock(`pkg:${kind}`)}
                        />
                        {!collapsedBlocks[`pkg:${kind}`] &&
                          renderTree(buildPackageTree(rows), 0, kind)}
                      </div>
                    )
                  })}
                </div>
              )}
              {detail.health.length > 0 && (
                <div className="issues">
                  {detail.health.map((issue, index) => (
                    <div className="issue" key={`${issue.code}-${index}`}>
                      <b>{issue.code}</b>
                      <span>{issue.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {detail && !openRef && mdMode === 'preview' && (
            <MarkdownBody text={detail.body || '_Empty body._'} className={`md body${wrap ? ' wrapped' : ''}`} />
          )}
          {detail && !openRef && mdMode === 'raw' && (
            <pre className={`body raw${wrap ? ' wrapped' : ''}`}>{detail.body || 'Empty body.'}</pre>
          )}
          {detail && openRef && (
            <div className="refview">
              <div className="refbar">
                <button className="ghost tiny" onClick={() => setOpenRef(null)}>
                  ← {detail.name}
                </button>
                <span className="refbar-name">{openRef.name}</span>
                {(extensionOf(openRef.rel) === '.md' || extensionOf(openRef.rel) === '.markdown') && (
                  <MarkdownModeSwitch mode={mdMode} onChange={setMdMode} />
                )}
              </div>
              {openRef.image ? (
                <div className="refimg-wrap">
                  <img className="refimg" src={openRef.image} alt={openRef.name} />
                </div>
              ) : extensionOf(openRef.rel) === '.md' || extensionOf(openRef.rel) === '.markdown' ? (
                mdMode === 'preview' ? (
                  <MarkdownBody text={openRef.text} className="md body" />
                ) : (
                  <pre className="body raw">{openRef.text}</pre>
                )
              ) : (
                <pre className="body code">
                  {highlight(openRef.text, extensionOf(openRef.rel)).map((token, position) =>
                    token.cls ? (
                      <span className={token.cls} key={position}>
                        {token.text}
                      </span>
                    ) : (
                      token.text
                    )
                  )}
                </pre>
              )}
            </div>
          )}
          </ScrollPane>
        </aside>
      </div>

      <div className="statusbar">
        <span className="live">
          <i className={live ? 'on' : ''} />
          {state ? `watching ${state.watching} roots` : 'connecting…'}
        </span>
        <span className="mid">
          {state ? `${fmt.format(state.library.tokens)} tokens across ${fmt.format(state.library.skills)} skills` : ''}
        </span>
        <span className="right">{state ? `v${state.version} · scan ${ago(state.lastScanAt)}` : ''}</span>
      </div>
    </div>
  )
}

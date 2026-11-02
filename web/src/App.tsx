import { useEffect, useMemo, useRef, useState } from 'react'

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
  health: Issue[]
  mtime: string
  version?: string
  repo?: string
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
  issues: number
}

type Scope =
  | { kind: 'all' }
  | { kind: 'health' }
  | { kind: 'agent'; agent: string; path: string }
  | { kind: 'tag'; tag: string }

const fmt = new Intl.NumberFormat()
const PAGE = 120

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
    const horizontal = measure(element.clientWidth, element.scrollWidth, element.scrollLeft)
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

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [facets, setFacets] = useState<Facets | null>(null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<(Skill & { body: string; package?: { entries: PackageEntry[]; counts: Record<string, number> } }) | null>(null)
  const [openRef, setOpenRef] = useState<{ name: string; text: string } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
      setOpenRef({ name: entry.name, text: payload.text })
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
    if (scope.kind === 'agent') return scope.agent
    return 'All skills'
  }, [scope, facets])

  return (
    <div className="app">
      <div className="menubar">
        <div className="mb-left">
          <b>Skill Academy</b>
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

          {facets && facets.tags.length > 0 && <div className="group">Tags</div>}
          {facets?.tags.slice(0, 10).map((entry) => (
            <button
              key={entry.tag}
              className={`nav ${scope.kind === 'tag' && scope.tag === entry.tag ? 'active' : ''}`}
              onClick={() => setScope({ kind: 'tag', tag: entry.tag })}
            >
              #{entry.tag} <span>{fmt.format(entry.count)}</span>
            </button>
          ))}
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
              <span className={`dot ${skill.health.length ? 'warn' : ''}`} />
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
          <ScrollPane axis="both" className="detail-scroll">
          {!detail && <div className="empty">Select a skill to read it.</div>}
          {detail && (
            <div className="detail-inner">
              <div className="detailhead">
                <h1>{detail.name}</h1>
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
                {detail.tags.map((tag) => (
                  <span className="chip" key={tag}>
                    #{tag}
                  </span>
                ))}
                <span className="chip">{fmt.format(detail.tokens)} tokens</span>
                <span className="chip">{fmt.format(detail.body_chars)} chars</span>
              </div>
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
                          rows.slice(0, 12).map((entry) => (
                          <button
                            className="pkg-row"
                            key={entry.relPath}
                            title={`${entry.relPath}${entry.description ? ` — ${entry.description}` : ''}`}
                            onClick={() =>
                              kind === 'asset'
                                ? void reveal(entry)
                                : void openReference(entry)
                            }
                          >
                            <span className="pkg-name">{entry.name}</span>
                            <span className="pkg-meta">
                              {kind === 'asset' ? 'reveal' : entry.description ? entry.description.slice(0, 70) : entry.relPath}
                            </span>
                          </button>
                        ))}
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
          {detail && !openRef && (
            <pre className={`body ${wrap ? 'wrapped' : ''}`}>{detail.body || 'Empty body.'}</pre>
          )}
          {detail && openRef && (
            <div className="refview">
              <div className="refbar">
                <button className="ghost tiny" onClick={() => setOpenRef(null)}>
                  ← {detail.name}
                </button>
                <span>{openRef.name}</span>
              </div>
              <pre className="body">{openRef.text}</pre>
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

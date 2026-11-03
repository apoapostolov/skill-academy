import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Versioning from './Monitor'
import { SourcesDialog } from './Sources'
import { SyncDialog } from './Sync'
import { GroupPlanDialog, ImproveDialog, MoveDialog, TrashView } from './Merge'
import { DraftEditor, DraftList, type DraftRow } from './Write'
import {
  WorkspaceDetail,
  WorkspaceRows,
  WorkspaceSidebar,
  type CompareRow,
  type CompareView,
  type WorkspaceRow
} from './Workspaces'
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

interface ProviderRow {
  id: string
  label: string
  kind: string
  base: string
  needsKey: boolean
  models: string[]
  configured: boolean
  hint: string | null
  requiresSignIn: boolean
  baseEditable: boolean
}

interface OAuthWatch {
  status: string
  account: string
  message: string
}

interface OAuthRow {
  id: string
  label: string
  kind: 'device' | 'authorize' | 'codex'
  note: string
  allowsTokenImport: boolean
  connected: boolean
  account: string
  expiresAt: string | null
  mode: string | null
  watch?: OAuthWatch | null
}

interface ImproveFinding {
  rule: string
  severity: 'error' | 'warn' | 'info'
  skill: string
  path: string
  detail: string
}

interface ConsolidateMemberView {
  name: string
  path: string
  version: string | null
  chars: number
  uniqueHeadings: string[]
}

interface FoldView {
  key: string
  survivor: string
  model: string
  ms: number
  chars: number
  keptRules: number
  totalRules: number
  droppedRules: string[]
  inventedLines: string[]
  status: 'clean' | 'lossy'
  message?: string
  text: string
}

interface ConsolidateGroupView {
  key: string
  liveRoot?: boolean
  mergeType: string
  evidence: string
  survivor: string | null
  members: ConsolidateMemberView[]
  plan: null | { survivor: string; pointerize: Array<{ name: string }>; routerize: Array<{ name: string; outline: string[] }>; rewire: string[] }
  blocked: string | null
}

interface Facets {
  agents: { agent: string; path: string; origin: string; count: number; archived?: number; tokens: number }[]
  hidden: string[]
  tags: { tag: string; count: number }[]
  categories: { category: string; count: number }[]
  issues: number
}

type Scope =
  | { kind: 'all' }
  | { kind: 'health' }
  | { kind: 'trash' }
  | { kind: 'drafts' }
  | { kind: 'workspace'; id: number }
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
      <TagLabel tag={entry.tag} withPill={false} /> <span>{entry.count.toLocaleString()}</span>
    </button>
  )
}

/** A tag written as `family:peer-review` reads better as the name plus a quiet pill. */
// Facet axes that get a pill: env, tool, artifact, risk, locale, role. A family is a
// workflow bundle and rev is a revision marker, both asked for earlier; they keep the
// same treatment until told otherwise.
const TAG_PREFIX = /^(env|tool|artifact|risk|locale|role|family|rev):(.+)$/i

function TagLabel({ tag, withPill = true }: { tag: string; withPill?: boolean }) {
  const match = tag.match(TAG_PREFIX)
  if (!match) return <>#{tag}</>
  const prefix = match[1].toLowerCase()
  // One inline unit, so a flex row cannot push the pill away from its own tag.
  return (
    <span className="tag-text">
      <span className="tag-name">#{match[2]}</span>
      {withPill && <span className={`tag-prefix ${prefix}`}>{prefix}</span>}
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
      // A bar drawn by us rather than by the platform: it overlays the table instead of
      // reserving a lane, follows the scroll position, and fades when the reader stops.
      const thumb = document.createElement('span')
      thumb.className = 'md-thumb'
      thumb.setAttribute('aria-hidden', 'true')
      scroller.appendChild(thumb)

      let timer: number | undefined
      const paint = () => {
        const track = scroller.clientWidth
        const total = scroller.scrollWidth
        if (total <= track + 1) {
          thumb.style.width = '0px'
          return
        }
        const width = Math.max(28, (track / total) * track)
        const maxLeft = track - width
        const ratio = total - track > 0 ? scroller.scrollLeft / (total - track) : 0
        thumb.style.width = `${Math.round(width)}px`
        thumb.style.transform = `translateX(${Math.round(maxLeft * ratio)}px)`
      }
      const reveal = () => {
        scroller.classList.add('is-active')
        thumb.classList.add('is-visible')
        window.clearTimeout(timer)
        paint()
      }
      const settle = (delay: number) => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          scroller.classList.remove('is-active')
          thumb.classList.remove('is-visible')
        }, delay)
      }
      const onPointerMove = (event: PointerEvent) => {
        const box = scroller.getBoundingClientRect()
        if (event.clientY >= box.bottom - 16) reveal()
      }
      const onScroll = () => {
        reveal()
        settle(700)
      }
      const onLeave = () => settle(260)

      paint()
      scroller.addEventListener('pointermove', onPointerMove)
      scroller.addEventListener('scroll', onScroll, { passive: true })
      scroller.addEventListener('pointerleave', onLeave)
      cleanups.push(() => {
        window.clearTimeout(timer)
        scroller.removeEventListener('pointermove', onPointerMove)
        scroller.removeEventListener('scroll', onScroll)
        scroller.removeEventListener('pointerleave', onLeave)
        thumb.remove()
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
    (Skill & { body: string; package?: { entries: PackageEntry[]; counts: Record<string, number> }; drift?: Drift | null; sameVersionDrift?: Array<{ id: number; path: string; root: string; version: string }> }) | null
  >(null)
  const [openRef, setOpenRef] = useState<{ name: string; rel: string; text: string; image: string | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [providersOpen, setProvidersOpen] = useState(false)
  const [providerRows, setProviderRows] = useState<ProviderRow[] | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})
  const [providerNotes, setProviderNotes] = useState<Record<string, string>>({})
  const [baseDrafts, setBaseDrafts] = useState<Record<string, string>>({})
  const [oauthRows, setOauthRows] = useState<OAuthRow[]>([])
  const [oauthFlows, setOauthFlows] = useState<
    Record<string, { flowId: string; code?: string; url?: string; status: string; message?: string }>
  >({})
  const [oauthCode, setOauthCode] = useState('')
  const [oauthBusy, setOauthBusy] = useState<string>('')
  const [copiedCode, setCopiedCode] = useState('')
  const [reviewOpen, setReviewOpen] = useState<'improve' | 'consolidate' | null>(null)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [moveTarget, setMoveTarget] = useState<{ id: number; name: string; path: string } | null>(null)
  const [improveTarget, setImproveTarget] = useState<{ id: number; name: string } | null>(null)
  const [planGroup, setPlanGroup] = useState<ConsolidateGroupView | null>(null)
  const [trashSelecting, setTrashSelecting] = useState(false)
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [activeDraft, setActiveDraft] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [workspaceView, setWorkspaceView] = useState<CompareView | null>(null)
  const [workspaceRow, setWorkspaceRow] = useState<CompareRow | null>(null)
  const [workspaceRefresh, setWorkspaceRefresh] = useState(0)
  const [trashWipeAsk, setTrashWipeAsk] = useState(false)
  const [improveFindings, setImproveFindings] = useState<ImproveFinding[]>([])
  const [improveRule, setImproveRule] = useState('')
  const [consolidateGroups, setConsolidateGroups] = useState<ConsolidateGroupView[]>([])
  const [consolidateSummary, setConsolidateSummary] = useState<Record<string, number>>({})
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewOpenKey, setReviewOpenKey] = useState('')
  const [fold, setFold] = useState<FoldView | null>(null)
  const [foldBusy, setFoldBusy] = useState('')
  const [foldRead, setFoldRead] = useState(false)
  const [foldApplied, setFoldApplied] = useState('')
  const [modelProvider, setModelProvider] = useState('')
  const [modelList, setModelList] = useState<string[]>([])
  const [modelChoice, setModelChoice] = useState('')
  const [modelAt, setModelAt] = useState<string | null>(null)
  const [modelCached, setModelCached] = useState(false)
  const [githubToken, setGithubToken] = useState('')
  const [githubNote, setGithubNote] = useState('')

  async function openProviders() {
    setProvidersOpen(true)
    await refreshProviders()
    await refreshOAuth()
    try {
      const response = await fetch('/api/github/status')
      const payload = (await response.json()) as { configured: boolean; source: string | null; remaining: number; limit: number }
      setGithubNote(
        payload.configured
          ? `${payload.source === 'environment' ? 'from the environment' : 'saved'} · ${payload.remaining}/${payload.limit} calls left`
          : 'no token · 60 calls an hour, shared with everything on this machine'
      )
    } catch {
      setGithubNote('status unavailable')
    }
  }

  async function refreshProviders() {
    try {
      const response = await fetch('/api/providers')
      const payload = (await response.json()) as { providers: ProviderRow[] }
      setProviderRows(payload.providers)
    } catch {
      setProviderRows([])
    }
  }

  async function saveProviderKey(id: string) {
    const key = (keyDrafts[id] ?? '').trim()
    if (!key) return
    setProviderNotes((notes) => ({ ...notes, [id]: 'saving…' }))
    const response = await fetch(`/api/providers/${id}/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key })
    })
    const payload = (await response.json()) as { error?: string; configured?: boolean; hint?: string }
    // The draft is cleared the moment it is stored: the field never keeps a key on screen.
    setKeyDrafts((drafts) => ({ ...drafts, [id]: '' }))
    setProviderNotes((notes) => ({ ...notes, [id]: payload.error ?? `saved ${payload.hint ?? ''}` }))
    await refreshProviders()
  }

  async function removeProviderKey(id: string) {
    await fetch(`/api/providers/${id}/key`, { method: 'DELETE' })
    setProviderNotes((notes) => ({ ...notes, [id]: 'removed' }))
    await refreshProviders()
  }

  async function testProvider(id: string) {
    setProviderNotes((notes) => ({ ...notes, [id]: 'testing…' }))
    const response = await fetch(`/api/providers/${id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const payload = (await response.json()) as { ok: boolean; detail: string; model?: string }
    setProviderNotes((notes) => ({
      ...notes,
      [id]: `${payload.ok ? 'answered' : 'failed'} · ${payload.detail}`
    }))
  }

  async function refreshOAuth() {
    try {
      const response = await fetch('/api/oauth')
      const payload = (await response.json()) as { providers: OAuthRow[] }
      setOauthRows(payload.providers)
    } catch {
      setOauthRows([])
    }
  }

  async function signIn(id: string) {
    setOauthBusy(id)
    const response = await fetch(`/api/oauth/${id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    const payload = (await response.json()) as {
      error?: string
      flowId?: string
      userCode?: string
      verificationUri?: string
      verificationUriComplete?: string
      url?: string
      interval?: number
    }
    setOauthBusy('')
    if (payload.error) {
      setOauthFlows((flows) => ({ ...flows, [id]: { flowId: '', status: 'failed', message: payload.error } }))
      return
    }
    if (payload.url) {
      setOauthFlows((flows) => ({ ...flows, [id]: { flowId: payload.flowId ?? '', url: payload.url, status: 'paste' } }))
      window.open(payload.url, '_blank', 'noopener')
      return
    }
    setOauthFlows((flows) => ({
      ...flows,
      [id]: {
        flowId: payload.flowId ?? '',
        code: payload.userCode,
        url: payload.verificationUriComplete || payload.verificationUri,
        status: 'waiting'
      }
    }))
    void pollSignIn(id, payload.flowId ?? '', Math.max(3, payload.interval ?? 5))
  }

  async function pollSignIn(id: string, _flowId: string, interval: number) {
    // The server polls the provider; this only reads the result, so closing the dialog mid-approval
    // no longer throws the finished sign-in away.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(3, interval) * 1000))
      const response = await fetch('/api/oauth')
      const payload = (await response.json()) as { providers: OAuthRow[] }
      const row = payload.providers.find((entry) => entry.id === id)
      if (!row) return
      if (row.connected) {
        setOauthRows(payload.providers)
        setOauthFlows((flows) => ({ ...flows, [id]: { flowId: '', status: 'connected', message: row.account } }))
        return
      }
      if (row.watch && row.watch.status !== 'pending') {
        setOauthFlows((flows) => ({
          ...flows,
          [id]: { flowId: '', status: row.watch!.status, message: row.watch!.message || row.watch!.account }
        }))
        return
      }
    }
    setOauthFlows((flows) => ({ ...flows, [id]: { flowId: '', status: 'expired', message: 'Stopped waiting; start again.' } }))
  }

  async function finishSignIn(id: string) {
    const flow = oauthFlows[id]
    if (!flow?.flowId) return
    const response = await fetch(`/api/oauth/${id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId: flow.flowId, code: oauthCode })
    })
    const payload = (await response.json()) as { status?: string; account?: string; error?: string }
    if (payload.error) {
      setOauthFlows((flows) => ({ ...flows, [id]: { ...flow, status: 'failed', message: payload.error } }))
      return
    }
    setOauthCode('')
    setOauthFlows((flows) => ({ ...flows, [id]: { flowId: '', status: 'connected', message: payload.account ?? '' } }))
    await refreshOAuth()
  }

  async function signOut(id: string) {
    await fetch(`/api/oauth/${id}`, { method: 'DELETE' })
    setOauthFlows((flows) => {
      const next = { ...flows }
      delete next[id]
      return next
    })
    await refreshOAuth()
  }

  // A provider is chosen for the reader: a signed-in account first, then a saved key, so the
  // dropdown and Refresh are usable the moment the panel opens.
  useEffect(() => {
    if (modelProvider) return
    const signedIn = oauthRows.find((row) => row.connected)
    const withKey = providerRows?.find((row) => row.configured && !row.requiresSignIn)
    const pick = signedIn?.id ?? withKey?.id
    if (!pick) return
    setModelProvider(pick)
    void loadModels(pick)
  }, [oauthRows, providerRows, modelProvider])

  async function loadModels(id: string, refresh = false) {
    if (!id) {
      setModelList([])
      setModelAt(null)
      return
    }
    const remembered = window.localStorage.getItem(`skill-academy.model-choice.${id}`) ?? ''
    const response = await fetch(`/api/providers/${id}/models${refresh ? '?refresh=1' : ''}`)
    const payload = (await response.json()) as { models?: string[]; at?: string | null; cached?: boolean; error?: string }
    const models = payload.models ?? []
    setModelList(models)
    setModelAt(payload.at ?? null)
    setModelCached(!!payload.cached)
    // A refresh must not throw away the reader's pick: keep it while it still exists.
    setModelChoice(models.includes(remembered) ? remembered : '')
  }

  async function openImprove() {
    setReviewOpen('improve')
    setReviewBusy(true)
    try {
      const response = await fetch('/api/improve/dry-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const payload = (await response.json()) as { findings: ImproveFinding[] }
      setImproveFindings(payload.findings ?? [])
    } finally {
      setReviewBusy(false)
    }
  }

  async function openConsolidate() {
    setReviewOpen('consolidate')
    setReviewBusy(true)
    try {
      const response = await fetch('/api/consolidate/dry-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const payload = (await response.json()) as { groups: ConsolidateGroupView[]; summary: Record<string, number> }
      setConsolidateGroups(payload.groups ?? [])
      setConsolidateSummary(payload.summary ?? {})
    } finally {
      setReviewBusy(false)
    }
  }

  async function proposeFold(key: string) {
    setFoldBusy(key)
    setFold(null)
    setFoldRead(false)
    setFoldApplied('')
    const response = await fetch('/api/consolidate/fold', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key })
    })
    const payload = (await response.json()) as FoldView & { error?: string; detail?: unknown }
    setFoldBusy('')
    if (payload.error) {
      setFoldApplied(`${payload.error}: ${JSON.stringify(payload.detail)}`)
      return
    }
    setFold(payload)
  }

  async function writeFold() {
    if (!fold) return
    setFoldBusy(fold.key)
    const response = await fetch('/api/consolidate/fold/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: fold.key,
        // The body on screen is the body that gets written and audited, not a fresh sample.
        text: fold.text,
        read: foldRead,
        confirm: true,
        dryRun: false
      })
    })
    const payload = (await response.json()) as {
    applied?: boolean
    archive?: string
    error?: string
    detail?: { path?: string; hint?: string } | unknown
  }
    setFoldBusy('')
    const detail = payload.detail as { path?: string; hint?: string } | undefined
    setFoldApplied(
      payload.error === 'protected-root'
        ? `Nothing was written. ${detail?.path ?? 'This skill'} is in the live library. ${detail?.hint ?? ''}`
        : payload.error
          ? `${payload.error}: ${JSON.stringify(payload.detail)}`
          : `written · archived at ${payload.archive ?? 'unknown'}`
    )
    if (payload.applied) await openConsolidate()
  }

  async function saveProviderBase(id: string) {
    const base = (baseDrafts[id] ?? '').trim()
    if (!base) return
    const response = await fetch(`/api/providers/${id}/base`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base })
    })
    const payload = (await response.json()) as { error?: string; base?: string }
    setProviderNotes((notes) => ({ ...notes, [id]: payload.error ?? `address saved: ${payload.base}` }))
    await refreshProviders()
  }

  async function saveGithubToken() {
    const token = githubToken.trim()
    if (!token) return
    const response = await fetch('/api/github/key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: token })
    })
    setGithubToken('')
    const payload = (await response.json()) as { hint?: string; error?: string }
    setGithubNote(payload.error ?? `saved ${payload.hint ?? ''} · 5000 calls an hour`)
  }
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

  async function loadDrafts() {
    const response = await fetch('/api/drafts')
    const data = (await response.json()) as { drafts?: DraftRow[] }
    setDrafts(data.drafts ?? [])
  }

  async function newDraft(intent?: string) {
    const response = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent ? { intent } : { name: 'untitled-draft' })
    })
    const data = (await response.json()) as { draft?: { meta: { id: string } }; error?: string }
    if (data.draft) {
      setScope({ kind: 'drafts' })
      setActiveDraft(data.draft.meta.id)
      void loadDrafts()
    }
  }

  async function loadWorkspaces() {
    const response = await fetch('/api/workspaces')
    const data = (await response.json()) as { workspaces?: WorkspaceRow[] }
    setWorkspaces(data.workspaces ?? [])
  }

  async function addWorkspace(workspacePath: string) {
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: workspacePath })
    })
    const data = (await response.json()) as { workspace?: WorkspaceRow; error?: string }
    if (data.workspace) {
      await loadWorkspaces()
      setScope({ kind: 'workspace', id: data.workspace.id })
    }
  }

  async function removeWorkspace(id: number) {
    await fetch(`/api/workspaces/${id}`, { method: 'DELETE' })
    if (scope.kind === 'workspace' && scope.id === id) setScope({ kind: 'all' })
    await loadWorkspaces()
  }

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

  const [confirmArchive, setConfirmArchive] = useState(false)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; skill: Skill } | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [presets, setPresets] = useState<{ id: number; name: string; agents: string[] }[]>([])
  const [selectMode, setSelectMode] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [installRepo, setInstallRepo] = useState('')
  const [installTesting, setInstallTesting] = useState(false)
  const [installNote, setInstallNote] = useState<string | null>(null)
  const [installFound, setInstallFound] = useState<
    Array<{ path: string; name: string; version: string | null; description: string | null; files: number; bytes: number }>
  >([])
  const [installPicked, setInstallPicked] = useState<Set<string>>(new Set())
  const [installAgents, setInstallAgents] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('skill-academy.install-agents') ?? '[]') as string[]
      return new Set(saved)
    } catch {
      return new Set()
    }
  })
  const [installMode, setInstallMode] = useState<'symlink' | 'copy'>('symlink')
  const [installing, setInstalling] = useState(false)
  const [statusSeg, setStatusSeg] = useState<Set<'active' | 'archived'>>(new Set(['active', 'archived']))
  const [bulkConfirm, setBulkConfirm] = useState(false)

  useEffect(() => {
    setBulkConfirm(false)
  }, [checked])

  useEffect(() => {
    if (!bulkConfirm) return
    const timer = setTimeout(() => setBulkConfirm(false), 4000)
    return () => clearTimeout(timer)
  }, [bulkConfirm])
  const [presetId, setPresetId] = useState<number | ''>('')

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/presets')
        const payload = await response.json()
        setPresets(payload.presets ?? [])
      } catch {
        /* presets are optional; the bar simply has no selector */
      }
    })()
  }, [])

  async function applyPreset() {
    if (presetId === '' || !checked.size) return
    try {
      const response = await fetch(`/api/presets/${presetId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...checked] })
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `apply ${response.status}`)
      setError(
        payload.failed
          ? `${payload.failed} of ${payload.results.length} could not be placed by ${payload.preset}`
          : null
      )
      setChecked(new Set())
    } catch (error) {
      setError((error as Error).message)
    }
  }

  async function savePresetFromScope() {
    const agent = scope.kind === 'agent' ? scope.agent : null
    if (!agent) return
    const name = window.prompt('Preset name', agent)
    if (!name) return
    try {
      const response = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, agents: [agent] })
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `preset ${response.status}`)
      setPresets((current) => [...current.filter((row) => row.id !== payload.preset.id), payload.preset])
      setPresetId(payload.preset.id)
    } catch (error) {
      setError((error as Error).message)
    }
  }

  function toggleChecked(id: number) {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function testInstall() {
    if (!installRepo.trim()) return
    setInstallTesting(true)
    setInstallNote(null)
    setInstallFound([])
    setInstallPicked(new Set())
    try {
      const response = await fetch('/api/install/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: installRepo })
      })
      const payload = (await response.json()) as {
        found?: number
        skills?: Array<{ path: string; name: string; version: string | null; description: string | null; files: number; bytes: number }>
        error?: string
        note?: string
      }
      if (!response.ok) {
        setInstallNote(payload.error ?? `Test failed: ${response.status}`)
        return
      }
      setInstallFound(payload.skills ?? [])
      setInstallPicked(new Set((payload.skills ?? []).map((skill) => skill.path)))
      setInstallNote(payload.found ? `${payload.found} skills found` : (payload.note ?? 'Nothing to install'))
    } finally {
      setInstallTesting(false)
    }
  }

  async function runInstall() {
    if (!installPicked.size || !installAgents.size) return
    setInstalling(true)
    setInstallNote(null)
    try {
      const response = await fetch('/api/install/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: installRepo,
          paths: [...installPicked],
          agents: [...installAgents],
          mode: installMode
        })
      })
      const payload = (await response.json()) as { installed?: number; failed?: number; error?: string; missingRoots?: string[] }
      if (!response.ok) {
        setInstallNote(payload.error ?? `Install failed: ${response.status}`)
        return
      }
      setInstallNote(
        `Installed ${payload.installed ?? 0}${payload.failed ? ` · ${payload.failed} failed` : ''}` +
          (payload.missingRoots?.length ? ` · no root: ${payload.missingRoots.join(', ')}` : '')
      )
      await scan()
      setInstallFound([])
      setInstallPicked(new Set())
      setInstallOpen(false)
    } finally {
      setInstalling(false)
    }
  }

  async function togglePlatform(skill: Skill) {
    if (scope.kind !== 'agent') return
    const on = skill.path.indexOf('.archive') > -1
    const response = await fetch(`/api/skills/${skill.id}/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: scope.agent, on })
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      window.alert(`Switch failed: ${payload.error ?? response.status}`)
      return
    }
    await loadState()
    await fetchPage(0, true)
  }

  async function bulkAgents(action: 'enable' | 'disable') {
    const agent = scope.kind === 'agent' ? scope.agent : null
    const ids = [...checked]
    if (!agent || !ids.length) return
    try {
      const response = await fetch('/api/skills/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ids, agent })
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `bulk ${response.status}`)
      const failed = (payload.results ?? []).filter((row: { ok: boolean }) => !row.ok)
      setChecked(new Set())
      setError(
        failed.length
          ? `${failed.length} of ${payload.total} could not be switched ${action === 'enable' ? 'on' : 'off'} (${[
              ...new Set(failed.map((row: { error?: string }) => row.error ?? 'unknown'))
            ].join(', ')})`
          : null
      )
    } catch (error) {
      setError((error as Error).message)
    }
  }

  async function archiveChecked() {
    const ids = [...checked]
    if (!ids.length) return
    try {
      const response = await fetch('/api/skills/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive', ids, reason: 'bulk' })
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `bulk ${response.status}`)
      const gone = new Set((payload.results ?? []).filter((row: { ok: boolean }) => row.ok).map((row: { id: number }) => row.id))
      setSkills((current) => current.filter((row) => !gone.has(row.id)))
      if (selected !== null && gone.has(selected)) setSelected(null)
      setChecked(new Set())
      void loadTrash()
      if (payload.failed) setError(`${payload.failed} of ${payload.total} could not be archived`)
    } catch (error) {
      setError((error as Error).message)
    }
  }

  useEffect(() => {
    if (!rowMenu) return
    const close = () => setRowMenu(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [rowMenu])

  useEffect(() => {
    setConfirmArchive(false)
  }, [detail?.id])

  function archiveClick() {
    // Two stages: the first click asks, the second does the work, so a slip of the
    // pointer cannot move a skill out of the library.
    if (!confirmArchive) {
      setConfirmArchive(true)
      window.setTimeout(() => setConfirmArchive(false), 4000)
      return
    }
    setConfirmArchive(false)
    void archiveCurrent()
  }

  async function archiveSkillRow(skill: Skill) {
    try {
      const response = await fetch(`/api/skills/${skill.id}/archive`, { method: 'POST' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `archive ${response.status}`)
      setSkills((current) => current.filter((row) => row.id !== skill.id))
      if (selected === skill.id) setSelected(null)
      void loadTrash()
    } catch (error) {
      setError((error as Error).message)
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
    void loadWorkspaces()
  }, [])

  function paramsFor(offset: number): string {
    const params = new URLSearchParams()
    if (debounced) params.set('q', debounced)
    if (scope.kind === 'agent') params.set('root', scope.path)
    if (scope.kind === 'tag') params.set('tag', scope.tag)
    if (scope.kind === 'category') params.set('category', scope.category)
    if (scope.kind === 'health') params.set('health', '1')
    const both = statusSeg.size === 0 || statusSeg.size === 2
    params.set('status', both ? 'all' : statusSeg.has('active') ? 'active' : 'archived')
    params.set('limit', String(PAGE))
    params.set('offset', String(offset))
    return params.toString()
  }

  async function fetchPage(offset: number, replace: boolean) {
    // The trash is a list of its own, not a page of the library.
    if (scope.kind === 'trash') return
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
  }, [debounced, scope, statusSeg])

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

  async function repairPlacement(placement: Placement) {
    if (!detail) return
    setPlacementBusy(placement.agent)
    try {
      const response = await fetch('/api/placements/repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: detail.id, agent: placement.agent })
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? `repair ${response.status}`)
      setPlacements((current) =>
        current
          ? current.map((row) => (row.agent === placement.agent ? { ...row, drift: payload.after } : row))
          : current
      )
      setError(null)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setPlacementBusy(null)
    }
  }

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
    if (scope.kind === 'trash') return 'Deleted'
    if (scope.kind === 'drafts') return 'Drafts'
    if (scope.kind === 'workspace') return workspaces.find((row) => row.id === scope.id)?.name ?? 'Workspace'
    if (scope.kind === 'tag') return `#${scope.tag}`
    if (scope.kind === 'category') return scope.category
    if (scope.kind === 'agent') return scope.agent
    return 'All skills'
  }, [scope, facets])

  function renderTree(nodes: PkgNode[], depth: number, kind: string): ReactNode[] {
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
          <button className="mb-item" onClick={openImprove}>
            Improve
          </button>
          <button className="mb-item" onClick={openConsolidate}>
            Consolidate
          </button>
          <button className="mb-item" onClick={openProviders}>
            Providers
          </button>
          <button className="mb-item" onClick={() => setMonitorOpen(true)}>
            Versioning
          </button>
          <button className="mb-item" onClick={() => setSourcesOpen(true)}>
            Sources
          </button>
          <button className="mb-item" onClick={() => setSyncOpen(true)}>
            Sync
          </button>
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
          <button className="btn primary" onClick={() => setInstallOpen(true)}>
            Install Skill
          </button>
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
              <div className="sp-row">
                <span>Providers</span>
                <button className="sp-link" onClick={openProviders}>
                  {providerRows?.filter((row) => row.configured).length ?? 0} configured
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {monitorOpen && <Versioning onClose={() => setMonitorOpen(false)} />}
      {sourcesOpen && <SourcesDialog onClose={() => setSourcesOpen(false)} />}
      {syncOpen && <SyncDialog onClose={() => setSyncOpen(false)} />}
      {moveTarget && <MoveDialog skill={moveTarget} onClose={() => setMoveTarget(null)} />}
      {improveTarget && <ImproveDialog skill={improveTarget} onClose={() => setImproveTarget(null)} />}
      {planGroup && (
        <GroupPlanDialog
          group={{
            key: planGroup.key,
            members: planGroup.members.map((member) => ({
              name: member.name,
              path: member.path,
              version: member.version,
              chars: member.chars
            })),
            plan: planGroup.plan ? { survivor: planGroup.plan.survivor } : null,
            liveRoot: planGroup.liveRoot
          }}
          onClose={() => setPlanGroup(null)}
          onApplied={() => {
            void openConsolidate()
          }}
        />
      )}


      {reviewOpen === 'improve' && (
        <div className="installscrim" onClick={() => setReviewOpen(null)}>
          <div className="installmodal reviewmodal" onClick={(event) => event.stopPropagation()}>
            <div className="imhead">
              <span>
                Improve · {improveFindings.length} finding{improveFindings.length === 1 ? '' : 's'}
              </span>
              <button className="iconbtn crossbtn" aria-label="Close" onClick={() => setReviewOpen(null)}>
                <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="imbody">
              <div className="reviewchips">
                <button className={`chip ${improveRule === '' ? 'on' : ''}`} onClick={() => setImproveRule('')}>
                  all · {improveFindings.length}
                </button>
                {[...new Set(improveFindings.map((finding) => finding.rule))].map((rule) => (
                  <button key={rule} className={`chip ${improveRule === rule ? 'on' : ''}`} onClick={() => setImproveRule(rule)}>
                    {rule} · {improveFindings.filter((finding) => finding.rule === rule).length}
                  </button>
                ))}
              </div>
              <div className="reviewlist">
                {reviewBusy && <div className="reviewnote">running the rule set…</div>}
                {improveFindings
                  .filter((finding) => !improveRule || finding.rule === improveRule)
                  .slice(0, 400)
                  .map((finding, index) => (
                    <div className={`reviewrow ${finding.severity}`} key={`${finding.rule}:${finding.path}:${index}`}>
                      <span className="reviewrule">{finding.rule}</span>
                      <span className="reviewname">{finding.skill}</span>
                      <span className="reviewdetail">{finding.detail}</span>
                      <span className="reviewpath" title={finding.path}>
                        {finding.path.split(/[\\/]/).slice(-2).join('/')}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {reviewOpen === 'consolidate' && (
        <div className="installscrim" onClick={() => setReviewOpen(null)}>
          <div className="installmodal reviewmodal" onClick={(event) => event.stopPropagation()}>
            <div className="imhead">
              <span>Consolidate · {consolidateGroups.length} group{consolidateGroups.length === 1 ? '' : 's'}</span>
              <button className="iconbtn crossbtn" aria-label="Close" onClick={() => setReviewOpen(null)}>
                <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="imbody">
              <div className="reviewchips">
                {Object.entries(consolidateSummary).map(([kind, count]) => (
                  <span className={`chip ${kind === 'intentional-family' ? 'quiet' : ''}`} key={kind}>
                    {kind} · {count}
                  </span>
                ))}
              </div>
              <div className="reviewlist">
                {reviewBusy && <div className="reviewnote">comparing bodies…</div>}
                {consolidateGroups.map((group) => (
                  <div className="cgroup" key={group.key}>
                    <button className="cghead" onClick={() => setReviewOpenKey(reviewOpenKey === group.key ? '' : group.key)}>
                      <span className={`cgtype ${group.mergeType}`}>{group.mergeType}</span>
                      <span className="cgname">{group.plan?.survivor ?? group.key}</span>
                      <span className="cgev">{group.evidence}</span>
                      <span className="cgcount">{group.members.length} copies</span>
                      {group.liveRoot && (
                        <span className="cglock" title="This group lives in the live agent library, so a write is refused.">
                          live library · write blocked
                        </span>
                      )}
                    </button>
                    {reviewOpenKey === group.key && (
                      <div className="cgbody">
                        {group.members.map((member) => (
                          <div className="cgmember" key={member.path}>
                            <span className="cgmname">{member.name}</span>
                            <span className="cgmsize">{member.chars} chars</span>
                            <span className="cgmver">{member.version ?? 'no version'}</span>
                            <span className="cgmhead" title={member.path}>
                              {member.uniqueHeadings.length ? `unique: ${member.uniqueHeadings.join(', ')}` : 'nothing unique'}
                            </span>
                          </div>
                        ))}
                        {group.blocked && <div className="reviewnote">{group.blocked}</div>}
                        <div className="cgplan">
                          <button className="ghost small planbtn" onClick={() => setPlanGroup(group)}>
                            Plan promote or fold…
                          </button>
                        </div>
                        {group.plan && (
                          <div className="cgplan">
                            survivor <b>{group.plan.survivor}</b> · pointer {group.plan.pointerize.length} · router{' '}
                            {group.plan.routerize.length}
                            <button
                              className="ghost small foldbtn"
                              onClick={() => void proposeFold(group.key)}
                              disabled={foldBusy === group.key}
                            >
                              {foldBusy === group.key ? 'asking the model…' : 'Propose merge'}
                            </button>
                          </div>
                        )}

                        {fold?.key === group.key && (
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
                            <pre className="foldtext">{fold.text}</pre>
                            {fold.droppedRules.length > 0 && (
                              <div className="foldmissing">
                                missing from the merge:
                                {fold.droppedRules.slice(0, 5).map((line) => (
                                  <code key={line}>{line.slice(0, 80)}</code>
                                ))}
                              </div>
                            )}
                            <div className="foldactions">
                              <label className="foldread">
                                <input type="checkbox" checked={foldRead} onChange={(event) => setFoldRead(event.target.checked)} />
                                I read the merged body above
                              </label>
                              <button
                                className="ghost small"
                                disabled={!foldRead || fold.status !== 'clean' || foldBusy === fold.key}
                                onClick={() => void writeFold()}
                              >
                                Write merged body
                              </button>
                            </div>
                            {foldApplied && <div className="reviewnote">{foldApplied}</div>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {providersOpen && (
        <div className="installscrim" onClick={() => setProvidersOpen(false)}>
          <div className="installmodal providersmodal" onClick={(event) => event.stopPropagation()}>
            <div className="imhead">
              <span>Providers</span>
              <button className="iconbtn crossbtn" aria-label="Close" onClick={() => setProvidersOpen(false)}>
                <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="imbody">
              <div className="imnote">
                Keys are kept in the Windows credential store. Nothing here is written to the index, a log or a reply, and
                the field forgets a key the moment it is saved.
              </div>
              <div className="provlist">
                {(providerRows ?? []).map((row) => (
                  <div className="provrow" key={row.id} title={row.base}>
                    <span className="provname">{row.label}</span>
                    <span className={`provdot ${row.configured ? 'on' : ''}`} aria-hidden="true" />
                    <span className="provstate">
                      {row.requiresSignIn
                        ? row.configured
                          ? 'signed in'
                          : 'sign-in pending'
                        : row.needsKey
                          ? row.configured
                            ? `key ${row.hint}`
                            : 'no key'
                          : 'no key needed'}
                    </span>
                    {row.requiresSignIn && (
                      <button className="ghost small" disabled title="The OAuth flow lands with the next slice">
                        Sign in
                      </button>
                    )}
                    {row.needsKey && (
                      <>
                        <input
                          className="provinput"
                          type="password"
                          placeholder="Paste key"
                          autoComplete="off"
                          value={keyDrafts[row.id] ?? ''}
                          onChange={(event) =>
                            setKeyDrafts((drafts) => ({ ...drafts, [row.id]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveProviderKey(row.id)
                          }}
                        />
                        <button className="ghost small" onClick={() => void saveProviderKey(row.id)}>
                          Save
                        </button>
                        <button
                          className="ghost small"
                          onClick={() => void testProvider(row.id)}
                          title={`Test ${row.label}`}
                        >
                          Test
                        </button>
                        {row.configured && (
                          <button
                            className="ghost small dim"
                            onClick={() => void removeProviderKey(row.id)}
                            title="Forget this key"
                          >
                            Remove
                          </button>
                        )}
                      </>
                    )}
                    {row.baseEditable && (
                      <>
                        <input
                          className="provinput provbase"
                          placeholder={row.base}
                          value={baseDrafts[row.id] ?? row.base}
                          onChange={(event) => setBaseDrafts((drafts) => ({ ...drafts, [row.id]: event.target.value }))}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveProviderBase(row.id)
                          }}
                        />
                        <button className="ghost small" onClick={() => void saveProviderBase(row.id)}>
                          Save URL
                        </button>
                      </>
                    )}
                    {providerNotes[row.id] && <span className="provnote">{providerNotes[row.id]}</span>}
                  </div>
                ))}
              </div>

              <div className="provsep" />

              <div className="oauthblock">
                <div className="imsection">
                  <span>Sign in</span>
                </div>
                {oauthRows.map((row) => {
                  const flow = oauthFlows[row.id]
                  return (
                    <div className="oauthrow" key={row.id}>
                      <div className="oauthhead">
                        <span className="provname">{row.label}</span>
                        <span className={`provdot ${row.connected ? 'on' : ''}`} aria-hidden="true" />
                        <span className="provstate">
                          {row.connected ? row.account || 'connected' : 'not signed in'}
                        </span>
                        {row.connected ? (
                          <button className="ghost small dim" onClick={() => void signOut(row.id)}>
                            Disconnect
                          </button>
                        ) : (
                          <button className="ghost small" onClick={() => void signIn(row.id)} disabled={oauthBusy === row.id}>
                            {oauthBusy === row.id ? 'Starting…' : 'Sign in'}
                          </button>
                        )}
                        <span className="oauthnote" title={row.note}>{row.note}</span>
                      </div>

                      {flow?.code && (
                        <div className="oauthflow">
                          <span className="oauthcodewrap">
                            <code className="oauthcode">{flow.code}</code>
                            <button
                              className="oauthcopy"
                              aria-label="Copy the code"
                              title={copiedCode === flow.code ? 'Copied' : 'Copy the code'}
                              onClick={() => {
                                void navigator.clipboard.writeText(flow.code ?? '')
                                setCopiedCode(flow.code ?? '')
                                window.setTimeout(() => setCopiedCode(''), 1400)
                              }}
                            >
                              {copiedCode === flow.code ? (
                                <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                                  <path d="M2.5 6.4l2.4 2.4L9.6 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                                  <rect x="4" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
                                  <path d="M8 4V3.2A1.2 1.2 0 0 0 6.8 2H3.2A1.2 1.2 0 0 0 2 3.2v3.6A1.2 1.2 0 0 0 3.2 8H4" fill="none" stroke="currentColor" strokeWidth="1.2" />
                                </svg>
                              )}
                            </button>
                          </span>
                          <a className="oauthopen" href={flow.url} target="_blank" rel="noreferrer">
                            Open the approval page
                          </a>
                          <span className="oauthstate">
                            {flow.status === 'waiting' ? 'waiting for approval…' : flow.message ?? flow.status}
                          </span>
                        </div>
                      )}

                      {flow?.status === 'paste' && (
                        <div className="oauthflow">
                          <input
                            className="provinput"
                            placeholder="Paste the code the browser showed"
                            value={oauthCode}
                            onChange={(event) => setOauthCode(event.target.value)}
                          />
                          <button className="ghost small" onClick={() => void finishSignIn(row.id)}>
                            Finish
                          </button>
                        </div>
                      )}

                      {/* A connected row already shows its account, so a second line would repeat it. */}
                      {flow && flow.status !== 'waiting' && flow.status !== 'paste' && flow.status !== 'connected' && flow.message && (
                        <div className="oauthstate">{flow.message}</div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="provsep" />

              <div className="modelblock">
                <div className="imsection">
                  <span>Model</span>
                </div>
                <div className="modelrow">
                  <select
                    className="modelsel"
                    value={modelProvider}
                    onChange={(event) => {
                      const id = event.target.value
                      setModelProvider(id)
                      void loadModels(id)
                    }}
                  >
                    <option value="">Choose a signed-in provider</option>
                    {providerRows
                      ?.filter((row) => row.configured && !row.requiresSignIn)
                      // A provider that is also signed in appears once, as the sign-in.
                      .filter((row) => !oauthRows.some((oauth) => oauth.connected && oauth.id === row.id))
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.label}
                        </option>
                      ))}
                    {oauthRows
                      .filter((row) => row.connected)
                      .map((row) => (
                        <option key={`oauth-${row.id}`} value={row.id}>
                          {row.label}
                        </option>
                      ))}
                  </select>

                  <select
                    className="modelsel"
                    value={modelChoice}
                    onChange={(event) => {
                      const chosen = event.target.value
                      setModelChoice(chosen)
                      if (!modelProvider) return
                      window.localStorage.setItem(`skill-academy.model-choice.${modelProvider}`, chosen)
                      // The merge pass asks this model, so the choice is saved where the server reads it.
                      if (chosen) {
                        void fetch('/api/settings', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ mergeProvider: modelProvider, mergeModel: chosen })
                        })
                      }
                    }}
                    disabled={!modelList.length}
                  >
                    <option value="">
                      {modelList.length ? `${modelList.length} models available` : 'No models yet'}
                    </option>
                    {modelList.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>

                  <button className="ghost small" disabled={!modelProvider} onClick={() => void loadModels(modelProvider, true)}>
                    Refresh
                  </button>
                </div>
              </div>

              <div className="provsep" />

              <div className="provrow">
                <span className="provname">GitHub</span>
                <span className="provdot on" aria-hidden="true" />
                <span className="provstate">{githubNote || 'checked on open'}</span>
                <input
                  className="provinput"
                  type="password"
                  placeholder="Paste a token"
                  autoComplete="off"
                  value={githubToken}
                  onChange={(event) => setGithubToken(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveGithubToken()
                  }}
                />
                <button className="ghost small" onClick={() => void saveGithubToken()}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
          <button
            className={`nav ${scope.kind === 'trash' ? 'active' : ''}`}
            onClick={() => setScope({ kind: 'trash' })}
          >
            Deleted <span>{trashList.length}</span>
          </button>
          <div className="wssection">
            <div className="wstitle">Workspaces</div>
            <WorkspaceSidebar
              workspaces={workspaces}
              activeId={scope.kind === 'workspace' ? scope.id : null}
              onOpen={(id) => {
                setWorkspaceRow(null)
                setScope({ kind: 'workspace', id })
              }}
              onAdd={(workspacePath) => void addWorkspace(workspacePath)}
              onRemove={(id) => void removeWorkspace(id)}
            />
          </div>
          <button
            className={`nav ${scope.kind === 'drafts' ? 'active' : ''}`}
            onClick={() => {
              setScope({ kind: 'drafts' })
              void loadDrafts()
            }}
          >
            Drafts <span>{drafts.length}</span>
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
                    <span>
                      {fmt.format(agent.count)}
                      {(agent.archived ?? 0) > 0 ? (
                        <span className="archcount">/{fmt.format(agent.archived ?? 0)}</span>
                      ) : null}
                    </span>
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
          <div className={`listhead ${scope.kind === 'trash' ? 'trashmode' : ''}`}>
            {selectMode && (
              <span
                className={`pick all ${checked.size > 0 && checked.size === skills.length ? 'on' : ''}`}
                role="checkbox"
                aria-checked={checked.size > 0 && checked.size === skills.length}
                aria-label="Select every skill in this view"
                title="Select every skill in this view"
                tabIndex={0}
                onClick={() => {
                  const all = checked.size === skills.length && checked.size > 0
                  setChecked(all ? new Set() : new Set(skills.map((row) => row.id)))
                }}
                onKeyDown={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault()
                    const all = checked.size === skills.length && checked.size > 0
                    setChecked(all ? new Set() : new Set(skills.map((row) => row.id)))
                  }
                }}
              />
            )}
            <span className="scope">{scopeLabel}</span>
            {scope.kind !== 'workspace' && scope.kind !== 'drafts' && scope.kind !== 'trash' && (
              <div className="seg" role="group" aria-label="Shown skills">
              {(
                [
                  ['active', 'Installed'],
                  ['archived', 'Archived']
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`segbtn ${statusSeg.has(key) ? 'on' : ''}`}
                  aria-pressed={statusSeg.has(key)}
                  onClick={() => {
                    const next = new Set(statusSeg)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    setStatusSeg(next)
                  }}
                >
                  {label}
                </button>
              ))}
              </div>
            )}
            <span className={`count ${scope.kind === 'trash' ? 'trashcount' : ''}`}>
              {scope.kind === 'trash'
                ? `${fmt.format(trashList.length)} ${trashList.length === 1 ? 'entry' : 'entries'}`
                : scope.kind === 'workspace'
                  ? `${fmt.format(workspaceView?.total ?? 0)} ${(workspaceView?.total ?? 0) === 1 ? 'skill' : 'skills'}`
                  : `${fmt.format(total)} ${total === 1 ? 'skill' : 'skills'}`}
              {scope.kind !== 'trash' &&
                (checked.size > 0
                  ? ` · ${checked.size}/${fmt.format(skills.length)} selected`
                  : skills.length < total
                    ? ` · ${fmt.format(skills.length)} loaded`
                    : '')}
            </span>
            {checked.size > 0 && (
              <div className="headactions">
                <button className="bulkbtn" onClick={() => setChecked(new Set())}>
                  Clear
                </button>
                <button className="bulkbtn planned" disabled title="Consolidate a set of skills into one, planned">
                  Consolidate
                </button>
                <button className="bulkbtn planned" disabled title="Improve a skill against its sources, planned">
                  Improve
                </button>
                {presets.length > 0 && (
                  <>
                    <select
                      className="bulkselect"
                      value={presetId}
                      onChange={(event) => setPresetId(event.target.value ? Number(event.target.value) : '')}
                    >
                      <option value="">Preset…</option>
                      {presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                    <button className="bulkbtn" disabled={presetId === ''} onClick={() => void applyPreset()}>
                      Apply
                    </button>
                  </>
                )}
                {scope.kind === 'agent' && (
                  <>
                    <button className="bulkbtn" onClick={() => void bulkAgents('enable')}>
                      On
                    </button>
                    <button className="bulkbtn" onClick={() => void bulkAgents('disable')}>
                      Off
                    </button>
                    <button className="bulkbtn" onClick={() => void savePresetFromScope()} title="Save this agent as a preset">
                      Save preset
                    </button>
                  </>
                )}
                <button
                  className={`bulkbtn danger ${bulkConfirm ? 'confirming' : ''}`}
                  onClick={() => {
                    if (!bulkConfirm) {
                      setBulkConfirm(true)
                      return
                    }
                    setBulkConfirm(false)
                    void archiveChecked()
                  }}
                >
                  {bulkConfirm ? `Confirm archive ${checked.size}` : 'Archive'}
                </button>
              </div>
            )}
            {scope.kind === 'trash' && (
              <div className="headactions trashtools">
                <button className="bulkbtn" onClick={() => setTrashSelecting((value) => !value)}>
                  {trashSelecting ? 'Done' : 'Select'}
                </button>
                <button
                  className="bulkbtn danger"
                  disabled={trashList.length === 0}
                  onClick={() => setTrashWipeAsk(true)}
                >
                  Wipe all
                </button>
              </div>
            )}
            <button
              className={`listedit ${selectMode ? 'on' : ''}`}
              title={selectMode ? 'Done selecting' : 'Select skills'}
              aria-pressed={selectMode}
              onClick={() => {
                setSelectMode((current) => {
                  if (current) setChecked(new Set())
                  return !current
                })
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M2.5 13.5h11M4 9.6V12h2.4l6-6a1.7 1.7 0 0 0-2.4-2.4l-6 6Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          {scope.kind === 'trash' && (
            <TrashView
              onChanged={() => void loadTrash()}
              selecting={trashSelecting}
              onSelectingChange={setTrashSelecting}
              wipeAsk={trashWipeAsk}
              onWipeHandled={() => setTrashWipeAsk(false)}
            />
          )}
          {scope.kind === 'workspace' && (
            <WorkspaceRows
              workspaceId={scope.id}
              refresh={workspaceRefresh}
              selected={workspaceRow?.name ?? null}
              onSelect={(name) => setWorkspaceRow(workspaceView?.rows.find((row) => row.name === name) ?? null)}
              onCompare={(view) => {
                setWorkspaceView(view)
                setWorkspaceRow((current) => (current ? view.rows.find((row) => row.name === current.name) ?? null : null))
              }}
            />
          )}
          {scope.kind === 'drafts' && (
            <DraftList
              drafts={drafts}
              activeId={activeDraft}
              onOpen={(id) => setActiveDraft(id)}
              onNew={() => void newDraft()}
              onGenerate={(intent) => void newDraft(intent)}
              onDeleted={(id) => {
                if (activeDraft === id) setActiveDraft(null)
                void loadDrafts()
              }}
            />
          )}
          {scope.kind !== 'trash' && scope.kind !== 'drafts' && scope.kind !== 'workspace' && skills.map((skill) => (
            <button
              key={skill.id}
              className={`row ${selected === skill.id ? 'selected' : ''}`}
              onClick={() => setSelected(skill.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                setRowMenu({ x: event.clientX, y: event.clientY, skill })
              }}
            >
              {selectMode && (
              <span
                className={`pick ${checked.has(skill.id) ? 'on' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleChecked(skill.id)
                }}
                role="checkbox"
                aria-checked={checked.has(skill.id)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === ' ' || event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    toggleChecked(skill.id)
                  }
                }}
              />
              )}
              <span
                className={`dot ${skill.health.length ? 'warn' : ''} ${skill.risk === 'high' ? 'risk' : ''}`}
                title={skill.risk === 'high' ? 'Content scan: high risk' : undefined}
              />
              <span className="meta">
                <span className="title">
                  {skill.name}
                  {skill.version ? <span className="ver">v{skill.version.replace(/^v/i, '')}</span> : null}
                  {skill.path.indexOf('.archive') > -1 ? (
                    <span className="archpill" title="Parked in this platform archive">
                      Archived
                    </span>
                  ) : null}
                  {skill.repo ? <span className="repo">{skill.repo}</span> : null}
                </span>
                <span className="desc">{skill.description || 'No description'}</span>
              </span>
              {selectMode ? (
                <span
                  className={`switch ${skill.path.indexOf('.archive') > -1 ? '' : 'on'}`}
                  role="switch"
                  aria-checked={skill.path.indexOf('.archive') === -1}
                  tabIndex={0}
                  title={
                    scope.kind === 'agent'
                      ? skill.path.indexOf('.archive') > -1
                        ? 'Switched off: parked in this platform archive'
                        : 'Switched on for this platform'
                      : 'Choose an agent folder to switch a skill'
                  }
                  onClick={(event) => {
                    event.stopPropagation()
                    if (scope.kind !== 'agent') return
                    void togglePlatform(skill)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === ' ' || event.key === 'Enter') {
                      event.preventDefault()
                      event.stopPropagation()
                      if (scope.kind === 'agent') void togglePlatform(skill)
                    }
                  }}
                >
                  <span className="knob" />
                </span>
              ) : (
                <span className="tokens">{fmt.format(skill.tokens)}</span>
              )}
            </button>
          ))}
          {scope.kind !== 'workspace' && scope.kind !== 'drafts' && loadingMore && (
            <div className="listfoot">Loading…</div>
          )}
          {scope.kind !== 'workspace' && scope.kind !== 'drafts' && !hasMore && skills.length > 0 && (
            <div className="listfoot">{fmt.format(total)} total</div>
          )}
          {scope.kind !== 'drafts' && scope.kind !== 'trash' && scope.kind !== 'workspace' && skills.length === 0 && !loadingMore && (
            <div className="empty">Nothing matches. Clear the filter or scan.</div>
          )}
          </ScrollPane>
          {installOpen && (
            <div className="installscrim" onClick={() => setInstallOpen(false)}>
              <div
                className="installmodal"
                role="dialog"
                aria-label="Install skills"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="imhead">
                  <span>Install skills</span>
                  <button className="ghost iconbtn" onClick={() => setInstallOpen(false)} aria-label="Close">
                    ×
                  </button>
                </div>

                <div className="imbody">
                  <div className="imleft">
                    <div className="imfield">
                      <input
                        className="iminput"
                        placeholder="owner/repo or a GitHub URL"
                        value={installRepo}
                        onChange={(event) => setInstallRepo(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void testInstall()
                        }}
                        spellCheck={false}
                      />
                      <button className="imcheck" onClick={() => void testInstall()} disabled={installTesting || !installRepo.trim()}>
                        {installTesting ? 'Checking…' : 'Check'}
                      </button>
                    </div>
                    {installNote && <div className="imnote">{installNote}</div>}

                    {installFound.length === 0 && (
                      <div className="implatz">
                        <span>Check a repository to list its skills</span>
                      </div>
                    )}

                    {installFound.length > 0 && (
                      <>
                        <div className="imsection">
                          <span>Skills</span>
                          <button
                            className="linkbtn"
                            onClick={() =>
                              setInstallPicked(
                                installPicked.size === installFound.length ? new Set() : new Set(installFound.map((entry) => entry.path))
                              )
                            }
                          >
                            {installPicked.size === installFound.length ? 'None' : 'All'}
                          </button>
                        </div>
                        <div className="imlist">
                          {installFound.map((entry) => (
                            <div
                              className={`imrow impick ${installPicked.has(entry.path) ? '' : 'off'}`}
                              key={entry.path}
                              title={entry.description ?? undefined}
                            >
                              <span
                                className={`switch ${installPicked.has(entry.path) ? 'on' : ''}`}
                                role="switch"
                                aria-checked={installPicked.has(entry.path)}
                                tabIndex={0}
                                onClick={() => {
                                  const next = new Set(installPicked)
                                  if (next.has(entry.path)) next.delete(entry.path)
                                  else next.add(entry.path)
                                  setInstallPicked(next)
                                }}
                              >
                                <span className="knob" />
                              </span>
                              <span className="imtext">
                                <span className="imline">
                                  <span className="imname">{entry.name}</span>
                                  {entry.version ? (
                                    <span className="imver"> v{entry.version.replace(/^v/i, '')}</span>
                                  ) : null}
                                </span>
                                <span className="imdesc">
                                  {entry.description ? entry.description.replace(/\s+/g, ' ').trim() : 'No description'}
                                </span>
                              </span>
                              <span className="immeta">
                                {entry.files} files · {Math.round(entry.bytes / 1024)} KB
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="imright">
                    <div className="imsection">
                      <span>Agents</span>
                      <button
                        className={`imtoggle ${installAgents.size > 0 ? 'on' : ''}`}
                        title={installAgents.size > 0 ? 'Select none' : 'Select all agents'}
                        aria-label={installAgents.size > 0 ? 'Select none' : 'Select all agents'}
                        onClick={() => {
                          const all = (facets?.agents ?? []).map((agent) => agent.agent)
                          const next = installAgents.size > 0 ? new Set<string>() : new Set(all)
                          setInstallAgents(next)
                          window.localStorage.setItem('skill-academy.install-agents', JSON.stringify([...next]))
                        }}
                      >
                        {installAgents.size > 0 ? (
                          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                            <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" />
                            <path d="M3.6 6.1h4.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                            <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" />
                            <path d="M3.5 6.2l1.9 1.9 3.2-3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                    </div>
                    <div className="imlist imagents">
                      {(facets?.agents ?? []).map((agent) => (
                        <div className={`imrow ${installAgents.has(agent.agent) ? '' : 'off'}`} key={`${agent.agent}:${agent.path}`}>
                          <span
                            className={`switch ${installAgents.has(agent.agent) ? 'on' : ''}`}
                            role="switch"
                            aria-checked={installAgents.has(agent.agent)}
                            tabIndex={0}
                            onClick={() => {
                              const next = new Set(installAgents)
                              if (next.has(agent.agent)) next.delete(agent.agent)
                              else next.add(agent.agent)
                              setInstallAgents(next)
                              window.localStorage.setItem('skill-academy.install-agents', JSON.stringify([...next]))
                            }}
                          >
                            <span className="knob" />
                          </span>
                          <span className="imname">{agent.agent}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="imfoot">
                  <div className="seg immode" role="group" aria-label="Placement mode">
                    {(
                      [
                        ['symlink', 'Symlink'],
                        ['copy', 'Copy']
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        className={`segbtn ${installMode === key ? 'on' : ''}`}
                        aria-pressed={installMode === key}
                        onClick={() => setInstallMode(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    className="btn primary"
                    disabled={installing || !installPicked.size || !installAgents.size}
                    onClick={() => void runInstall()}
                  >
                    {installing ? 'Installing…' : `Install ${installPicked.size}`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {rowMenu && (
            <div
              className="rowmenu"
              style={{ left: rowMenu.x, top: rowMenu.y }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                className="rowmenu-item"
                onClick={() => {
                  setMoveTarget({ id: rowMenu.skill.id, name: rowMenu.skill.name, path: rowMenu.skill.path })
                  setRowMenu(null)
                }}
              >
                Move…
              </button>
              <button
                className="rowmenu-item"
                onClick={() => {
                  setImproveTarget({ id: rowMenu.skill.id, name: rowMenu.skill.name })
                  setRowMenu(null)
                }}
              >
                Improve…
              </button>
              <button
                className="rowmenu-item"
                onClick={() => {
                  void navigator.clipboard.writeText(rowMenu.skill.path)
                  setRowMenu(null)
                }}
              >
                Copy path
              </button>
              <button
                className="rowmenu-item"
                onClick={() => {
                  void navigator.clipboard.writeText(rowMenu.skill.name)
                  setRowMenu(null)
                }}
              >
                Copy name
              </button>
              <button
                className="rowmenu-item danger"
                onClick={() => {
                  const target = rowMenu.skill
                  setRowMenu(null)
                  void archiveSkillRow(target)
                }}
              >
                Archive
              </button>
            </div>
          )}
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
          {scope.kind === 'workspace' ? (
            <WorkspaceDetail
              workspaceId={scope.id}
              view={workspaceView}
              row={workspaceRow}
              onPromoted={() => {
                // The list is the truth about what the library holds, so it is re-read rather than
                // left showing the state from before the write.
                setWorkspaceRefresh((value) => value + 1)
                void loadWorkspaces()
                void fetchPage(0, true)
                void loadTrash()
              }}
              onClose={() => setScope({ kind: 'all' })}
            />
          ) : null}
          {scope.kind === 'drafts' ? (
            activeDraft ? (
              <DraftEditor
                draftId={activeDraft}
                onChanged={() => void loadDrafts()}
                onClose={() => setActiveDraft(null)}
              />
            ) : (
              <div className="empty">Pick a draft, or describe a new one.</div>
            )
          ) : null}
          {scope.kind !== 'drafts' && scope.kind !== 'workspace' && !detail && (
            <div className="empty">Select a skill to read it.</div>
          )}
          {scope.kind !== 'drafts' && scope.kind !== 'workspace' && detail && (
            <div className="detail-inner">
              <div className="detailhead">
                <h1>{detail.name}</h1>
                <button
                  className={`btn archive${confirmArchive ? ' confirming' : ''}`}
                  onClick={archiveClick}
                  title={confirmArchive ? 'Click again to archive this skill' : 'Archive this skill'}
                >
                  {confirmArchive ? 'Confirm' : 'Archive'}
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
              {detail.sameVersionDrift && detail.sameVersionDrift.length > 0 && (
                <div className="drift same-version">
                  <span className="drift-text">
                    Same version, different content: <b>v{detail.version}</b> also exists as a changed copy in{' '}
                    <code>{detail.sameVersionDrift[0].root}</code>.
                    {detail.sameVersionDrift.length > 1 ? ` ${detail.sameVersionDrift.length} copies differ.` : ''}
                  </span>
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
                        {(row as Placement & { drift?: { drifted: boolean } | null }).drift?.drifted && (
                          <button
                            className="pl-repair"
                            onClick={() => void repairPlacement(row)}
                            disabled={placementBusy === row.agent}
                            title="This copy no longer matches the source. Rewrite it from the source."
                          >
                            Repair
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

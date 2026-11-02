import { useEffect, useState } from 'react'

interface State {
  version: string
  startedAt: string
  uptimeMs: number
  dataDir: string
  registry: { rows: number; codes: number; roots: number; detected: number }
  scan: { lastScanAt: string | null; rootsScanned: number; skills: number }
}

interface Root {
  path: string
  scope: string
  owners: string[]
  origin: 'registry' | 'host'
  exists: boolean
  error: string | null
  skillCount: number | null
  lastScanAt: string | null
}

interface ScanSummary {
  ms: number
  rootsScanned: number
  skills: number
  empty: string[]
  slowest: { path: string; ms: number }[]
}

const fmt = new Intl.NumberFormat()

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [roots, setRoots] = useState<Root[]>([])
  const [summary, setSummary] = useState<ScanSummary | null>(null)
  const [scanning, setScanning] = useState(false)
  const [showMissing, setShowMissing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const [stateRes, rootsRes] = await Promise.all([fetch('/api/state'), fetch('/api/roots')])
      if (!stateRes.ok || !rootsRes.ok) throw new Error(`API ${stateRes.status}/${rootsRes.status}`)
      setState(await stateRes.json())
      const payload = await rootsRes.json()
      setRoots(payload.roots)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  async function scan() {
    setScanning(true)
    try {
      const response = await fetch('/api/scan', { method: 'POST' })
      if (!response.ok) throw new Error(`scan failed: ${response.status}`)
      setSummary(await response.json())
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setScanning(false)
    }
  }

  const detected = roots.filter((root) => root.exists)
  const missing = roots.filter((root) => !root.exists)
  const totalSkills = roots.reduce((sum, root) => sum + (root.skillCount ?? 0), 0)

  return (
    <div className="app">
      <div className="menubar">
        <b>Skill Academy</b>
        <span>File</span>
        <span>Edit</span>
        <span>View</span>
        <span>Skills</span>
        <span>Sources</span>
        <span>Help</span>
      </div>

      <div className="toolbar">
        <div className="mark">
          Roots<span>{state ? `${state.registry.detected} of ${state.registry.roots}` : 'loading'}</span>
        </div>
        <div className="spacer" />
        <a className="ghost" href="/dev">
          Dev panel
        </a>
        <button className="btn primary" onClick={scan} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      <div className="content">
        {error && <div className="banner error">API error: {error}. Is the service running on 4320?</div>}
        {summary && (
          <div className="banner">
            Scanned {summary.rootsScanned} roots in {summary.ms} ms · {fmt.format(summary.skills)} skills ·{' '}
            {summary.empty.length} empty
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th>Root</th>
              <th className="agents">Agents</th>
              <th className="num">Skills</th>
              <th className="when">Last scan</th>
            </tr>
          </thead>
          <tbody>
            {detected.map((root) => (
              <tr key={root.path}>
                <td>
                  <div className="path">
                    {root.path}
                    {root.origin === 'host' && <span className="chip host">host</span>}
                  </div>
                </td>
                <td className="agents">
                  <div className="chips">
                    {root.owners.slice(0, 4).map((owner) => (
                      <span className="chip" key={owner}>
                        {owner}
                      </span>
                    ))}
                    {root.owners.length > 4 && <span className="chip more">+{root.owners.length - 4}</span>}
                  </div>
                </td>
                <td className="num">{root.skillCount === null ? '—' : fmt.format(root.skillCount)}</td>
                <td className="when">{ago(root.lastScanAt)}</td>
              </tr>
            ))}
            {detected.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  No agent roots detected yet. Press Scan.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {missing.length > 0 && (
          <div className="missing">
            <button className="ghost" onClick={() => setShowMissing((value) => !value)}>
              {showMissing ? 'Hide' : 'Show'} {missing.length} agent roots not installed
            </button>
            {showMissing && (
              <ul>
                {missing.map((root) => (
                  <li key={root.path}>
                    <span className="path">{root.path}</span>
                    <span className="why">{root.error ?? 'missing'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="statusbar">
        <span>
          {state ? `${fmt.format(state.registry.roots)} roots · ${fmt.format(state.registry.codes)} agent codes` : '…'}
        </span>
        <span className="mid">{fmt.format(totalSkills)} skills indexed</span>
        <span className="right">
          {state ? `v${state.version} · up ${Math.round(state.uptimeMs / 1000)}s` : ''}
        </span>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'

interface State {
  version: string
  startedAt: string
  uptimeMs: number
  dataDir: string
  dbPath: string
  requests: number
  scan: { lastScanAt: string | null; rootsScanned: number; skills: number }
}

interface RequestLine {
  at: string
  method: string
  url: string
  status: number
  ms: number
}

export default function DevPanel() {
  const [state, setState] = useState<State | null>(null)
  const [requests, setRequests] = useState<RequestLine[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    async function tick() {
      try {
        const [stateRes, reqRes] = await Promise.all([fetch('/api/state'), fetch('/api/dev/requests')])
        if (!alive) return
        if (!stateRes.ok || !reqRes.ok) throw new Error(`${stateRes.status}/${reqRes.status}`)
        setState(await stateRes.json())
        setRequests((await reqRes.json()).requests)
        setError(null)
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    tick()
    const timer = setInterval(tick, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return (
    <div className="app">
      <div className="menubar">
        <b>Skill Academy</b>
        <span>Dev</span>
      </div>
      <div className="toolbar">
        <div className="mark">
          Dev panel<span>live</span>
        </div>
        <div className="spacer" />
        <a className="ghost" href="/">
          Back to app
        </a>
      </div>

      <div className="content">
        {error && <div className="banner error">Dev panel cannot reach the API: {error}</div>}

        <div className="cards">
          <div className="card">
            <div className="label">Service</div>
            <div className="value">{state ? `v${state.version}` : '—'}</div>
            <div className="meta">{state ? `up ${Math.round(state.uptimeMs / 1000)}s` : ''}</div>
          </div>
          <div className="card">
            <div className="label">Last scan</div>
            <div className="value">{state?.scan.lastScanAt ? new Date(state.scan.lastScanAt).toLocaleTimeString() : 'never'}</div>
            <div className="meta">{state ? `${state.scan.skills} skills · ${state.scan.rootsScanned} roots` : ''}</div>
          </div>
          <div className="card">
            <div className="label">Requests</div>
            <div className="value">{state?.requests ?? 0}</div>
            <div className="meta">last 200 kept</div>
          </div>
        </div>

        <div className="paths">
          <div>
            <span className="label">data</span> <code>{state?.dataDir ?? '…'}</code>
          </div>
          <div>
            <span className="label">db</span> <code>{state?.dbPath ?? '…'}</code>
          </div>
        </div>

        <h2>Requests</h2>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Method</th>
              <th>Path</th>
              <th className="num">Status</th>
              <th className="num">ms</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((line, index) => (
              <tr key={`${line.at}-${index}`}>
                <td className="when">{new Date(line.at).toLocaleTimeString()}</td>
                <td>{line.method}</td>
                <td>
                  <code>{line.url}</code>
                </td>
                <td className={`num ${line.status >= 400 ? 'bad' : ''}`}>{line.status}</td>
                <td className="num">{line.ms}</td>
              </tr>
            ))}
            {requests.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No requests yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="statusbar">
        <span>hot reload: server restarts on save, client hot-swaps</span>
        <span className="right">/dev</span>
      </div>
    </div>
  )
}

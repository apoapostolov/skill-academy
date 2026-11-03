/**
 * The notification centre.
 *
 * A list is a view of the middle column, never a dialog: this is a scope in the sidebar, a count in
 * the list header, and rows that say what happened and where. Nothing here is a second source of
 * truth — a notification is a source event or a journal entry, read through one door.
 *
 * A source event is the app noticing something new upstream. An `source-auto-blocked` entry is an
 * automatic update that refused to overwrite a local edit. Both are things a person has to decide
 * about, and both already carry their own acknowledgement.
 */
import { useCallback, useEffect, useState } from 'react'

export interface NotificationRow {
  id: string
  kind: 'source' | 'auto-blocked'
  title: string
  detail: string
  at: string
  repo: string
  acknowledged: boolean
  /** Only a source event can be acknowledged through the events route. */
  eventId?: number
}

export function NotificationList({
  onCount,
  onOpenSource
}: {
  onCount: (count: number) => void
  onOpenSource: () => void
}) {
  const [rows, setRows] = useState<NotificationRow[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const response = await fetch('/api/notifications')
    const data = (await response.json()) as { items?: NotificationRow[] }
    const items = data.items ?? []
    setRows(items)
    onCount(items.filter((row) => !row.acknowledged).length)
  }, [onCount])

  useEffect(() => {
    void load()
  }, [load])

  const acknowledge = async (row: NotificationRow): Promise<void> => {
    if (row.kind !== 'source' || row.eventId === undefined) {
      setNote('That one is a journal entry: read it, there is nothing to clear.')
      return
    }
    setBusy(true)
    try {
      await fetch(`/api/sources/events/${row.eventId}/ack`, { method: 'POST' })
      await load()
      setNote('Acknowledged. It stays in the journal.')
    } finally {
      setBusy(false)
    }
  }

  const unread = rows.filter((row) => !row.acknowledged).length

  return (
    <div className="notifylist">
      <div className="listhead">
        <span className="listcount">{unread} unread</span>
        <div className="listactions">
          <button className="ghost small" disabled={busy} onClick={() => void load()}>
            Refresh
          </button>
          <button className="ghost small" onClick={onOpenSource}>
            Sources
          </button>
        </div>
      </div>
      {note && <div className="draftstatus">{note}</div>}
      {rows.length === 0 && <div className="empty notifyempty">Nothing has happened upstream yet.</div>}
      {rows.map((row) => (
        <div className={`notifyrow ${row.acknowledged ? 'read' : ''}`} key={row.id}>
          <div className="notifytop">
            <span className="notifykind">{row.kind === 'source' ? 'upstream' : 'blocked'}</span>
            <span className="notifyname">{row.repo}</span>
            <span className="notifywhen">{new Date(row.at).toLocaleString()}</span>
            {!row.acknowledged && (
              <button className="ghost small" disabled={busy} onClick={() => void acknowledge(row)}>
                Acknowledge
              </button>
            )}
          </div>
          <div className="notifytitle">{row.title}</div>
          <div className="notifydetail">{row.detail}</div>
        </div>
      ))}
    </div>
  )
}

export interface DriftReport {
  localChanged: string[]
  localAdded: string[]
  localRemoved: string[]
}

export interface InstallationView {
  id: number
  repo: string
  remote_path: string
  name: string
  ref: string
  tag: string | null
  installed_at: string
  version: string | null
  library_path: string
  pin_ref: string | null
  pin_note: string | null
  baseline_lost: number
  policy_channel: 'release' | 'head' | 'pinned'
  policy_auto: 'off' | 'notify' | 'apply-minor' | 'apply-any'
  last_check_at: string | null
  last_state: string | null
  last_remote_ref: string | null
  drift: DriftReport
  hasLocalEdits: boolean
}

export interface RepoView {
  repo: string
  installations: InstallationView[]
  states: Record<string, number>
  changed: number
  watched: boolean
}

export interface MonitorEvent {
  id: number
  installation_id: number | null
  repo: string
  kind: string
  summary: string
  severity: 'info' | 'attention' | 'destructive'
  seen_at: string
  acknowledged: number
}

export interface Overview {
  repos: RepoView[]
  events: MonitorEvent[]
  rateLimit: { remaining: number | null; limit: number | null; resetAt: string | null }
}

export interface DiffFileRow {
  path: string
  remotePath?: string | null
  status: 'same' | 'changed' | 'added' | 'removed' | 'moved' | 'local-changed' | 'local-added' | 'local-removed'
  installedBytes: number | null
  remoteBytes: number | null
  movedFrom?: string
}

export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  left: number | null
  right: number | null
  text: string
}

export interface FileDiff {
  path: string
  status: string
  binary: boolean
  tooLarge: boolean
  normalised: boolean
  additions: number
  deletions: number
  lines: DiffLine[]
  note?: string
}

export interface Plan {
  planId: string
  fromRef: string
  toRef: string
  targetKind: string
  fileCount: number
  additions: number
  deletions: number
  versionFrom: string | null
  versionTo: string | null
  gate: { required: boolean; reasons: string[] }
  refusals: string[]
  drift: DriftReport
  localChoiceRequired: boolean
  expiresAt: string
}

export interface CheckJob {
  id: string
  status: 'running' | 'done' | 'failed'
  checked: number
  total: number
  events: number
  requests: number
  error?: string
}

export interface Unrecorded {
  name: string
  path: string
  repo: string | null
  remotePath: string | null
  ref: string | null
  reason: string
}

export const STATE_LABELS: Record<string, string> = {
  'up-to-date': 'Up to date',
  behind: 'Behind',
  'local-drift': 'Local edits',
  conflict: 'Conflict',
  gone: 'Gone upstream',
  unreachable: 'Unreachable'
}

/** The dot's colour is the state, so a person reads a column of them without reading text. */
export const STATE_TONE: Record<string, string> = {
  'up-to-date': 'ok',
  behind: 'attention',
  'local-drift': 'attention',
  conflict: 'destructive',
  gone: 'destructive',
  unreachable: 'destructive'
}

export const EVENT_LABELS: Record<string, string> = {
  'content-change': 'Content changed',
  'new-release': 'New release',
  'gone-upstream': 'Removed upstream',
  'new-skill': 'New skill upstream',
  'version-regression': 'Version went backwards',
  'silent-change': 'Same version, different bytes',
  'local-drift': 'Local edits',
  conflict: 'Local and upstream both changed'
}

/** A state nobody has checked yet is its own state, not "fine". */
export function stateOf(row: InstallationView): string {
  return row.last_state ?? 'unchecked'
}

export function needsAttention(state: string): boolean {
  return state === 'behind' || state === 'conflict' || state === 'local-drift' || state === 'gone' || state === 'unreachable'
}

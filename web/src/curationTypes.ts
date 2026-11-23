export interface CurationMember {
  id: number
  name: string
  path: string
  root: string
  version: string | null
  tokens: number
  hash: string
}

export interface CurationGroup {
  kind: 'duplicate' | 'variant' | 'near-duplicate' | 'family-overload'
  key: string
  members: CurationMember[]
  evidence: string
  action: 'merge' | 'keep-one' | 'review'
  keep?: number
}

export interface CurationReport {
  groups: CurationGroup[]
  similar: Array<{ a: string; b: string; score: number }>
  stale: Array<{ id: number; name: string; path: string; daysSinceModified: number }>
  scanned: number
  ms: number
  summary: Record<string, number>
}

export const CLUSTER_LABELS: Record<string, string> = {
  duplicate: 'Duplicate',
  variant: 'Variant',
  'near-duplicate': 'Near duplicate',
  'family-overload': 'Family overload'
}

export const CLUSTER_HINTS: Record<string, string> = {
  duplicate: 'Identical bytes in more than one place. One copy can answer for the others.',
  variant: 'One name, several bodies. Someone has to say which one is current.',
  'near-duplicate': 'Descriptions overlap heavily. Worth a look before two skills drift apart.',
  'family-overload': 'One family holds more members than a reader can load at once.'
}

export const ACTION_LABELS: Record<string, string> = {
  merge: 'merge',
  'keep-one': 'keep one',
  review: 'review'
}

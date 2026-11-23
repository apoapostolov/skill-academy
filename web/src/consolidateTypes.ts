export interface ConsolidateMemberView {
  /** The index row for this copy, so the panel can read its body instead of asking by name. */
  skillId: number | null
  name: string
  path: string
  version: string | null
  chars: number
  hash: string
  uniqueHeadings: string[]
  missingHeadings: string[]
  uniqueRules: string[]
  supportFiles: number
}

export interface ConsolidatePlan {
  survivor: string
  pointerize: Array<{ name: string; body: string }>
  routerize: Array<{ name: string; outline: string[] }>
  rewire: string[]
  verification: string[]
}

export interface ConsolidateGroupView {
  key: string
  liveRoot?: boolean
  mergeType: string
  evidence: string
  survivor: string | null
  members: ConsolidateMemberView[]
  plan: ConsolidatePlan | null
  blocked: string | null
}

/**
 * The dry run answers with exactly these keys. Anything the panel shows has to come from here, and
 * an optional field is optional because the server does not always have it: `intentional-family`
 * groups carry no plan at all.
 */
export interface ConsolidateReport {
  groups: ConsolidateGroupView[]
  summary: Record<string, number>
  scanned: number
  roots?: number
  ms: number
}

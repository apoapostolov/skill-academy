/**
 * Three-way line merge, for sync.
 *
 * Both machines started from one committed file, so the committed copy is the base. A pull that
 * finds the file changed on both sides can then ask a narrower question than "which copy wins":
 * which lines did each side touch, and did they touch the same ones.
 *
 * The output is the merged text. A region both sides rewrote differently becomes a conflict block,
 * marked in the file itself. Nothing is guessed and nothing is silently dropped.
 */

export interface MergeResult {
  clean: boolean
  text: string
  conflicts: number
}

interface Hunk {
  /** First base line the hunk replaces. */
  start: number
  /** One past the last base line the hunk replaces. */
  end: number
  replacement: string[]
}

const CONFLICT_START = '<<<<<<< this machine'
const CONFLICT_MIDDLE = '======='
const CONFLICT_END = '>>>>>>> the shared copy'

function splitLines(text: string): string[] {
  if (!text) return []
  // A trailing newline is a property of the file, not a line, so it is put back on join.
  return text.replace(/\r\n/g, '\n').split('\n')
}

/** Longest common subsequence over lines, returned as the aligned index pairs. */
function lcs(a: string[], b: string[]): number[][] {
  const rows = a.length + 1
  const cols = b.length + 1
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

/** Every region where `side` differs from `base`, expressed as ranges over base. */
function hunksAgainst(base: string[], side: string[]): Hunk[] {
  const table = lcs(base, side)
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  while (i < base.length && j < side.length) {
    if (base[i] === side[j]) {
      i += 1
      j += 1
      continue
    }
    const start = i
    const startSide = j
    // Walk to the next line both sides agree on, choosing the direction the alignment prefers. The
    // loop always consumes a line, so a hunk can never be empty and the walk always terminates.
    while (i < base.length && j < side.length && base[i] !== side[j]) {
      if (table[i + 1][j] >= table[i][j + 1]) i += 1
      else j += 1
    }
    hunks.push({ start, end: i, replacement: side.slice(startSide, j) })
  }
  if (i < base.length || j < side.length) {
    hunks.push({ start: i, end: base.length, replacement: side.slice(j) })
  }
  return hunks
}

export function mergeText(baseText: string, localText: string, remoteText: string): MergeResult {
  const base = splitLines(baseText)
  const local = splitLines(localText)
  const remote = splitLines(remoteText)

  const localHunks = hunksAgainst(base, local)
  const remoteHunks = hunksAgainst(base, remote)

  const out: string[] = []
  let cursor = 0
  let conflicts = 0
  let li = 0
  let ri = 0

  const flush = (upTo: number): void => {
    for (let index = cursor; index < upTo; index += 1) out.push(base[index])
    cursor = upTo
  }

  while (li < localHunks.length || ri < remoteHunks.length) {
    const nextLocal = localHunks[li]
    const nextRemote = remoteHunks[ri]

    // One side only: apply it as it stands, as long as it starts after everything already emitted.
    if (!nextRemote || (nextLocal && nextLocal.end <= nextRemote.start)) {
      if (nextLocal.start >= cursor) {
        flush(nextLocal.start)
        out.push(...nextLocal.replacement)
        cursor = nextLocal.end
        li += 1
      } else {
        li += 1
      }
      continue
    }
    if (!nextLocal || nextRemote.end <= nextLocal.start) {
      if (nextRemote.start >= cursor) {
        flush(nextRemote.start)
        out.push(...nextRemote.replacement)
        cursor = nextRemote.end
        ri += 1
      } else {
        ri += 1
      }
      continue
    }

    // Overlap: gather every hunk from both sides that touches this region, then decide once.
    let regionStart = Math.min(nextLocal.start, nextRemote.start)
    let regionEnd = Math.max(nextLocal.end, nextRemote.end)
    const localParts: string[] = []
    const remoteParts: string[] = []
    let grew = true
    while (grew) {
      grew = false
      while (li < localHunks.length && localHunks[li].start <= regionEnd) {
        localParts.push(...localHunks[li].replacement)
        regionEnd = Math.max(regionEnd, localHunks[li].end)
        regionStart = Math.min(regionStart, localHunks[li].start)
        li += 1
        grew = true
      }
      while (ri < remoteHunks.length && remoteHunks[ri].start <= regionEnd) {
        remoteParts.push(...remoteHunks[ri].replacement)
        regionEnd = Math.max(regionEnd, remoteHunks[ri].end)
        regionStart = Math.min(regionStart, remoteHunks[ri].start)
        ri += 1
        grew = true
      }
    }

    if (regionStart < cursor) continue
    flush(regionStart)
    cursor = regionEnd
    if (localParts.join('\n') === remoteParts.join('\n')) {
      out.push(...localParts)
      continue
    }
    conflicts += 1
    out.push(CONFLICT_START, ...localParts, CONFLICT_MIDDLE, ...remoteParts, CONFLICT_END)
  }

  flush(base.length)
  return { clean: conflicts === 0, text: out.join('\n'), conflicts }
}

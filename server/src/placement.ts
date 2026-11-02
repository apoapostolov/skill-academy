import fs from 'node:fs'
import path from 'node:path'

export type PlacementMode = 'junction' | 'symlink' | 'copy' | 'native'

export interface PlacementResult {
  ok: boolean
  mode?: PlacementMode
  target: string
  reason?: string
}

/** Written into a tracked copy so an uninstall can prove it owns the directory. */
export const MANIFEST = '.skill-academy.json'

function isLinkLike(target: string): boolean {
  try {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) return true
    // A junction is a directory with a reparse point; readlink resolves it.
    fs.readlinkSync(target)
    return true
  } catch {
    return false
  }
}

export function isLinked(target: string): boolean {
  return isLinkLike(target)
}

export function exists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * Makes one agent see one package.
 *
 * Order is deliberate: a junction works unelevated on NTFS, a directory symlink
 * needs Developer Mode or elevation, and a copy is the last resort because it can
 * drift. The copy carries a manifest so it can be told apart from a package the
 * agent actually owns.
 */
export function place(
  skillPath: string,
  rootPath: string,
  options: { allowCopy?: boolean; forceCopy?: boolean } = {}
): PlacementResult {
  const source = path.resolve(skillPath)
  const target = path.join(rootPath, path.basename(source))

  if (path.resolve(target) === source) return { ok: true, mode: 'native', target }
  if (exists(target)) {
    return { ok: false, target, reason: isLinkLike(target) ? 'linked-elsewhere' : 'occupied' }
  }
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    return { ok: false, target, reason: 'no-skill-md' }
  }

  const forceCopy = options.forceCopy ?? process.env.SKILL_ACADEMY_FORCE_COPY === '1'
  const strategies: { mode: PlacementMode; type: 'junction' | 'dir' }[] = forceCopy
    ? []
    : [
        { mode: 'junction', type: 'junction' },
        { mode: 'symlink', type: 'dir' }
      ]
  for (const strategy of strategies) {
    try {
      fs.symlinkSync(source, target, strategy.type)
      return { ok: true, mode: strategy.mode, target }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (code === 'EEXIST') return { ok: false, target, reason: 'occupied' }
      // EPERM / EACCES / UNKNOWN: fall through to the next strategy.
    }
  }

  if (options.allowCopy === false) return { ok: false, target, reason: 'link-failed' }

  try {
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true })
    fs.writeFileSync(
      path.join(target, MANIFEST),
      JSON.stringify({ source, mode: 'copy', created: new Date().toISOString() }, null, 2)
    )
    return { ok: true, mode: 'copy', target }
  } catch (error) {
    return { ok: false, target, reason: `copy-failed: ${(error as Error).message}` }
  }
}

/**
 * Removes the placement, never the source. A link is unlinked; a tracked copy is
 * moved to the app trash so a mistaken uninstall is still recoverable.
 */
export function unplace(target: string, trashDir?: string): { ok: boolean; mode?: PlacementMode; reason?: string; trashed?: string } {
  if (!exists(target)) return { ok: false, reason: 'missing' }

  if (isLinkLike(target)) {
    try {
      fs.unlinkSync(target)
      return { ok: true, mode: 'junction' }
    } catch {
      try {
        fs.rmdirSync(target)
        return { ok: true, mode: 'junction' }
      } catch (error) {
        return { ok: false, reason: `unlink-failed: ${(error as Error).message}` }
      }
    }
  }

  let manifest: { source?: string } | null = null
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(target, MANIFEST), 'utf8'))
  } catch {
    manifest = null
  }
  if (!manifest) return { ok: false, reason: 'not-ours' }

  if (!trashDir) return { ok: false, reason: 'no-trash' }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = path.join(trashDir, `${stamp}-${path.basename(target)}`)
  try {
    fs.mkdirSync(trashDir, { recursive: true })
    fs.renameSync(target, destination)
    return { ok: true, mode: 'copy', trashed: destination }
  } catch (error) {
    return { ok: false, reason: `trash-failed: ${(error as Error).message}` }
  }
}

export function describe(target: string): { exists: boolean; link: boolean; ours: boolean; pointsTo?: string } {
  if (!exists(target)) return { exists: false, link: false, ours: false }
  if (isLinkLike(target)) {
    let pointsTo: string | undefined
    try {
      pointsTo = fs.readlinkSync(target)
    } catch {
      pointsTo = undefined
    }
    return { exists: true, link: true, ours: true, pointsTo }
  }
  const ours = fs.existsSync(path.join(target, MANIFEST))
  return { exists: true, link: false, ours }
}

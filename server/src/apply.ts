import fs from 'node:fs'
import path from 'node:path'
import type { AgentRoot } from './registry'
import { scanOne } from './scan'
import { parseSkill } from './skill'
import { applyDeletion, saveOne, saveRoot, type SaveResult } from './db'

/**
 * Applies a batch of filesystem changes to the index.
 *
 * The cheap paths matter more than they look: a package that vanished, or one that just
 * appeared, is a single row, and rescanning the whole root for it costs the difference
 * between answering in 60 ms and in a second.
 */
export function applyChange(root: AgentRoot, paths: string[]): SaveResult {
  const result: SaveResult = { added: 0, changed: 0, removed: 0 }
  if (paths.length === 0) return result

  const gone = paths.filter((candidate) => !fs.existsSync(candidate))
  if (gone.length === paths.length) {
    result.removed = applyDeletion(gone)
    return result
  }

  // Every touched path that sits inside a package is that package: index it, not the root.
  const packages = new Set<string>()
  for (const candidate of paths) {
    try {
      const stats = fs.statSync(candidate)
      const dir = stats.isDirectory() ? candidate : path.dirname(candidate)
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) packages.add(dir)
    } catch {
      /* vanished between event and read */
    }
  }
  if (packages.size > 0) {
    for (const dir of packages) {
      const skill = parseSkill(dir, root.path, root.scope)
      if (!skill) continue
      const saved = saveOne(root.path, root.scope, skill)
      result.added += saved.added
      result.changed += saved.changed
    }
    return result
  }

  return saveRoot(scanOne(root))
}

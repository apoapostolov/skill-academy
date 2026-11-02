import { watch, type FSWatcher } from 'chokidar'
import type { AgentRoot } from './registry'

export interface Change {
  root: AgentRoot
  paths: string[]
}

const DEBOUNCE_MS = 150
const IGNORED = /[\\/](\.git|node_modules|\.cache|\.skill-academy-tmp)([\\/]|$)/

/**
 * One watcher per detected root, depth-capped to the same three levels the scan
 * walks. Events are coalesced per root so a directory copied into place produces
 * one rescan, not forty.
 */
export class RootWatcher {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()
  private pending = new Map<string, Set<string>>()
  private readonly onChange: (change: Change) => void

  constructor(onChange: (change: Change) => void) {
    this.onChange = onChange
  }

  sync(roots: AgentRoot[]): void {
    const wanted = new Map(roots.filter((root) => root.exists).map((root) => [root.path.toLowerCase(), root]))

    for (const [key, watcher] of this.watchers) {
      if (wanted.has(key)) continue
      void watcher.close()
      this.watchers.delete(key)
      this.pending.delete(key)
    }

    for (const [key, root] of wanted) {
      if (this.watchers.has(key)) continue
      const watcher = watch(root.path, {
        depth: 3,
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
        ignored: (target: string) => IGNORED.test(target)
      })

      const fire = (target: string) => {
        const bucket = this.pending.get(key) ?? new Set<string>()
        bucket.add(target)
        this.pending.set(key, bucket)
        const existing = this.timers.get(key)
        if (existing) clearTimeout(existing)
        this.timers.set(
          key,
          setTimeout(() => {
            this.timers.delete(key)
            const paths = [...(this.pending.get(key) ?? [])]
            this.pending.delete(key)
            this.onChange({ root, paths })
          }, DEBOUNCE_MS)
        )
      }

      watcher
        .on('add', fire)
        .on('change', fire)
        .on('unlink', fire)
        .on('addDir', fire)
        .on('unlinkDir', fire)
        .on('error', (error) => console.error(`watch error ${root.path}`, error))

      this.watchers.set(key, watcher)
    }
  }

  get size(): number {
    return this.watchers.size
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const watcher of this.watchers.values()) await watcher.close()
    this.watchers.clear()
  }
}

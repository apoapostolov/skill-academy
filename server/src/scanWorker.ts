import { parentPort, workerData } from 'node:worker_threads'
import type { AgentRoot } from './registry'
import { scanOne } from './scan'

// One slice of the library, parsed off the main thread. The scan is read-only, so a worker needs
// nothing but the roots it was handed.
const entries = (workerData as { roots: AgentRoot[] }).roots.map(scanOne)
parentPort?.postMessage(entries)

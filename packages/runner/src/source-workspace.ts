import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Piscina as PiscinaInstance } from 'piscina'
import type {
  DoctorSourceFileAnalysis,
  DoctorSourceTask
} from './source-analysis.js'

const defaultMaxEntries = 2_048
const defaultMaxBytes = 64 * 1024 * 1024
const defaultMaxThreads = 4

export interface DoctorSourceWorkspaceOptions {
  maxEntries?: number
  maxBytes?: number
  readSource?: (file: string) => Promise<string | Uint8Array>
  createPool?: () => Promise<SourceWorkerPool>
}

export interface SourceWorkerPool {
  run(tasks: DoctorSourceTask[]): Promise<DoctorSourceFileAnalysis[]>
  destroy(): Promise<void>
}

export interface DoctorSourceWorkspaceStats {
  sourceReads: number
  sourceBytes: number
  factCacheHits: number
  factCacheMisses: number
  parseCount: number
  analysisMilliseconds: number
  workerPoolStarts: number
  workerFallbacks: number
  factCacheEntries: number
  factCacheBytes: number
}

export interface SourceTextFact {
  file: string
  source: string
  contentHash: string
  bytes: number
  invalidEncoding: boolean
}

interface FactCacheEntry {
  key: string
  file: string
  bytes: number
  value: DoctorSourceFileAnalysis
}

/**
 * Per-host source state. Files are always re-read; only immutable, content-keyed
 * analysis facts survive between generations.
 */
export class DoctorSourceWorkspace {
  readonly #maxEntries: number
  readonly #maxBytes: number
  readonly #readSource: (file: string) => Promise<string | Uint8Array>
  readonly #createPool: () => Promise<SourceWorkerPool>
  readonly #facts = new Map<string, FactCacheEntry>()
  readonly #stats: Omit<DoctorSourceWorkspaceStats, 'factCacheEntries' | 'factCacheBytes'> = {
    sourceReads: 0,
    sourceBytes: 0,
    factCacheHits: 0,
    factCacheMisses: 0,
    parseCount: 0,
    analysisMilliseconds: 0,
    workerPoolStarts: 0,
    workerFallbacks: 0
  }
  #factBytes = 0
  #poolPromise: Promise<SourceWorkerPool> | undefined
  #poolUnavailable = false
  #closed = false

  constructor(options: DoctorSourceWorkspaceOptions = {}) {
    this.#maxEntries = positiveInteger(options.maxEntries, defaultMaxEntries)
    this.#maxBytes = positiveInteger(options.maxBytes, defaultMaxBytes)
    this.#readSource = options.readSource ?? ((file) => readFile(file))
    this.#createPool = options.createPool ?? createPiscinaPool
  }

  async read(file: string): Promise<SourceTextFact> {
    this.#assertOpen()
    const read = await this.#readSource(file)
    const decoded = typeof read === 'string' ? { source: read, invalidEncoding: false } : decodeSource(read)
    const source = decoded.source
    const bytes = Buffer.byteLength(source, 'utf8')
    this.#stats.sourceReads += 1
    this.#stats.sourceBytes += bytes
    return {
      file,
      source,
      bytes,
      invalidEncoding: decoded.invalidEncoding,
      contentHash: createHash('sha256').update(source).digest('hex')
    }
  }

  getFact(key: string): DoctorSourceFileAnalysis | undefined {
    this.#assertOpen()
    const cached = this.#facts.get(key)
    if (!cached) {
      this.#stats.factCacheMisses += 1
      return undefined
    }
    this.#facts.delete(key)
    this.#facts.set(key, cached)
    this.#stats.factCacheHits += 1
    return cloneAnalysis(cached.value)
  }

  setFact(key: string, file: string, value: DoctorSourceFileAnalysis): void {
    this.#assertOpen()
    const cloned = cloneAnalysis(value)
    const bytes = Buffer.byteLength(JSON.stringify(cloned), 'utf8')
    const existing = this.#facts.get(key)
    if (existing) {
      this.#facts.delete(key)
      this.#factBytes -= existing.bytes
    }
    this.#facts.set(key, { key, file, bytes, value: deepFreeze(cloned) })
    this.#factBytes += bytes
    this.#evict()
  }

  recordParses(count: number): void {
    this.#stats.parseCount += count
  }

  recordAnalysisTime(milliseconds: number): void {
    this.#stats.analysisMilliseconds += milliseconds
  }

  async runWorkerTasks(
    tasks: DoctorSourceTask[],
    fallback: () => DoctorSourceFileAnalysis[]
  ): Promise<{ results: DoctorSourceFileAnalysis[]; parallel: boolean }> {
    this.#assertOpen()
    if (this.#poolUnavailable) return { results: fallback(), parallel: false }
    try {
      const pool = await this.#getPool()
      return { results: await pool.run(tasks), parallel: true }
    } catch {
      this.#stats.workerFallbacks += 1
      this.#poolUnavailable = true
      const pool = await this.#poolPromise?.catch(() => undefined)
      this.#poolPromise = undefined
      await pool?.destroy().catch(() => undefined)
      return { results: fallback(), parallel: false }
    }
  }

  invalidate(pathOrPaths?: string | readonly string[]): void {
    this.#assertOpen()
    if (pathOrPaths === undefined) {
      this.#facts.clear()
      this.#factBytes = 0
      return
    }
    const paths = (typeof pathOrPaths === 'string' ? [pathOrPaths] : pathOrPaths)
      .map((path) => resolve(path))
    for (const [key, entry] of this.#facts) {
      if (!paths.some((path) => entry.file === path || isInside(path, entry.file))) continue
      this.#facts.delete(key)
      this.#factBytes -= entry.bytes
    }
  }

  getStats(): DoctorSourceWorkspaceStats {
    return {
      ...this.#stats,
      factCacheEntries: this.#facts.size,
      factCacheBytes: this.#factBytes
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const pool = await this.#poolPromise?.catch(() => undefined)
    this.#poolPromise = undefined
    await pool?.destroy().catch(() => undefined)
    this.#facts.clear()
    this.#factBytes = 0
  }

  async #getPool(): Promise<SourceWorkerPool> {
    this.#poolPromise ??= this.#createPool().then((pool) => {
      this.#stats.workerPoolStarts += 1
      return pool
    })
    return this.#poolPromise
  }

  #evict(): void {
    while (this.#facts.size > this.#maxEntries || this.#factBytes > this.#maxBytes) {
      const oldest = this.#facts.values().next().value as FactCacheEntry | undefined
      if (!oldest) break
      this.#facts.delete(oldest.key)
      this.#factBytes -= oldest.bytes
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Vue Doctor source workspace is closed.')
  }
}

async function createPiscinaPool(): Promise<SourceWorkerPool> {
  const { Piscina } = await import('piscina')
  const maxThreads = resolveMaxThreads()
  const pool: PiscinaInstance = new Piscina({
    filename: new URL('./source-worker.mjs', import.meta.url).href,
    minThreads: Math.min(2, maxThreads),
    maxThreads
  })
  return {
    run: (tasks) => pool.run(tasks),
    destroy: () => pool.destroy()
  }
}

function cloneAnalysis(value: DoctorSourceFileAnalysis): DoctorSourceFileAnalysis {
  return structuredClone(value)
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  return value
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback
}

function resolveMaxThreads(): number {
  const configured = Number(process.env.VUE_DOCTOR_MAX_THREADS)
  const requested = Number.isInteger(configured) && configured >= 1
    ? configured
    : defaultMaxThreads
  return Math.max(1, Math.min(requested, availableParallelism() - 1 || 1))
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
}

function decodeSource(bytes: Uint8Array): { source: string; invalidEncoding: boolean } {
  try {
    return {
      source: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      invalidEncoding: false
    }
  } catch {
    return { source: Buffer.from(bytes).toString('utf8'), invalidEncoding: true }
  }
}

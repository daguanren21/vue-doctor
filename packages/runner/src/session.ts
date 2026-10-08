import { resolve } from 'node:path'
import type { DoctorReport, DoctorRunOptions } from '@vue-doctor/core'
import {
  DoctorSourceWorkspace,
  type DoctorSourceWorkspaceOptions,
  type DoctorSourceWorkspaceStats
} from './source-workspace.js'

export interface DoctorRunGenerationContext {
  generation: number
  sourceWorkspace: DoctorSourceWorkspace
  recordPhase?: (name: DoctorAnalysisPhase, milliseconds: number, rssBytes: number) => void
}

export type DoctorAnalysisPhase =
  | 'config'
  | 'inventory'
  | 'targetDiscovery'
  | 'projectContext'
  | 'sourceAnalysis'
  | 'componentContracts'
  | 'componentAnalysis'
  | 'builtinRules'
  | 'documents'
  | 'externalRules'
  | 'report'

export interface DoctorAnalysisRunStats {
  generation: number
  totalMilliseconds: number
  phases: Partial<Record<DoctorAnalysisPhase, number>>
  peakRssBytes: number
}

/** @internal Dependency seam used by deterministic session tests and host adapters. */
export interface DoctorAnalysisSessionServices {
  runGeneration?: (
    options: DoctorRunOptions,
    context: DoctorRunGenerationContext
  ) => Promise<DoctorReport>
  sourceWorkspace?: DoctorSourceWorkspace
  sourceWorkspaceOptions?: DoctorSourceWorkspaceOptions
}

export interface DoctorAnalysisSessionStats {
  generation: number
  runsStarted: number
  runsCompleted: number
  runsFailed: number
  inFlightRuns: number
  latestGeneration?: number
  phaseMilliseconds: {
    doctorRun: number
    sourceAnalysis: number
  }
  /** Highest RSS observed at session creation, phase boundaries or generation completion. */
  peakRssBytes: number
  lastRun?: DoctorAnalysisRunStats
  source: DoctorSourceWorkspaceStats
}

export interface DoctorAnalysisSession {
  /** Deduplicates only callers observing the same still-running generation. */
  run(): Promise<DoctorReport>
  /** Starts a new generation and removes matching reusable facts. */
  invalidate(pathOrPaths?: string | readonly string[]): void
  /** The latest completed report only when it belongs to the current generation. */
  getLatestReport(): DoctorReport | undefined
  /** Operational metrics kept outside the deterministic report contract. */
  getStats(): DoctorAnalysisSessionStats
  /** Stops new work, settles active generations and releases workers and facts. */
  close(): Promise<void>
}

export function createDoctorAnalysisSession(
  options: DoctorRunOptions = {},
  services: DoctorAnalysisSessionServices = {}
): DoctorAnalysisSession {
  const root = resolve(options.root ?? process.cwd())
  const boundOptions = bindOptions(options, root)
  const workspace = services.sourceWorkspace
    ?? new DoctorSourceWorkspace(services.sourceWorkspaceOptions)
  const runGeneration = services.runGeneration ?? defaultRunGeneration
  const inFlight = new Map<number, Promise<DoctorReport>>()
  let generation = 0
  let runsStarted = 0
  let runsCompleted = 0
  let runsFailed = 0
  let latest: { generation: number; report: DoctorReport } | undefined
  let doctorRunMilliseconds = 0
  let peakRssBytes = process.memoryUsage().rss
  let lastRun: DoctorAnalysisRunStats | undefined
  let closed = false
  let closePromise: Promise<void> | undefined

  const session: DoctorAnalysisSession = {
    run(): Promise<DoctorReport> {
      if (closed) return Promise.reject(new Error('Vue Doctor analysis session is closed.'))
      const currentGeneration = generation
      const existing = inFlight.get(currentGeneration)
      if (existing) return existing

      runsStarted += 1
      const startedAt = performance.now()
      const runPhases: Partial<Record<DoctorAnalysisPhase, number>> = {}
      let runPeakRssBytes = process.memoryUsage().rss
      let promise: Promise<DoctorReport>
      promise = Promise.resolve()
        .then(() => runGeneration(boundOptions, {
          generation: currentGeneration,
          sourceWorkspace: workspace,
          recordPhase(name, milliseconds, rssBytes) {
            runPhases[name] = (runPhases[name] ?? 0) + milliseconds
            runPeakRssBytes = Math.max(runPeakRssBytes, rssBytes)
            peakRssBytes = Math.max(peakRssBytes, rssBytes)
          }
        }))
        .then((report) => {
          doctorRunMilliseconds += performance.now() - startedAt
          peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
          runsCompleted += 1
          const immutableReport = deepFreeze(structuredClone(report))
          if (!closed && generation === currentGeneration) {
            latest = { generation: currentGeneration, report: structuredClone(immutableReport) }
            lastRun = {
              generation: currentGeneration,
              totalMilliseconds: performance.now() - startedAt,
              phases: { ...runPhases },
              peakRssBytes: runPeakRssBytes
            }
          }
          if (inFlight.get(currentGeneration) === promise) inFlight.delete(currentGeneration)
          return immutableReport
        }, (error: unknown) => {
          doctorRunMilliseconds += performance.now() - startedAt
          peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
          runsFailed += 1
          if (inFlight.get(currentGeneration) === promise) inFlight.delete(currentGeneration)
          throw error
        })
      inFlight.set(currentGeneration, promise)
      return promise
    },

    invalidate(pathOrPaths): void {
      assertOpen(closed)
      generation += 1
      latest = undefined
      if (pathOrPaths === undefined) {
        workspace.invalidate()
        return
      }
      const paths = (typeof pathOrPaths === 'string' ? [pathOrPaths] : pathOrPaths)
        .map((path) => resolve(root, path))
      workspace.invalidate(paths)
    },

    getLatestReport(): DoctorReport | undefined {
      if (!latest || latest.generation !== generation) return undefined
      return structuredClone(latest.report)
    },

    getStats(): DoctorAnalysisSessionStats {
      const source = workspace.getStats()
      return {
        generation,
        runsStarted,
        runsCompleted,
        runsFailed,
        inFlightRuns: inFlight.size,
        ...(latest?.generation === generation ? { latestGeneration: generation } : {}),
        phaseMilliseconds: {
          doctorRun: doctorRunMilliseconds,
          sourceAnalysis: source.analysisMilliseconds
        },
        peakRssBytes,
        ...(lastRun?.generation === generation ? { lastRun: structuredClone(lastRun) } : {}),
        source
      }
    },

    close(): Promise<void> {
      if (closePromise) return closePromise
      closed = true
      latest = undefined
      closePromise = (async () => {
        await Promise.allSettled([...inFlight.values()])
        await workspace.close()
      })()
      return closePromise
    }
  }

  return session
}

async function defaultRunGeneration(
  options: DoctorRunOptions,
  context: DoctorRunGenerationContext
): Promise<DoctorReport> {
  const runner = await import('./run.js') as unknown as {
    runDoctorGeneration: (
      options: DoctorRunOptions,
      context: DoctorRunGenerationContext
    ) => Promise<DoctorReport>
  }
  return runner.runDoctorGeneration(options, context)
}

function bindOptions(options: DoctorRunOptions, root: string): DoctorRunOptions {
  return {
    ...options,
    root,
    ...(Array.isArray(options.scope) ? { scope: [...options.scope] } : {}),
    ...(options.files ? { files: [...options.files] } : {}),
    ...(options.config ? {
      config: {
        ...options.config,
        ...(options.config.rules ? { rules: { ...options.config.rules } } : {}),
        ...(options.config.ui ? {
          ui: {
            ...options.config.ui,
            ...(options.config.ui.libraries
              ? { libraries: structuredClone(options.config.ui.libraries) }
              : {})
          }
        } : {}),
        ...(options.config.rulePacks ? { rulePacks: [...options.config.rulePacks] } : {})
      }
    } : {})
  }
}

function assertOpen(closed: boolean): void {
  if (closed) throw new Error('Vue Doctor analysis session is closed.')
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  return value
}

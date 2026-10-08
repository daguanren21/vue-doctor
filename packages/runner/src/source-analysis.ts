import { extname, resolve } from 'node:path'
import {
  createVueDoctorCacheKey,
  readVueDoctorCache,
  removeVueDoctorCache,
  writeVueDoctorCache,
  type Diagnostic,
  type DoctorRunOptions
} from '@vue-doctor/core'
import { diagnoseVueSource } from '@vue-doctor/rule-pack-vue'
import {
  analyzeSourceText,
  discoverTargetFiles,
  type AnalyzeSourceTextOptions,
  type SourceAnalysisFact,
  type SourceDocument,
  type TargetFiles,
  type VueComponentUsage,
  type VueGlobalPluginUsage,
  type VueSourceFileResult,
  type VueSourceUsageReport
} from '@vue-doctor/source'
import pMap from 'p-map'
import {
  DoctorSourceWorkspace,
  type SourceTextFact
} from './source-workspace.js'

const sourceCacheNamespace = 'source-v31'
const defaultParallelThreshold = 512
const defaultParallelMinBytes = 1_000_000
const diagnosticSourceExtensions = new Set(['.vue', '.js', '.mjs', '.cjs', '.ts', '.tsx'])

export interface DoctorSourceTask {
  file: string
  source: string
  vueVersion?: string
  analysisProfiles?: readonly AnalyzeSourceTextOptions[]
}

export type PreparedSourceDocument = Omit<SourceDocument, 'text'>

export interface DoctorSourceFileAnalysis {
  fileResult: VueSourceFileResult
  components: VueComponentUsage[]
  globalPlugins: VueGlobalPluginUsage[]
  diagnostics: Diagnostic[]
  preparedDocument?: PreparedSourceDocument
  sourceFacts: SourceAnalysisFact[]
}

export interface DoctorSourceScan {
  source: VueSourceUsageReport
  diagnostics: Diagnostic[]
  cacheHits: number
  cacheMisses: number
  parallel: boolean
  /** All authoritative target texts, including external rule-pack languages. */
  sourceTexts: ReadonlyMap<string, string>
  invalidEncodingFiles: ReadonlySet<string>
  readFailures: ReadonlyMap<string, unknown>
  /** Compact document facts created by the source parser and safe to reuse. */
  preparedDocuments: ReadonlyMap<string, PreparedSourceDocument>
  sourceFacts: readonly SourceAnalysisFact[]
}

export async function scanDoctorSource(options: {
  root?: string
  scope?: DoctorRunOptions['scope']
  files?: DoctorRunOptions['files']
  /** Authoritative target selection; when present no discovery is repeated. */
  targetFiles?: TargetFiles
  vueVersion?: string
  /** Actual consuming-package versions keyed by target file, including unresolved entries. */
  vueVersions?: Readonly<Record<string, string | undefined>>
  cacheDirectory?: string
  parallel?: boolean
  analysisProfiles?: readonly AnalyzeSourceTextOptions[]
  workspace?: DoctorSourceWorkspace
} = {}): Promise<DoctorSourceScan> {
  const root = resolve(options.root ?? options.targetFiles?.root ?? process.cwd())
  const targetFiles = options.targetFiles ?? await discoverTargetFiles({
    root,
    scope: options.scope,
    files: options.files
  })
  const files = targetFiles.files.filter((file) => diagnosticSourceExtensions.has(extname(file)))
  const workspace = options.workspace ?? new DoctorSourceWorkspace()
  const ownsWorkspace = options.workspace === undefined
  const startedAt = performance.now()
  let cacheHits = 0
  let cacheMisses = 0
  let usedParallel = false

  try {
    const texts = new Map<string, string>()
    const invalidEncodingFiles = new Set<string>()
    const facts = new Map<string, SourceTextFact>()
    const readFailures = new Map<string, unknown>()
    await pMap(targetFiles.files, async (file) => {
      try {
        const fact = await workspace.read(file)
        facts.set(file, fact)
        texts.set(file, fact.source)
        if (fact.invalidEncoding) invalidEncodingFiles.add(file)
      } catch (error) {
        readFailures.set(file, error)
      }
    }, { concurrency: 64 })

    const analyses = new Array<DoctorSourceFileAnalysis>(files.length)
    const pending: Array<{
      index: number
      key: string
      task: DoctorSourceTask
    }> = []
    await pMap(files, async (file, index) => {
      const failure = readFailures.get(file)
      const fact = facts.get(file)
      if (failure || !fact) {
        analyses[index] = failedFileAnalysis(file, failure ?? 'Source file could not be read.')
        return
      }
      const vueVersion = versionForFile(options, file)
      const key = createVueDoctorCacheKey([
        sourceCacheNamespace,
        file,
        vueVersion ?? '',
        fact.contentHash,
        serializeProfiles(options.analysisProfiles)
      ])
      const inMemory = workspace.getFact(key)
      if (inMemory) {
        cacheHits += 1
        analyses[index] = inMemory
        return
      }
      const onDisk = await readSourceCache(key, options.cacheDirectory)
      if (onDisk) {
        cacheHits += 1
        workspace.setFact(key, file, onDisk)
        analyses[index] = structuredClone(onDisk)
        return
      }
      cacheMisses += 1
      pending.push({
        index,
        key,
        task: {
          file,
          source: fact.source,
          ...(vueVersion ? { vueVersion } : {}),
          ...(options.analysisProfiles?.length
            ? { analysisProfiles: normalizeProfiles(options.analysisProfiles) }
            : {})
        }
      })
    }, { concurrency: 64 })

    const pendingSourceBytes = pending.reduce((total, item) => (
      total + Buffer.byteLength(item.task.source, 'utf8')
    ), 0)
    const parallel = options.parallel ?? (
      files.length >= parallelThreshold()
      && pendingSourceBytes >= parallelMinBytes()
    )

    if (parallel && pending.length > 0) {
      const batchSize = Math.max(1, Math.ceil(pending.length / 8))
      const batches: typeof pending[] = []
      for (let index = 0; index < pending.length; index += batchSize) {
        batches.push(pending.slice(index, index + batchSize))
      }
      await Promise.all(batches.map(async (batch) => {
        const worker = await workspace.runWorkerTasks(
          batch.map((item) => item.task),
          () => batch.map((item) => analyzeDoctorSourceTask(item.task))
        )
        usedParallel ||= worker.parallel
        for (const [index, item] of batch.entries()) {
          analyses[item.index] = worker.results[index]!
        }
      }))
    } else {
      for (const item of pending) {
        analyses[item.index] = analyzeDoctorSourceTask(item.task)
      }
    }
    workspace.recordParses(pending.length)

    await pMap(pending, async (item) => {
      const analysis = analyses[item.index]!
      workspace.setFact(item.key, item.task.file, analysis)
      await writeVueDoctorCache(
        sourceCacheNamespace,
        item.key,
        JSON.stringify(analysis),
        options.cacheDirectory
      )
    }, { concurrency: 32 })

    for (const analysis of analyses) {
      if (!invalidEncodingFiles.has(analysis.fileResult.file)) continue
      const message = 'Source file contains invalid UTF-8 encoding; analysis evidence is incomplete.'
      const markFailed = (result: DoctorSourceFileAnalysis['fileResult']) => {
        result.blocks = result.blocks.length
          ? result.blocks.map(block => ({ ...block, status: 'failed', message }))
          : failedFileAnalysis(result.file, message).fileResult.blocks
      }
      markFailed(analysis.fileResult)
      for (const fact of analysis.sourceFacts) markFailed(fact.analysis.fileResult)
    }
    const components = analyses.flatMap((analysis) => analysis.components)
    const globalPlugins = analyses.flatMap((analysis) => analysis.globalPlugins)
    const fileResults = analyses.map((analysis) => analysis.fileResult)
    const diagnostics = analyses.flatMap((analysis) => analysis.diagnostics)
    const sourceFacts = analyses.flatMap((analysis) => analysis.sourceFacts)
    const preparedDocuments = new Map<string, PreparedSourceDocument>()
    for (const analysis of analyses) {
      if (analysis.preparedDocument) {
        preparedDocuments.set(analysis.fileResult.file, structuredClone(analysis.preparedDocument))
      }
    }
    return {
      source: {
        root,
        files,
        discoveryIssues: structuredClone(targetFiles.issues),
        components,
        globalPlugins,
        fileResults
      },
      diagnostics,
      cacheHits,
      cacheMisses,
      parallel: usedParallel,
      sourceTexts: new Map(texts),
      invalidEncodingFiles: new Set(invalidEncodingFiles),
      readFailures,
      preparedDocuments,
      sourceFacts
    }
  } finally {
    workspace.recordAnalysisTime(performance.now() - startedAt)
    if (ownsWorkspace) await workspace.close()
  }
}

export function analyzeDoctorSourceTask(task: DoctorSourceTask): DoctorSourceFileAnalysis {
  try {
    const analyzed = analyzeSourceText(task.file, task.source)
    const diagnostics = analyzed.parsed
      ? diagnoseVueSource({
          file: task.file,
          parsed: analyzed.parsed,
          source: task.source,
          vueVersion: task.vueVersion,
          assumeLatestVueVersion: false
        })
      : []
    const sourceFacts = (analyzed.parsed ? normalizeProfiles(task.analysisProfiles ?? []) : []).map((profile) => {
      const enriched = analyzeSourceText(task.file, task.source, profile, analyzed.parsed)
      return {
        file: task.file,
        options: profile,
        analysis: {
          fileResult: enriched.fileResult,
          components: enriched.components,
          globalPlugins: enriched.globalPlugins
        }
      }
    })
    return {
      fileResult: analyzed.fileResult,
      components: analyzed.components,
      globalPlugins: analyzed.globalPlugins,
      diagnostics,
      preparedDocument: analyzed.preparedDocument,
      sourceFacts
    }
  } catch (error) {
    return failedFileAnalysis(task.file, error)
  }
}

async function readSourceCache(
  key: string,
  cacheDirectory: string | undefined
): Promise<DoctorSourceFileAnalysis | undefined> {
  const cached = await readVueDoctorCache(sourceCacheNamespace, key, cacheDirectory)
  if (!cached) return undefined
  try {
    return JSON.parse(cached.toString('utf8')) as DoctorSourceFileAnalysis
  } catch {
    await removeVueDoctorCache(sourceCacheNamespace, key, cacheDirectory)
    return undefined
  }
}

function failedFileAnalysis(file: string, error: unknown): DoctorSourceFileAnalysis {
  return {
    fileResult: {
      file,
      blocks: [{
        kind: file.endsWith('.vue') ? 'template' : 'script',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error)
      }]
    },
    components: [],
    globalPlugins: [],
    diagnostics: [],
    sourceFacts: []
  }
}

function normalizeProfiles(
  profiles: readonly AnalyzeSourceTextOptions[]
): AnalyzeSourceTextOptions[] {
  const unique = new Map<string, AnalyzeSourceTextOptions>()
  for (const profile of profiles) {
    const normalized = {
      ...(profile.includeNativeElements ? { includeNativeElements: true } : {}),
      ...(profile.resolveConstants ? { resolveConstants: true } : {})
    }
    unique.set(JSON.stringify(normalized), normalized)
  }
  return [...unique.values()].sort((left, right) => (
    serializeProfiles([left]) < serializeProfiles([right]) ? -1 : 1
  ))
}

function serializeProfiles(profiles: readonly AnalyzeSourceTextOptions[] | undefined): string {
  return JSON.stringify(normalizeProfiles(profiles ?? []))
}

function versionForFile(
  options: {
    vueVersion?: string
    vueVersions?: Readonly<Record<string, string | undefined>>
  },
  file: string
): string | undefined {
  return options.vueVersions && Object.prototype.hasOwnProperty.call(options.vueVersions, file)
    ? options.vueVersions[file]
    : options.vueVersion
}

function parallelThreshold(): number {
  const configured = Number(process.env.VUE_DOCTOR_PARALLEL_THRESHOLD)
  return Number.isInteger(configured) && configured >= 1
    ? configured
    : defaultParallelThreshold
}

function parallelMinBytes(): number {
  const configured = Number(process.env.VUE_DOCTOR_PARALLEL_MIN_BYTES)
  return Number.isInteger(configured) && configured >= 1
    ? configured
    : defaultParallelMinBytes
}

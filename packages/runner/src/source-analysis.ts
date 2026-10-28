import { extname, resolve } from 'node:path'
import {
  createVueDoctorCacheKey,
  isDiagnosticPrimaryLocation,
  isDoctorDiagnosticDomain,
  readVueDoctorCache,
  removeVueDoctorCache,
  writeVueDoctorCache,
  type Diagnostic,
  type DoctorRunOptions
} from '@daguanren21/vue-doctor-core'
import { diagnoseVueSource } from '@daguanren21/vue-doctor-rule-pack-vue'
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
} from '@daguanren21/vue-doctor-source'
import pMap from 'p-map'
import {
  DoctorSourceWorkspace,
  type SourceTextFact
} from './source-workspace.js'

const sourceCacheNamespace = 'source-v37'
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
      const onDisk = await readSourceCache(key, file, options.cacheDirectory)
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
  file: string,
  cacheDirectory: string | undefined
): Promise<DoctorSourceFileAnalysis | undefined> {
  const cached = await readVueDoctorCache(sourceCacheNamespace, key, cacheDirectory)
  if (!cached) return undefined
  let value: unknown
  try {
    value = JSON.parse(cached.toString('utf8'))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  if (isSourceFileAnalysis(value, file)) return value
  await removeVueDoctorCache(sourceCacheNamespace, key, cacheDirectory)
  return undefined
}

function isSourceFileAnalysis(value: unknown, file: string): value is DoctorSourceFileAnalysis {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const analysis = value as DoctorSourceFileAnalysis
  return isSourceUsageAnalysis(analysis, file)
    && Array.isArray(analysis.diagnostics) && analysis.diagnostics.every(isCachedDiagnostic)
    && optional(analysis.preparedDocument, document => isPreparedDocument(document, file))
    && Array.isArray(analysis.sourceFacts) && analysis.sourceFacts.every(fact => isSourceFact(fact, file))
}

function isSourceFact(value: unknown, file: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const fact = value as SourceAnalysisFact
  return fact.file === file && typeof fact.options === 'object' && fact.options !== null && !Array.isArray(fact.options)
    && optional(fact.options.includeNativeElements, isBoolean) && optional(fact.options.resolveConstants, isBoolean)
    && isSourceUsageAnalysis(fact.analysis, file)
}

function isSourceUsageAnalysis(value: unknown, file: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const analysis = value as SourceAnalysisFact['analysis']
  return isSourceFileResult(analysis.fileResult, file)
    && Array.isArray(analysis.components) && analysis.components.every(component => isComponentUsage(component, file))
    && Array.isArray(analysis.globalPlugins) && analysis.globalPlugins.every(plugin => isGlobalPlugin(plugin, file))
}

function isSourceFileResult(value: unknown, file: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as VueSourceFileResult
  return result.file === file && Array.isArray(result.blocks) && result.blocks.every(block => (
    typeof block === 'object' && block !== null && !Array.isArray(block)
    && isSourceBlockKind(block.kind)
    && (block.status === 'available' || block.status === 'absent' || block.status === 'failed')
    && optional(block.lang, isString) && optional(block.message, isString)
  ))
}

function isComponentUsage(value: unknown, file: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const usage = value as VueComponentUsage
  return usage.file === file && isString(usage.tag) && isString(usage.componentName)
    && optional(usage.applicationId, isString) && isLocation(usage.loc) && optional(usage.parent, isLocation)
    && optional(usage.childContent, content => content === 'text' || content === 'graphic-only' || content === 'empty' || content === 'unknown')
    && Array.isArray(usage.props) && usage.props.every(isPropUsage)
    && Array.isArray(usage.propSpreads) && usage.propSpreads.every(spread => (
      typeof spread === 'object' && spread !== null && !Array.isArray(spread)
      && optional(spread.expression, isString) && isLocation(spread.loc)
    ))
    && Array.isArray(usage.events) && usage.events.every(event => isNamedUsage(event)
      && isStringArray(event.modifiers) && optional(event.handler, isEventHandler))
    && Array.isArray(usage.models) && usage.models.every(model => (
      typeof model === 'object' && model !== null && !Array.isArray(model)
      && optional(model.argument, isString) && optional(model.expression, isString)
      && isStringArray(model.modifiers) && isLocation(model.loc)
    ))
    && Array.isArray(usage.slots) && usage.slots.every(isNamedUsage)
    && Array.isArray(usage.directives) && usage.directives.every(directive => isNamedUsage(directive)
      && optional(directive.argument, isString) && isStringArray(directive.modifiers)
      && optional(directive.staticEvidence, isStaticKnowledge))
    && optional(usage.origin, isComponentOrigin)
}

function isPropUsage(value: unknown): boolean {
  if (!isNamedUsage(value)) return false
  const prop = value as VueComponentUsage['props'][number]
  return (prop.kind === 'static' || prop.kind === 'dynamic' || prop.kind === 'boolean')
    && optional(prop.value, isString) && optional(prop.staticValue, isStaticValue)
    && optional(prop.staticEvidence, isStaticKnowledge)
}

function isNamedUsage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const usage = value as VueComponentUsage['slots'][number]
  return isString(usage.name) && optional(usage.expression, isString) && isLocation(usage.loc)
}

function isEventHandler(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const handler = value as NonNullable<VueComponentUsage['events'][number]['handler']>
  return (handler.kind === 'inline' || handler.kind === 'reference')
    && isStringArray(handler.parameters) && optional(handler.minArity, isCount)
    && optional(handler.maxArity, arity => arity === null || isCount(arity))
    && optional(handler.payloadUsage, usage => usage === 'ignored' || usage === 'unknown')
}

function isComponentOrigin(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const origin = value as NonNullable<VueComponentUsage['origin']>
  return (origin.kind === 'direct-import' || origin.kind === 'local-import' || origin.kind === 'global-plugin' || origin.kind === 'unique-contract-match')
    && optional(origin.package, isPackageReference) && optional(origin.importedName, isString)
    && optional(origin.importSource, isString)
    && (origin.templateBinding === undefined || origin.templateBinding === 'script-setup' || origin.templateBinding === 'components-option')
}

function isGlobalPlugin(value: unknown, file: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const plugin = value as VueGlobalPluginUsage
  return plugin.file === file && isPackageReference(plugin.package) && isString(plugin.localName)
    && optional(plugin.applicationId, isString)
}

function isPackageReference(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const reference = value as VueGlobalPluginUsage['package']
  return isString(reference.specifier) && isString(reference.packageName) && optional(reference.subpath, isString)
}

function isStaticValue(value: unknown, depth = 0): boolean {
  if (depth > 128) return false
  if (value === null || isString(value) || isBoolean(value)) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => isStaticValue(item, depth + 1))
  return typeof value === 'object' && Object.values(value).every(item => isStaticValue(item, depth + 1))
}

function isStaticKnowledge(value: unknown, depth = 0): boolean {
  if (depth > 128 || typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const knowledge = value as NonNullable<VueComponentUsage['props'][number]['staticEvidence']>
  return isBoolean(knowledge.complete)
    && optional(knowledge.value, item => isStaticValue(item, depth + 1))
    && optional(knowledge.properties, properties => typeof properties === 'object'
      && properties !== null && !Array.isArray(properties)
      && Object.values(properties).every(item => isStaticKnowledge(item, depth + 1)))
    && optional(knowledge.elements, elements => Array.isArray(elements)
      && elements.every(item => isStaticKnowledge(item, depth + 1)))
}

function isPreparedDocument(value: unknown, file: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const document = value as PreparedSourceDocument
  return document.file === file && isString(document.language)
    && optional(document.textUnavailable, reason => reason === 'read-failed' || reason === 'invalid-encoding')
    && Array.isArray(document.blocks) && document.blocks.every(block => (
      typeof block === 'object' && block !== null && !Array.isArray(block)
      && (block.kind === 'template' || block.kind === 'script' || block.kind === 'style' || block.kind === 'document')
      && isString(block.lang) && isString(block.content) && isLocation(block.loc)
      && isCount(block.start) && isCount(block.end) && block.end >= block.start
      && typeof block.attributes === 'object' && block.attributes !== null && !Array.isArray(block.attributes)
      && Object.values(block.attributes).every(attribute => isString(attribute) || isBoolean(attribute))
    ))
    && Array.isArray(document.errors) && document.errors.every(isSourceError)
    && optional(document.structuralFailures, failures => Array.isArray(failures)
      && failures.every(failure => isSourceError(failure) && optional(failure.block, isSourceBlockKind)))
}

function isSourceError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const error = value as SourceDocument['errors'][number]
  return isString(error.message) && optional(error.line, isCount) && optional(error.column, isCount)
}

function isCachedDiagnostic(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const diagnostic = value as Diagnostic
  return isString(diagnostic.code) && isString(diagnostic.message)
    && (diagnostic.severity === 'info' || diagnostic.severity === 'warning' || diagnostic.severity === 'error')
    && (diagnostic.confidence === 'low' || diagnostic.confidence === 'medium' || diagnostic.confidence === 'high')
    && optional(diagnostic.id, isString) && optional(diagnostic.file, isString) && optional(diagnostic.rulePack, isString)
    && optional(diagnostic.domain, isDoctorDiagnosticDomain) && optional(diagnostic.tags, isStringArray)
    && Array.isArray(diagnostic.evidence) && diagnostic.evidence.every(isDiagnosticEvidence)
    && Array.isArray(diagnostic.fixes) && diagnostic.fixes.every(fix => (
      typeof fix === 'object' && fix !== null && !Array.isArray(fix)
      && isString(fix.title) && optional(fix.description, isString) && optional(fix.kind, kind => kind === 'suggestion')
    ))
    && optional(diagnostic.primaryLocation, isDiagnosticPrimaryLocation)
    && optional(diagnostic.edits, edits => Array.isArray(edits) && edits.every(edit => (
      typeof edit === 'object' && edit !== null && !Array.isArray(edit)
      && isString(edit.file) && isString(edit.newText) && isLocation(edit.start) && isLocation(edit.end)
      && (edit.end.line > edit.start.line || (edit.end.line === edit.start.line && edit.end.column >= edit.start.column))
    )))
}

function isDiagnosticEvidence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const evidence = value as Diagnostic['evidence'][number]
  return isString(evidence.kind) && optional(evidence.file, isString) && optional(evidence.message, isString)
    && optional(evidence.line, isCount) && optional(evidence.column, isCount)
    && optional(evidence.endLine, isCount) && optional(evidence.endColumn, isCount)
    && optional(evidence.git, git => {
      if (typeof git !== 'object' || git === null || Array.isArray(git)) return false
      const attribution = git as NonNullable<Diagnostic['evidence'][number]['git']>
      return isString(attribution.commit) && isString(attribution.authorName)
        && optional(attribution.authoredAt, isString) && optional(attribution.summary, isString)
        && optional(attribution.uncommitted, isBoolean)
    })
}

function isSourceBlockKind(value: unknown): boolean {
  return value === 'template' || value === 'script' || value === 'script-setup'
}

function isLocation(value: unknown): value is { line: number; column: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return 'line' in value && isCount(value.line) && value.line >= 1
    && 'column' in value && isCount(value.column) && value.column >= 1
}

function optional(value: unknown, predicate: (value: unknown) => boolean): boolean {
  return value === undefined || predicate(value)
}

function isString(value: unknown): value is string { return typeof value === 'string' }
function isBoolean(value: unknown): value is boolean { return typeof value === 'boolean' }
function isCount(value: unknown): value is number { return Number.isInteger(value) && Number(value) >= 0 }
function isStringArray(value: unknown): boolean { return Array.isArray(value) && value.every(isString) }

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

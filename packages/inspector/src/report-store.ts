import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type {
  Diagnostic,
  DoctorReport,
  DoctorRuleCheck,
  DoctorRuleDefinition,
  DoctorSuppressionAudit
} from '@vue-doctor/core'
import { isSupportedDoctorReport } from '@vue-doctor/core'
import { resolveSourceFileWithinRoot } from './editor.js'
import {
  assertExportReportRequest,
  assertGetFindingRequest,
  assertGetAuditRequest,
  assertGetSnippetRequest,
  assertOpenEditorRequest,
  assertQueryAuditRequest,
  assertQueryCoverageRequest,
  assertQueryFindingsRequest,
  assertQueryRulesRequest,
  assertRunInspectorRequest,
  InspectorProtocolError,
  VUE_DOCTOR_DEVFRAME_ID,
  VUE_DOCTOR_PROTOCOL_VERSION
} from './protocol.js'
import type {
  ExportReportRequest,
  ExportReportResult,
  GetFindingRequest,
  GetAuditRequest,
  GetSnippetRequest,
  InspectorActionResult,
  InspectorAuditItem,
  InspectorCoverageCategory,
  InspectorCoverageItem,
  InspectorCoverageResult,
  InspectorFindingDetail,
  InspectorFindingSummary,
  InspectorPage,
  InspectorRuleItem,
  InspectorSharedState,
  InspectorSnapshot,
  InspectorSnippet,
  OpenEditorRequest,
  QueryAuditRequest,
  QueryCoverageRequest,
  QueryFindingsRequest,
  QueryRulesRequest,
  RunInspectorRequest,
  RunInspectorResult
} from './protocol.js'

type Awaitable<T> = T | Promise<T>
const inspectorFacetLimit = 200

export interface InspectorSourceService {
  getSnippet?: (request: {
    root: string
    file: string
    line: number
    contextLines: number
  }) => Awaitable<Omit<InspectorSnippet, 'snapshotId' | 'findingId'>>
  openEditor?: (request: {
    root: string
    file: string
    line: number
    column: number
    editor: NonNullable<OpenEditorRequest['editor']>
  }) => Awaitable<void>
}

export interface InspectorReportStoreOptions {
  initialReport: DoctorReport
  /** Reads the host's latest completed report after a rerun. */
  getReport?: () => Awaitable<DoctorReport>
  /** Starts a host-owned scan. The caller retains ownership of sessions and watchers. */
  run?: () => Awaitable<void | DoctorReport>
  source?: InspectorSourceService
  now?: () => Date
}

interface FindingRecord {
  id: string
  diagnostic: Diagnostic
  summary: InspectorFindingSummary
}

interface FindingIndexes {
  severity: Map<string, number[]>
  confidence: Map<string, number[]>
  domain: Map<string, number[]>
  rule: Map<string, number[]>
  package: Map<string, number[]>
  source: Map<string, number[]>
  file: Map<string, number[]>
  suggestions: Set<number>
  search: string[]
}

interface SnapshotData {
  id: string
  createdAt: string
  report: Readonly<DoctorReport>
  findings: FindingRecord[]
  findingById: Map<string, FindingRecord>
  findingIndexes: FindingIndexes
  coverage: InspectorCoverageItem[]
  rules: InspectorRuleItem[]
  audit: InspectorAuditItem[]
}

export interface InspectorScanDiffFinding {
  id: string
  ruleCode: string
  severity: InspectorFindingSummary['severity']
  message: string
  file?: string
  line?: number
  column?: number
  truncatedFields: string[]
}

export interface InspectorScanDiff {
  beforeSnapshotId: string
  afterSnapshotId: string
  createdAt: string
  coverage: {
    before: DoctorReport['coverage']['status']
    after: DoctorReport['coverage']['status']
    changed: boolean
    beforeFacts: InspectorScanCoverageFacts
    afterFacts: InspectorScanCoverageFacts
  }
  suppressed: {
    before: number
    after: number
    delta: number
  }
  requiredSkipped: {
    before: number
    after: number
    delta: number
  }
  findings: {
    before: number
    after: number
    delta: number
    added: number
    removed: number
    changed: number
    sampleLimit: number
    samples: {
      added: InspectorScanDiffFinding[]
      removed: InspectorScanDiffFinding[]
      changed: InspectorScanDiffFinding[]
    }
    sampleTruncated: {
      added: boolean
      removed: boolean
      changed: boolean
    }
  }
}

export interface InspectorScanCoverageFacts {
  scannedFiles: number
  failedFiles: number
  discoveryIssues: number
  contextIssues: number
  incompleteLibraries: number
  skippedChecks: number
  notCoveredDomains: number
}

export class InspectorReportStore {
  private readonly getLatestReport?: InspectorReportStoreOptions['getReport']
  private readonly runReport?: InspectorReportStoreOptions['run']
  private readonly source?: InspectorSourceService
  private readonly now: () => Date
  private readonly listeners = new Set<(state: InspectorSharedState) => void>()
  private snapshot: SnapshotData
  private revision = 1
  private runStatus: InspectorSharedState['status'] = 'idle'
  private runError?: string
  private runStartedAt?: string
  private inFlight?: Promise<RunInspectorResult>
  private lastScanDiff?: InspectorScanDiff
  private closed = false

  constructor(options: InspectorReportStoreOptions) {
    this.getLatestReport = options.getReport
    this.runReport = options.run
    this.source = options.source
    this.now = options.now ?? (() => new Date())
    this.snapshot = createSnapshot(options.initialReport, this.now())
  }

  getSharedState(): InspectorSharedState {
    this.assertOpen()
    return {
      namespace: VUE_DOCTOR_DEVFRAME_ID,
      protocolVersion: VUE_DOCTOR_PROTOCOL_VERSION,
      revision: this.revision,
      snapshotId: this.snapshot.id,
      status: this.runStatus,
      ...(this.runError ? { error: this.runError } : {})
    }
  }

  onStateChange(listener: (state: InspectorSharedState) => void): () => void {
    this.assertOpen()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): InspectorSnapshot {
    this.assertOpen()
    const report = this.snapshot.report
    const { findingIndexes } = this.snapshot
    const severities = facetResult(findingIndexes.severity)
    const domains = facetResult(findingIndexes.domain)
    const rules = facetResult(findingIndexes.rule)
    const packages = facetResult(findingIndexes.package)
    const sources = facetResult(findingIndexes.source)
    return {
      snapshotId: this.snapshot.id,
      revision: this.revision,
      createdAt: this.snapshot.createdAt,
      project: {
        name: basename(report.project.root) || 'project',
        root: report.project.root,
        vueFramework: report.project.vueFramework,
        ...(report.project.vueVersion ? { vueVersion: report.project.vueVersion } : {}),
        ...(report.project.viteVersion ? { viteVersion: report.project.viteVersion } : {})
      },
      coverageStatus: report.coverage.status,
      counts: {
        findings: this.snapshot.findings.length,
        suppressed: this.snapshot.audit.filter(item => item.status === 'applied').reduce((total, item) => total + item.diagnosticTotal, 0),
        errors: findingIndexes.severity.get('error')?.length ?? 0,
        warnings: findingIndexes.severity.get('warning')?.length ?? 0,
        info: findingIndexes.severity.get('info')?.length ?? 0
      },
      facets: {
        severities: severities.items,
        domains: domains.items,
        rules: rules.items,
        packages: packages.items,
        sources: sources.items
      },
      facetLimit: inspectorFacetLimit,
      facetTruncated: {
        severities: severities.truncated,
        domains: domains.truncated,
        rules: rules.truncated,
        packages: packages.truncated,
        sources: sources.truncated
      },
      run: {
        status: this.runStatus,
        ...(this.runError ? { message: this.runError } : {}),
        ...(this.runStartedAt ? { startedAt: this.runStartedAt } : {})
      }
    }
  }

  getLastScanDiff(): InspectorScanDiff | undefined {
    this.assertOpen()
    return this.lastScanDiff ? structuredClone(this.lastScanDiff) : undefined
  }

  queryFindings(request: QueryFindingsRequest): InspectorPage<InspectorFindingSummary> {
    this.assertOpen()
    assertQueryFindingsRequest(request)
    this.assertCurrent(request.snapshotId)
    const query = normalizedQuery(request.query)
    const severities = asSet(request.severity)
    const confidence = asSet(request.confidence)
    const indexes = this.snapshot.findingIndexes
    const candidateGroups = [
      indexedUnion(indexes.severity, severities),
      indexedUnion(indexes.confidence, confidence),
      indexedValue(indexes.domain, request.domain),
      indexedValue(indexes.rule, request.rule),
      indexedValue(indexes.package, request.package),
      indexedValue(indexes.source, request.source),
      indexedValue(indexes.file, request.file)
    ].filter((group): group is readonly number[] => group !== undefined)
    const candidates = candidateGroups.length > 0
      ? [...candidateGroups.reduce((smallest, group) => group.length < smallest.length ? group : smallest)]
      : this.snapshot.findings.map((_, index) => index)
    const filtered = candidates.filter((index) => {
      const summary = this.snapshot.findings[index]!.summary
      if (severities && !severities.has(summary.severity)) return false
      if (confidence && !confidence.has(summary.confidence)) return false
      if (request.domain && summary.domain !== request.domain) return false
      if (request.rule && summary.ruleCode !== request.rule) return false
      if (request.package && summary.package !== request.package) return false
      if (request.source && summary.source !== request.source) return false
      if (request.file && summary.file !== request.file) return false
      if (request.includeSuggestions === false && indexes.suggestions.has(index)) return false
      return !query || indexes.search[index]!.includes(query)
    }).map(index => this.snapshot.findings[index]!.summary)
    return page(this.snapshot.id, filtered, request)
  }

  getFinding(request: GetFindingRequest): InspectorFindingDetail {
    this.assertOpen()
    assertGetFindingRequest(request)
    this.assertCurrent(request.snapshotId)
    const record = this.getFindingRecord(request.id)
    const diagnostic = record.diagnostic
    const evidenceOffset = request.evidenceOffset ?? 0
    const evidenceLimit = request.evidenceLimit ?? 20
    return {
      ...record.summary,
      snapshotId: this.snapshot.id,
      evidence: diagnostic.evidence.slice(evidenceOffset, evidenceOffset + evidenceLimit).map(item => ({ ...item, ...(item.git ? { git: { ...item.git } } : {}) })),
      evidenceOffset,
      evidenceLimit,
      evidenceTotal: diagnostic.evidence.length,
      suggestions: diagnostic.fixes.map(item => ({ title: item.title, ...(item.description ? { description: item.description } : {}) })),
      tags: [...(diagnostic.tags ?? [])],
      ...(diagnostic.primaryLocation ? { location: cloneLocation(diagnostic.primaryLocation) } : {}),
      edits: (diagnostic.edits ?? []).map(edit => ({
        file: edit.file,
        start: { ...edit.start },
        end: { ...edit.end },
        newText: edit.newText
      }))
    }
  }

  getCoverage(request: QueryCoverageRequest): InspectorCoverageResult {
    this.assertOpen()
    assertQueryCoverageRequest(request)
    this.assertCurrent(request.snapshotId)
    const query = normalizedQuery(request.query)
    const filtered = this.snapshot.coverage.filter(item => {
      if (request.category && item.category !== request.category) return false
      if (request.status && item.status !== request.status) return false
      return matchesQuery(query, item.title, item.message, item.file, item.ruleCode, item.package, item.reasonCode)
    })
    const result = page(this.snapshot.id, filtered, request)
    return {
      ...result,
      summary: [...countValues(this.snapshot.coverage.map(item => item.category))]
        .map(([category, count]) => ({ category: category as InspectorCoverageCategory, count }))
        .sort((left, right) => compareText(left.category, right.category))
    }
  }

  queryRules(request: QueryRulesRequest): InspectorPage<InspectorRuleItem> {
    this.assertOpen()
    assertQueryRulesRequest(request)
    this.assertCurrent(request.snapshotId)
    const query = normalizedQuery(request.query)
    const filtered = this.snapshot.rules.filter(item => {
      if (request.status && item.status !== request.status) return false
      if (request.pack && item.pack !== request.pack) return false
      return matchesQuery(query, item.code, item.name, item.pack, item.summary, item.skipReason, ...item.tags, ...item.standards)
    })
    return page(this.snapshot.id, filtered, request)
  }

  queryAudit(request: QueryAuditRequest): InspectorPage<InspectorAuditItem> {
    this.assertOpen()
    assertQueryAuditRequest(request)
    this.assertCurrent(request.snapshotId)
    const query = normalizedQuery(request.query)
    const filtered = this.snapshot.audit.filter((item, index) => {
      if (request.status && item.status !== request.status) return false
      if (request.rule && item.ruleCode !== request.rule) return false
      return !query || matchesQuery(query, item.ruleCode, item.reason, item.message, item.directive.file, item.directive.text)
        || this.snapshot.report.suppressionAudit?.[index]?.diagnostics.some(diagnostic => matchesQuery(query, diagnostic.message, diagnosticLocation(diagnostic)?.file)) === true
    })
    return page(this.snapshot.id, filtered, request)
  }

  getAudit(request: GetAuditRequest): InspectorAuditItem {
    this.assertOpen()
    assertGetAuditRequest(request)
    this.assertCurrent(request.snapshotId)
    const index = this.snapshot.audit.findIndex(item => item.id === request.id)
    if (index < 0) throw new InspectorProtocolError('not-found', 'The audit directive was not found in this snapshot.')
    const item = this.snapshot.audit[index]!
    const diagnosticOffset = request.diagnosticOffset ?? 0
    const diagnosticLimit = request.diagnosticLimit ?? 20
    return {
      ...item, diagnosticOffset, diagnosticLimit,
      diagnostics: this.snapshot.report.suppressionAudit![index]!.diagnostics
        .slice(diagnosticOffset, diagnosticOffset + diagnosticLimit)
        .map((diagnostic, offset) => auditDiagnostic(diagnostic, index, diagnosticOffset + offset))
    }
  }

  /** Explicit export-only access to the complete immutable report. */
  getReport(snapshotId: string): Readonly<DoctorReport> {
    this.assertOpen()
    this.assertCurrent(snapshotId)
    return this.snapshot.report
  }

  exportReport(request: ExportReportRequest): ExportReportResult {
    this.assertOpen()
    assertExportReportRequest(request)
    this.assertCurrent(request.snapshotId)
    return {
      snapshotId: this.snapshot.id,
      format: 'json',
      contentType: 'application/json; charset=utf-8',
      content: `${JSON.stringify(this.snapshot.report, null, 2)}\n`
    }
  }

  run(request?: RunInspectorRequest): Promise<RunInspectorResult> {
    if (this.closed) return Promise.reject(new InspectorProtocolError('closed', 'The Inspector report store is closed.'))
    assertRunInspectorRequest(request)
    if (request?.snapshotId) this.assertCurrent(request.snapshotId)
    if (!this.runReport && !this.getLatestReport) {
      return Promise.reject(new InspectorProtocolError('run-unavailable', 'This Inspector host does not provide a rerun action.'))
    }
    if (this.inFlight) return this.inFlight.then(result => ({ ...result, accepted: false }))

    this.runStatus = 'running'
    this.runError = undefined
    this.runStartedAt = this.now().toISOString()
    this.bump()
    const task = this.performRun()
    this.inFlight = task
    void task.finally(() => {
      if (this.inFlight === task) this.inFlight = undefined
    }).catch(() => {})
    return task
  }

  async getSnippet(request: GetSnippetRequest): Promise<InspectorSnippet> {
    this.assertOpen()
    assertGetSnippetRequest(request)
    this.assertCurrent(request.snapshotId)
    const snapshot = this.snapshot
    const record = this.getFindingRecord(request.id, snapshot)
    const location = diagnosticLocation(record.diagnostic)
    if (!location) throw new InspectorProtocolError('source-unavailable', 'This finding has no source location.')
    const root = snapshot.report.project.root
    const file = await resolveSourceFileWithinRoot(root, location.file)
    const line = Math.max(1, location.line ?? 1)
    const contextLines = request.contextLines ?? 3
    const snippet = this.source?.getSnippet
      ? await this.source.getSnippet({ root, file, line, contextLines })
      : await readSnippet(file, line, contextLines)
    this.assertOpen()
    this.assertCurrent(request.snapshotId)
    return { ...snippet, snapshotId: request.snapshotId, findingId: record.id }
  }

  async openEditor(request: OpenEditorRequest): Promise<InspectorActionResult> {
    this.assertOpen()
    assertOpenEditorRequest(request)
    this.assertCurrent(request.snapshotId)
    const snapshot = this.snapshot
    const record = this.getFindingRecord(request.id, snapshot)
    const location = diagnosticLocation(record.diagnostic)
    if (!location) throw new InspectorProtocolError('source-unavailable', 'This finding has no source location.')
    if (!this.source?.openEditor) throw new InspectorProtocolError('source-unavailable', 'This Inspector host cannot open an editor.')
    const root = snapshot.report.project.root
    const file = await resolveSourceFileWithinRoot(root, location.file)
    this.assertOpen()
    this.assertCurrent(request.snapshotId)
    await this.source.openEditor({
      root,
      file,
      line: Math.max(1, location.line ?? 1),
      column: Math.max(1, location.column ?? 1),
      editor: request.editor ?? 'vscode'
    })
    // A completed launch must not be reported as failed when the report changes meanwhile.
    return { snapshotId: request.snapshotId, ok: true }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
  }

  private async performRun(): Promise<RunInspectorResult> {
    try {
      const result = await this.runReport?.()
      const report = result ?? await this.getLatestReport?.()
      this.assertOpen()
      if (!report) throw new InspectorProtocolError('run-failed', 'The Inspector host completed the run without a report.')
      if (report.project.root !== this.snapshot.report.project.root || report.inventory.root !== this.snapshot.report.inventory.root) {
        throw new InspectorProtocolError('run-failed', 'Inspector report project root changed.')
      }
      const before = this.snapshot
      const after = createSnapshot(report, this.now())
      const diff = createScanDiff(before, after)
      this.snapshot = after
      this.lastScanDiff = diff
      this.runStatus = 'idle'
      this.runError = undefined
      this.runStartedAt = undefined
      this.bump()
      return { accepted: true, revision: this.revision, snapshotId: this.snapshot.id }
    } catch (cause) {
      this.runStatus = 'error'
      this.runError = cause instanceof Error ? cause.message : String(cause)
      this.runStartedAt = undefined
      this.bump()
      if (cause instanceof InspectorProtocolError) throw cause
      throw new InspectorProtocolError('run-failed', this.runError)
    }
  }

  private getFindingRecord(id: string, snapshot: SnapshotData = this.snapshot): FindingRecord {
    const finding = snapshot.findingById.get(id)
    if (!finding) throw new InspectorProtocolError('not-found', `Finding was not found: ${id}.`, { id })
    return finding
  }

  private assertCurrent(snapshotId: string): void {
    if (snapshotId !== this.snapshot.id) {
      throw new InspectorProtocolError('stale-snapshot', 'The report changed. Refresh the Inspector snapshot and retry.', {
        requestedSnapshotId: snapshotId,
        currentSnapshotId: this.snapshot.id
      })
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new InspectorProtocolError('closed', 'The Inspector report store is closed.')
  }

  private bump(): void {
    if (this.closed) return
    this.revision++
    const state = this.getSharedState()
    for (const listener of this.listeners) {
      // Transport observers cannot cancel a scan or corrupt another mount's update.
      try {
        const result: unknown = listener({ ...state })
        if (result instanceof Promise) void result.catch(() => {})
      } catch { /* An independently mounted transport may already be closed. */ }
    }
  }
}

const scanDiffSampleLimit = 10
const scanDiffTextLimit = 512

function createScanDiff(before: SnapshotData, after: SnapshotData): InspectorScanDiff {
  const beforeById = before.findingById
  const afterById = after.findingById
  const added: FindingRecord[] = []
  const removed: FindingRecord[] = []
  const changed: FindingRecord[] = []

  for (const [id, record] of afterById) {
    const previous = beforeById.get(id)
    if (!previous) added.push(record)
    else if (shortHash(previous.diagnostic) !== shortHash(record.diagnostic)) changed.push(record)
  }
  for (const [id, record] of beforeById) if (!afterById.has(id)) removed.push(record)

  const beforeSuppressed = suppressedCount(before)
  const afterSuppressed = suppressedCount(after)
  const beforeRequiredSkipped = requiredSkippedCount(before)
  const afterRequiredSkipped = requiredSkippedCount(after)

  return deepFreeze({
    beforeSnapshotId: before.id,
    afterSnapshotId: after.id,
    createdAt: after.createdAt,
    coverage: {
      before: before.report.coverage.status,
      after: after.report.coverage.status,
      changed: before.report.coverage.status !== after.report.coverage.status,
      beforeFacts: coverageFacts(before),
      afterFacts: coverageFacts(after)
    },
    suppressed: {
      before: beforeSuppressed,
      after: afterSuppressed,
      delta: afterSuppressed - beforeSuppressed
    },
    requiredSkipped: {
      before: beforeRequiredSkipped,
      after: afterRequiredSkipped,
      delta: afterRequiredSkipped - beforeRequiredSkipped
    },
    findings: {
      before: before.findings.length,
      after: after.findings.length,
      delta: after.findings.length - before.findings.length,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      sampleLimit: scanDiffSampleLimit,
      samples: {
        added: diffSamples(added),
        removed: diffSamples(removed),
        changed: diffSamples(changed)
      },
      sampleTruncated: {
        added: added.length > scanDiffSampleLimit,
        removed: removed.length > scanDiffSampleLimit,
        changed: changed.length > scanDiffSampleLimit
      }
    }
  })
}

function suppressedCount(snapshot: SnapshotData): number {
  return snapshot.audit
    .filter(item => item.status === 'applied')
    .reduce((total, item) => total + item.diagnosticTotal, 0)
}

function requiredSkippedCount(snapshot: SnapshotData): number {
  return (snapshot.report.skippedChecks ?? []).filter(item => item.required).length
}

function coverageFacts(snapshot: SnapshotData): InspectorScanCoverageFacts {
  const report = snapshot.report
  return {
    scannedFiles: report.coverage.source.scannedFileCount,
    failedFiles: report.coverage.source.failedFiles.length,
    discoveryIssues: report.coverage.source.discoveryIssues?.length ?? 0,
    contextIssues: report.coverage.source.contextIssues?.length ?? 0,
    incompleteLibraries: report.coverage.componentLibraries.filter(item => item.status !== 'complete').length,
    skippedChecks: report.skippedChecks?.length ?? 0,
    notCoveredDomains: report.domainCoverage?.filter(item => item.status !== 'complete').length ?? 0
  }
}

function diffSamples(records: readonly FindingRecord[]): InspectorScanDiffFinding[] {
  return records.slice(0, scanDiffSampleLimit).map(({ summary }) => {
    const truncatedFields: string[] = []
    const bounded = (field: string, value: string) => {
      if (value.length <= scanDiffTextLimit) return value
      truncatedFields.push(field)
      return `${value.slice(0, scanDiffTextLimit - 1)}…`
    }
    return {
      id: summary.id,
      ruleCode: bounded('ruleCode', summary.ruleCode),
      severity: summary.severity,
      message: bounded('message', summary.message),
      ...(summary.file ? { file: bounded('file', summary.file) } : {}),
      ...(summary.line ? { line: summary.line } : {}),
      ...(summary.column ? { column: summary.column } : {}),
      truncatedFields
    }
  })
}

function createSnapshot(report: DoctorReport, createdAt: Date): SnapshotData {
  if (!isSupportedDoctorReport(report)) throw new InspectorProtocolError('invalid-request', 'The Inspector received an unsupported Doctor report.')
  const immutable = deepFreeze(structuredClone(report)) as Readonly<DoctorReport>
  const id = snapshotId(immutable)
  const findings = deepFreeze(createFindings(immutable))
  return {
    id,
    createdAt: createdAt.toISOString(),
    report: immutable,
    findings,
    findingById: new Map(findings.map(item => [item.id, item])),
    findingIndexes: createFindingIndexes(findings),
    coverage: deepFreeze(createCoverage(immutable)),
    rules: deepFreeze(createRules(immutable)),
    audit: deepFreeze(createAudit(immutable))
  }
}

function createFindingIndexes(findings: readonly FindingRecord[]): FindingIndexes {
  const indexes: FindingIndexes = {
    severity: new Map(),
    confidence: new Map(),
    domain: new Map(),
    rule: new Map(),
    package: new Map(),
    source: new Map(),
    file: new Map(),
    suggestions: new Set(),
    search: []
  }
  findings.forEach(({ summary }, index) => {
    addIndex(indexes.severity, summary.severity, index)
    addIndex(indexes.confidence, summary.confidence, index)
    addIndex(indexes.rule, summary.ruleCode, index)
    addIndex(indexes.source, summary.source, index)
    if (summary.domain) addIndex(indexes.domain, summary.domain, index)
    if (summary.package) addIndex(indexes.package, summary.package, index)
    if (summary.file) addIndex(indexes.file, summary.file, index)
    if (summary.ruleCode === 'vue-prefer-use-template-ref' || summary.ruleCode === 'vue-prefer-define-model') indexes.suggestions.add(index)
    indexes.search.push([
      summary.ruleCode,
      summary.message,
      summary.file,
      summary.domain,
      summary.rulePack,
      summary.package
    ].filter(Boolean).join('\0').toLocaleLowerCase())
  })
  return indexes
}

function addIndex(index: Map<string, number[]>, value: string, item: number): void {
  const entries = index.get(value)
  if (entries) entries.push(item)
  else index.set(value, [item])
}

function indexedValue(index: Map<string, number[]>, value: string | undefined): readonly number[] | undefined {
  return value === undefined ? undefined : index.get(value) ?? []
}

function indexedUnion<T extends string>(index: Map<string, number[]>, values: Set<T> | undefined): readonly number[] | undefined {
  if (!values) return undefined
  const merged = new Set<number>()
  for (const value of values) for (const item of index.get(value) ?? []) merged.add(item)
  return [...merged].sort((left, right) => left - right)
}

function createFindings(report: Readonly<DoctorReport>): FindingRecord[] {
  const occurrences = new Map<string, number>()
  return report.diagnostics.map((diagnostic) => {
    const baseId = diagnostic.id ?? `legacy:${shortHash(diagnostic)}`
    const occurrence = (occurrences.get(baseId) ?? 0) + 1
    occurrences.set(baseId, occurrence)
    const id = occurrence === 1 ? baseId : `${baseId}#${occurrence}`
    const location = diagnosticLocation(diagnostic)
    const packageName = packageForDiagnostic(report, diagnostic)
    return {
      id,
      diagnostic,
      summary: {
        id,
        ruleCode: diagnostic.code,
        severity: diagnostic.severity,
        confidence: diagnostic.confidence,
        message: diagnostic.message,
        ...(location?.file ? { file: location.file } : {}),
        ...(location?.line ? { line: location.line } : {}),
        ...(location?.column ? { column: location.column } : {}),
        ...(diagnostic.domain ? { domain: diagnostic.domain } : {}),
        ...(diagnostic.rulePack ? { rulePack: diagnostic.rulePack } : {}),
        ...(packageName ? { package: packageName } : {}),
        source: diagnostic.rulePack ?? 'core',
        hasSuggestions: diagnostic.fixes.length > 0
      }
    }
  })
}

function createCoverage(report: Readonly<DoctorReport>): InspectorCoverageItem[] {
  const items: InspectorCoverageItem[] = [{
    id: coverageId('source', report.coverage.source),
    category: 'source',
    status: report.coverage.source.status,
    title: 'Source analysis',
    message: `${report.coverage.source.scannedFileCount} source files were scanned.`,
    count: report.coverage.source.scannedFileCount
  }]
  for (const failure of report.coverage.source.failedFiles) {
    items.push({
      id: coverageId('parse', failure),
      category: 'parse',
      status: report.coverage.source.status === 'blocked' ? 'blocked' : 'partial',
      title: `Could not inspect ${basename(failure.file)}`,
      message: failure.message,
      file: failure.file,
      reasonCode: failure.block
    })
  }
  for (const issue of report.coverage.source.discoveryIssues ?? []) {
    items.push({
      id: coverageId('source', issue),
      category: 'source',
      status: report.coverage.source.status === 'blocked' ? 'blocked' : 'partial',
      title: issue.kind,
      message: issue.message,
      file: issue.path,
      reasonCode: issue.kind
    })
  }
  for (const issue of report.coverage.source.contextIssues ?? []) {
    items.push({
      id: coverageId('context', issue),
      category: 'context',
      status: report.coverage.source.status === 'blocked' ? 'blocked' : 'partial',
      title: issue.code,
      message: issue.message,
      ...(issue.file ? { file: issue.file } : {}),
      reasonCode: issue.code,
      ...(issue.targetFiles ? { count: issue.targetFiles.length } : {})
    })
  }
  for (const library of report.coverage.componentLibraries) {
    items.push({
      id: coverageId('contract', { package: library.package.canonicalName, status: library.status }),
      category: 'contract',
      status: library.status,
      title: library.package.canonicalName,
      message: `${library.matchedUsageCount} of ${library.detectedUsageCount} detected usages have matched ownership.`,
      package: library.package.canonicalName,
      count: library.detectedUsageCount
    })
    for (const problem of library.problems) {
      items.push({
        id: coverageId('contract', { package: library.package.canonicalName, problem }),
        category: 'contract',
        status: library.status,
        title: problem.code,
        message: problem.message,
        package: library.package.canonicalName,
        reasonCode: problem.code
      })
    }
  }
  for (const skipped of report.skippedChecks ?? []) {
    items.push({
      id: coverageId('skipped', skipped),
      category: 'skipped',
      status: 'skipped',
      title: skipped.ruleCode,
      message: skipped.required ? 'A required check was skipped.' : 'An optional check was skipped.',
      ...(skipped.file ? { file: skipped.file } : {}),
      ruleCode: skipped.ruleCode,
      ...(skipped.package ? { package: skipped.package.canonicalName } : {}),
      reasonCode: skipped.reason
    })
  }
  for (const domain of report.domainCoverage ?? []) {
    items.push({
      id: coverageId('domain', domain),
      category: 'domain',
      status: domain.status,
      title: domain.domain,
      message: `${domain.ruleCount} rules, ${domain.diagnosticCount} findings, ${domain.unavailableCheckCount} unavailable checks.`,
      count: domain.ruleCount
    })
  }
  return items.sort((left, right) => compareText(left.category, right.category) || compareText(left.title, right.title) || compareText(left.id, right.id))
}

function createRules(report: Readonly<DoctorReport>): InspectorRuleItem[] {
  const checks = new Map<string, DoctorRuleCheck>()
  for (const check of report.checks ?? []) checks.set(check.ruleCode, check)
  for (const pack of report.rulePacks ?? []) for (const check of pack.checks ?? []) checks.set(check.ruleCode, check)
  const definitions = new Map<string, { rule: DoctorRuleDefinition; pack: string }>()
  for (const catalog of report.ruleCatalogs ?? []) for (const rule of catalog.rules) definitions.set(rule.code, { rule, pack: catalog.name })
  for (const pack of report.rulePacks ?? []) for (const rule of pack.rules) definitions.set(rule.code, { rule, pack: pack.name })
  const codes = new Set([...definitions.keys(), ...checks.keys(), ...(report.skippedChecks ?? []).map(item => item.ruleCode), ...report.diagnostics.map(item => item.code)])
  const findingCounts = countValues(report.diagnostics.map(item => item.code))
  const skippedByCode = new Map((report.skippedChecks ?? []).map(item => [item.ruleCode, item]))
  const diagnosticByCode = new Map<string, Diagnostic>()
  for (const diagnostic of report.diagnostics) if (!diagnosticByCode.has(diagnostic.code)) diagnosticByCode.set(diagnostic.code, diagnostic)
  return [...codes].sort(compareText).map((code) => {
    const definition = definitions.get(code)
    const check = checks.get(code)
    const skip = skippedByCode.get(code)
    const diagnostic = diagnosticByCode.get(code)
    return {
      code,
      name: definition?.rule.title ?? code,
      pack: definition?.pack ?? check?.rulePack ?? diagnostic?.rulePack ?? 'core',
      status: check?.status ?? (skip ? 'unavailable' : 'not-reported'),
      ...(definition?.rule.defaultSeverity ? { severity: definition.rule.defaultSeverity } : diagnostic ? { severity: diagnostic.severity } : {}),
      ...(definition?.rule.description ? { summary: definition.rule.description } : check?.reason ? { summary: check.reason } : {}),
      findingCount: findingCounts.get(code) ?? 0,
      ...(skip ? { skipReason: skip.reason } : check?.reason ? { skipReason: check.reason } : {}),
      ...(definition?.rule.verification ? { verification: definition.rule.verification } : {}),
      tags: [...(definition?.rule.tags ?? [])],
      standards: [...(definition?.rule.standards ?? [])]
    }
  })
}

function createAudit(report: Readonly<DoctorReport>): InspectorAuditItem[] {
  return (report.suppressionAudit ?? []).map((audit, index) => ({
    id: `audit:${shortHash({ audit, index })}`,
    status: audit.status,
    ...(audit.ruleCode ? { ruleCode: audit.ruleCode } : {}),
    ...(audit.reason ? { reason: audit.reason } : {}),
    ...(audit.message ? { message: audit.message } : {}),
    diagnosticTotal: audit.diagnostics.length,
    diagnosticOffset: 0,
    diagnosticLimit: 20,
    directive: {
      file: audit.directive.location.file,
      ...(audit.directive.location.start?.line ? { line: audit.directive.location.start.line } : {}),
      ...(audit.directive.location.start?.column ? { column: audit.directive.location.start.column } : {}),
      text: audit.directive.text,
      ...(audit.directive.mode ? { mode: audit.directive.mode } : {})
    },
    diagnostics: []
  }))
}

function auditDiagnostic(diagnostic: Diagnostic, auditIndex: number, diagnosticIndex: number): InspectorAuditItem['diagnostics'][number] {
  const location = diagnosticLocation(diagnostic)
  return {
    id: diagnostic.id ?? `audit-diagnostic:${shortHash({ diagnostic, auditIndex, diagnosticIndex })}`,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(location?.file ? { file: location.file } : {}),
    ...(location?.line ? { line: location.line } : {}),
    ...(location?.column ? { column: location.column } : {})
  }
}

function packageForDiagnostic(report: Readonly<DoctorReport>, diagnostic: Diagnostic): string | undefined {
  const candidates = report.coverage.componentLibraries.map(item => item.package.canonicalName).sort((left, right) => right.length - left.length)
  return candidates.find(name => diagnostic.message.includes(`${name}@`) || diagnostic.message.includes(` ${name} `))
}

function diagnosticLocation(diagnostic: Diagnostic): { file: string; line?: number; column?: number } | undefined {
  if (diagnostic.primaryLocation) return {
    file: diagnostic.primaryLocation.file,
    ...(diagnostic.primaryLocation.start?.line ? { line: diagnostic.primaryLocation.start.line } : {}),
    ...(diagnostic.primaryLocation.start?.column ? { column: diagnostic.primaryLocation.start.column } : {})
  }
  const evidence = diagnostic.evidence.find(item => item.file)
  if (evidence?.file) return {
    file: evidence.file,
    ...(evidence.line ? { line: evidence.line } : {}),
    ...(evidence.column ? { column: evidence.column } : {})
  }
  return diagnostic.file ? { file: diagnostic.file } : undefined
}

async function readSnippet(file: string, line: number, contextLines: number): Promise<Omit<InspectorSnippet, 'snapshotId' | 'findingId'>> {
  const source = await readFile(file, 'utf8')
  const lines = source.split(/\r?\n/u)
  const highlightLine = Math.min(Math.max(1, line), Math.max(1, lines.length))
  const startLine = Math.max(1, highlightLine - contextLines)
  const endLine = Math.min(lines.length, highlightLine + contextLines)
  return {
    file,
    startLine,
    endLine,
    language: languageForFile(file),
    content: lines.slice(startLine - 1, endLine).join('\n'),
    highlightLine
  }
}

function languageForFile(file: string): string {
  const extension = extname(file).slice(1).toLowerCase()
  if (extension === 'vue') return 'vue'
  if (['ts', 'tsx', 'mts', 'cts'].includes(extension)) return 'typescript'
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) return 'javascript'
  if (['css', 'scss', 'sass'].includes(extension)) return extension
  return extension || 'text'
}

function snapshotId(report: Readonly<DoctorReport>): string {
  return `vds1:${shortHash(report)}`
}

function coverageId(category: InspectorCoverageCategory, value: unknown): string {
  return `coverage:${category}:${shortHash(value)}`
}

function shortHash(value: unknown): string {
  const hash = createHash('sha256')
  updateCanonicalHash(hash, value)
  return hash.digest('hex').slice(0, 32)
}

function updateCanonicalHash(hash: ReturnType<typeof createHash>, value: unknown): void {
  if (value === null) return void hash.update('null;')
  if (value === undefined) return void hash.update('undefined;')
  if (typeof value === 'string') return void hash.update(`string:${JSON.stringify(value)};`)
  if (typeof value === 'number') return void hash.update(`number:${JSON.stringify(value)};`)
  if (typeof value === 'boolean') return void hash.update(`boolean:${value};`)
  if (Array.isArray(value)) {
    hash.update('array[')
    for (const item of value) updateCanonicalHash(hash, item)
    hash.update('];')
    return
  }
  if (typeof value === 'object') {
    hash.update('object{')
    for (const key of Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort(compareText)) {
      hash.update(`${JSON.stringify(key)}:`)
      updateCanonicalHash(hash, (value as Record<string, unknown>)[key])
    }
    hash.update('};')
    return
  }
  throw new InspectorProtocolError('invalid-request', `Report contains a non-JSON value: ${typeof value}.`)
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return value
}

function cloneLocation(location: NonNullable<Diagnostic['primaryLocation']>): NonNullable<InspectorFindingDetail['location']> {
  return {
    file: location.file,
    precision: location.precision,
    ...(location.start ? { start: { ...location.start } } : {}),
    ...(location.end ? { end: { ...location.end } } : {})
  }
}

function page<T>(snapshotId: string, items: T[], request: { offset?: number; limit?: number }): InspectorPage<T> {
  const offset = request.offset ?? 0
  const limit = request.limit ?? 100
  return { snapshotId, offset, limit, total: items.length, items: items.slice(offset, offset + limit) }
}

function normalizedQuery(query?: string): string | undefined {
  const normalized = query?.trim().toLocaleLowerCase()
  return normalized || undefined
}

function matchesQuery(query: string | undefined, ...values: Array<string | undefined>): boolean {
  return !query || values.some(value => value?.toLocaleLowerCase().includes(query))
}

function asSet<T extends string>(value: T | T[] | undefined): Set<T> | undefined {
  return value === undefined ? undefined : new Set(Array.isArray(value) ? value : [value])
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

function facetResult(values: ReadonlyMap<string, readonly unknown[]>): { items: Array<{ value: string; count: number }>; truncated: boolean } {
  const all = [...values].map(([value, entries]) => ({ value, count: entries.length }))
    .sort((left, right) => right.count - left.count || compareText(left.value, right.value))
  return { items: all.slice(0, inspectorFacetLimit), truncated: all.length > inspectorFacetLimit }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

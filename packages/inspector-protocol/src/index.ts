/** Browser-safe Vue Doctor Inspector protocol. This package must remain runtime-neutral. */

export const VUE_DOCTOR_DEVFRAME_ID = 'vue-doctor' as const
export const VUE_DOCTOR_PROTOCOL_VERSION = 1 as const
export const VUE_DOCTOR_SHARED_STATE_KEY = 'state' as const
export const VUE_DOCTOR_RPC_METHODS = {
  getSnapshot: 'getSnapshot',
  queryFindings: 'queryFindings',
  getFinding: 'getFinding',
  getCoverage: 'getCoverage',
  queryRules: 'queryRules',
  queryAudit: 'queryAudit',
  getAudit: 'getAudit',
  exportReport: 'exportReport',
  run: 'run',
  getSnippet: 'getSnippet',
  openEditor: 'openEditor'
} as const

export type InspectorWorkspaceRoute = 'findings' | 'coverage' | 'rules' | 'audit'
export type InspectorSeverity = 'error' | 'warning' | 'info'
export type InspectorConfidence = 'low' | 'medium' | 'high'
export type InspectorCoverageStatus = 'complete' | 'partial' | 'blocked'
export type InspectorRunStatus = 'idle' | 'running' | 'error'

export interface InspectorSharedState {
  namespace: typeof VUE_DOCTOR_DEVFRAME_ID
  protocolVersion: typeof VUE_DOCTOR_PROTOCOL_VERSION
  revision: number
  snapshotId?: string
  status: InspectorRunStatus
  error?: string
}

export interface InspectorCountFacet {
  value: string
  count: number
}

export interface InspectorSnapshot {
  snapshotId: string
  revision: number
  createdAt: string
  project: {
    name: string
    root?: string
    vueFramework: 'vue2.7' | 'vue3' | 'unsupported' | 'unknown'
    vueVersion?: string
    viteVersion?: string
  }
  coverageStatus: InspectorCoverageStatus
  counts: {
    findings: number
    suppressed: number
    errors: number
    warnings: number
    info: number
  }
  facets: {
    severities: InspectorCountFacet[]
    domains: InspectorCountFacet[]
    rules: InspectorCountFacet[]
    packages: InspectorCountFacet[]
    sources: InspectorCountFacet[]
  }
  facetLimit: number
  facetTruncated: {
    severities: boolean
    domains: boolean
    rules: boolean
    packages: boolean
    sources: boolean
  }
  run: {
    status: InspectorRunStatus
    message?: string
    startedAt?: string
  }
}

export interface InspectorPage<T> {
  snapshotId: string
  offset: number
  limit: number
  total: number
  items: T[]
}

export interface InspectorQueryBase {
  snapshotId: string
  offset?: number
  limit?: number
  query?: string
}

export interface QueryFindingsRequest extends InspectorQueryBase {
  severity?: InspectorSeverity | InspectorSeverity[]
  confidence?: InspectorConfidence | InspectorConfidence[]
  domain?: string
  rule?: string
  package?: string
  source?: string
  file?: string
  /** Include optional Vue style suggestions; remediation fixes do not make a finding optional. */
  includeSuggestions?: boolean
}

export interface InspectorFindingSummary {
  id: string
  ruleCode: string
  severity: InspectorSeverity
  confidence: InspectorConfidence
  message: string
  file?: string
  line?: number
  column?: number
  domain?: string
  rulePack?: string
  package?: string
  source: string
  hasSuggestions: boolean
}

export interface InspectorLocation {
  file: string
  precision: 'file' | 'line' | 'point' | 'range'
  start?: { line: number; column?: number }
  end?: { line: number; column?: number }
}

export interface InspectorEvidence {
  kind: string
  file?: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  message?: string
  git?: {
    commit: string
    authorName: string
    authoredAt?: string
    summary?: string
    uncommitted?: boolean
  }
}

export interface InspectorFindingDetail extends InspectorFindingSummary {
  snapshotId: string
  evidence: InspectorEvidence[]
  evidenceOffset: number
  evidenceLimit: number
  evidenceTotal: number
  suggestions: Array<{ title: string; description?: string }>
  tags: string[]
  location?: InspectorLocation
  edits: Array<{
    file: string
    start: { line: number; column: number }
    end: { line: number; column: number }
    newText: string
  }>
}

export interface InspectorFindingRef {
  snapshotId: string
  id: string
}
export interface GetFindingRequest extends InspectorFindingRef {
  evidenceOffset?: number
  evidenceLimit?: number
}

export type InspectorCoverageCategory = 'source' | 'parse' | 'context' | 'contract' | 'skipped' | 'domain'

export interface QueryCoverageRequest extends InspectorQueryBase {
  category?: InspectorCoverageCategory
  status?: InspectorCoverageStatus | 'skipped' | 'not-covered' | 'not-reported'
}

export interface InspectorCoverageItem {
  id: string
  category: InspectorCoverageCategory
  status: InspectorCoverageStatus | 'skipped' | 'not-covered' | 'not-reported'
  title: string
  message: string
  file?: string
  ruleCode?: string
  package?: string
  reasonCode?: string
  count?: number
}

export interface InspectorCoverageResult extends InspectorPage<InspectorCoverageItem> {
  summary: Array<{ category: InspectorCoverageCategory; count: number }>
}

export type InspectorRuleStatus =
  | 'checked'
  | 'partial'
  | 'not-applicable'
  | 'unavailable'
  | 'manual'
  | 'runtime'
  | 'policy-pending'
  | 'disabled'
  | 'not-reported'

export interface QueryRulesRequest extends InspectorQueryBase {
  status?: InspectorRuleStatus
  pack?: string
}

export interface InspectorRuleItem {
  code: string
  name: string
  pack: string
  status: InspectorRuleStatus
  severity?: InspectorSeverity
  summary?: string
  findingCount: number
  skipReason?: string
  verification?: 'static' | 'manual' | 'runtime' | 'policy-pending'
  tags: string[]
  standards: string[]
}

export interface QueryAuditRequest extends InspectorQueryBase {
  status?: 'applied' | 'invalid' | 'unused'
  rule?: string
}

export interface GetAuditRequest extends InspectorFindingRef {
  diagnosticOffset?: number
  diagnosticLimit?: number
}

export interface InspectorAuditItem {
  id: string
  ruleCode?: string
  status: 'applied' | 'invalid' | 'unused'
  reason?: string
  message?: string
  diagnosticTotal: number
  diagnosticOffset: number
  diagnosticLimit: number
  directive: {
    file: string
    line?: number
    column?: number
    text: string
    mode?: 'line' | 'next-line'
  }
  diagnostics: Array<{
    id: string
    severity: InspectorSeverity
    message: string
    file?: string
    line?: number
    column?: number
  }>
}

export interface InspectorSnippet {
  snapshotId: string
  findingId: string
  file: string
  startLine: number
  endLine: number
  language: string
  content: string
  highlightLine?: number
}

export interface GetSnippetRequest extends InspectorFindingRef {
  contextLines?: number
}

export const INSPECTOR_EDITORS = ['vscode', 'cursor', 'webstorm'] as const
export type InspectorEditor = typeof INSPECTOR_EDITORS[number]

export function isInspectorEditor(value: unknown): value is InspectorEditor {
  return INSPECTOR_EDITORS.some(editor => editor === value)
}

export interface OpenEditorRequest extends InspectorFindingRef {
  editor?: InspectorEditor
}

export interface InspectorActionResult {
  snapshotId: string
  ok: true
}

export interface RunInspectorRequest {
  snapshotId?: string
}

export interface RunInspectorResult {
  accepted: boolean
  revision: number
  snapshotId?: string
}

export interface ExportReportRequest {
  snapshotId: string
  format: 'json'
}

export interface ExportReportResult {
  snapshotId: string
  format: 'json'
  contentType: 'application/json; charset=utf-8'
  content: string
}

export interface VueDoctorInspectorApi {
  getSnapshot(request?: Record<string, never>): InspectorSnapshot
  queryFindings(request: QueryFindingsRequest): InspectorPage<InspectorFindingSummary>
  getFinding(request: GetFindingRequest): InspectorFindingDetail
  getCoverage(request: QueryCoverageRequest): InspectorCoverageResult
  queryRules(request: QueryRulesRequest): InspectorPage<InspectorRuleItem>
  queryAudit(request: QueryAuditRequest): InspectorPage<InspectorAuditItem>
  getAudit(request: GetAuditRequest): InspectorAuditItem
  exportReport(request: ExportReportRequest): ExportReportResult
  run(request?: RunInspectorRequest): Promise<RunInspectorResult>
  getSnippet(request: GetSnippetRequest): Promise<InspectorSnippet>
  openEditor(request: OpenEditorRequest): Promise<InspectorActionResult>
}

export type InspectorProtocolErrorCode =
  | 'invalid-request'
  | 'stale-snapshot'
  | 'not-found'
  | 'run-unavailable'
  | 'run-failed'
  | 'source-unavailable'
  | 'closed'

export class InspectorProtocolError extends Error {
  readonly code: InspectorProtocolErrorCode
  readonly details?: Record<string, string | number | boolean | undefined>

  constructor(
    code: InspectorProtocolErrorCode,
    message: string,
    details?: Record<string, string | number | boolean | undefined>
  ) {
    super(message)
    this.name = 'InspectorProtocolError'
    this.code = code
    this.details = details
  }

  toJSON(): {
    name: string
    code: InspectorProtocolErrorCode
    message: string
    details?: Record<string, string | number | boolean | undefined>
  } {
    return { name: this.name, code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) }
  }
}

export function assertQueryFindingsRequest(value: unknown): asserts value is QueryFindingsRequest {
  assertQueryBase(value, [
    'snapshotId', 'offset', 'limit', 'query', 'severity', 'confidence', 'domain', 'rule', 'package', 'source', 'file', 'includeSuggestions'
  ])
  const request = value as unknown as Record<string, unknown>
  assertEnumOrArray(request.severity, ['error', 'warning', 'info'], 'severity')
  assertEnumOrArray(request.confidence, ['low', 'medium', 'high'], 'confidence')
  for (const key of ['domain', 'rule', 'package', 'source', 'file'] as const) assertOptionalString(request[key], key)
  if (request.includeSuggestions !== undefined && typeof request.includeSuggestions !== 'boolean') invalid('includeSuggestions must be a boolean.')
}

export function assertGetSnapshotRequest(value: unknown): asserts value is Record<string, never> | undefined {
  if (value === undefined) return
  assertStrictObject(value, [])
}

export function assertGetFindingRequest(value: unknown): asserts value is GetFindingRequest {
  assertStrictObject(value, ['snapshotId', 'id', 'evidenceOffset', 'evidenceLimit'])
  const request = value as Record<string, unknown>
  assertSnapshotId(request.snapshotId)
  assertNonEmptyString(request.id, 'id')
  if (request.evidenceOffset !== undefined && (!Number.isSafeInteger(request.evidenceOffset) || Number(request.evidenceOffset) < 0)) invalid('evidenceOffset must be a non-negative safe integer.')
  if (request.evidenceLimit !== undefined && (!Number.isSafeInteger(request.evidenceLimit) || Number(request.evidenceLimit) < 1 || Number(request.evidenceLimit) > 100)) invalid('evidenceLimit must be an integer between 1 and 100.')
}

export function assertQueryCoverageRequest(value: unknown): asserts value is QueryCoverageRequest {
  assertQueryBase(value, ['snapshotId', 'offset', 'limit', 'query', 'category', 'status'])
  const request = value as unknown as Record<string, unknown>
  assertOptionalEnum(request.category, ['source', 'parse', 'context', 'contract', 'skipped', 'domain'], 'category')
  assertOptionalEnum(request.status, ['complete', 'partial', 'blocked', 'skipped', 'not-covered', 'not-reported'], 'status')
}

export function assertQueryRulesRequest(value: unknown): asserts value is QueryRulesRequest {
  assertQueryBase(value, ['snapshotId', 'offset', 'limit', 'query', 'status', 'pack'])
  const request = value as unknown as Record<string, unknown>
  assertOptionalEnum(request.status, [
    'checked', 'partial', 'not-applicable', 'unavailable', 'manual', 'runtime', 'policy-pending', 'disabled', 'not-reported'
  ], 'status')
  assertOptionalString(request.pack, 'pack')
}

export function assertQueryAuditRequest(value: unknown): asserts value is QueryAuditRequest {
  assertQueryBase(value, ['snapshotId', 'offset', 'limit', 'query', 'status', 'rule'])
  const request = value as unknown as Record<string, unknown>
  assertOptionalEnum(request.status, ['applied', 'invalid', 'unused'], 'status')
  assertOptionalString(request.rule, 'rule')
}

export function assertGetAuditRequest(value: unknown): asserts value is GetAuditRequest {
  assertStrictObject(value, ['snapshotId', 'id', 'diagnosticOffset', 'diagnosticLimit'])
  const request = value as Record<string, unknown>
  assertSnapshotId(request.snapshotId)
  assertNonEmptyString(request.id, 'id')
  if (request.diagnosticOffset !== undefined && (!Number.isSafeInteger(request.diagnosticOffset) || Number(request.diagnosticOffset) < 0)) invalid('diagnosticOffset must be a non-negative safe integer.')
  if (request.diagnosticLimit !== undefined && (!Number.isSafeInteger(request.diagnosticLimit) || Number(request.diagnosticLimit) < 1 || Number(request.diagnosticLimit) > 100)) invalid('diagnosticLimit must be an integer between 1 and 100.')
}

export function assertGetSnippetRequest(value: unknown): asserts value is GetSnippetRequest {
  assertStrictObject(value, ['snapshotId', 'id', 'contextLines'])
  const request = value as Record<string, unknown>
  assertSnapshotId(request.snapshotId)
  assertNonEmptyString(request.id, 'id')
  if (request.contextLines !== undefined && (!Number.isInteger(request.contextLines) || Number(request.contextLines) < 0 || Number(request.contextLines) > 20)) {
    invalid('contextLines must be an integer between 0 and 20.')
  }
}

export function assertOpenEditorRequest(value: unknown): asserts value is OpenEditorRequest {
  assertStrictObject(value, ['snapshotId', 'id', 'editor'])
  const request = value as Record<string, unknown>
  assertSnapshotId(request.snapshotId)
  assertNonEmptyString(request.id, 'id')
  assertOptionalEnum(request.editor, INSPECTOR_EDITORS, 'editor')
}

export function assertRunInspectorRequest(value: unknown): asserts value is RunInspectorRequest {
  if (value === undefined) return
  assertStrictObject(value, ['snapshotId'])
  const snapshotId = (value as Record<string, unknown>).snapshotId
  if (snapshotId !== undefined) assertSnapshotId(snapshotId)
}

export function assertExportReportRequest(value: unknown): asserts value is ExportReportRequest {
  assertStrictObject(value, ['snapshotId', 'format'])
  const request = value as Record<string, unknown>
  assertSnapshotId(request.snapshotId)
  if (request.format !== 'json') invalid('format must be "json".')
}

function assertQueryBase(value: unknown, keys: readonly string[]): asserts value is InspectorQueryBase {
  assertStrictObject(value, keys)
  const request = value as Record<string, unknown>
  assertSnapshotId(request.snapshotId)
  if (request.offset !== undefined && (!Number.isInteger(request.offset) || Number(request.offset) < 0)) invalid('offset must be a non-negative integer.')
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > 500)) {
    invalid('limit must be an integer between 1 and 500.')
  }
  assertOptionalString(request.query, 'query')
}

function assertStrictObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Request must be a JSON object.')
  const allowed = new Set(keys)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowed.has(key)) invalid(`Unknown request field: ${key}.`)
  }
}

function assertSnapshotId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^vds1:[a-f0-9]{32}$/.test(value)) invalid('snapshotId is invalid.')
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} must be a non-empty string.`)
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') invalid(`${field} must be a string.`)
}

function assertOptionalEnum(value: unknown, values: readonly string[], field: string): void {
  if (value !== undefined && (typeof value !== 'string' || !values.includes(value))) invalid(`${field} is invalid.`)
}

function assertEnumOrArray(value: unknown, values: readonly string[], field: string): void {
  if (value === undefined) return
  const entries = Array.isArray(value) ? value : [value]
  if (entries.length === 0 || entries.some(entry => typeof entry !== 'string' || !values.includes(entry))) invalid(`${field} is invalid.`)
}

function invalid(message: string): never {
  throw new InspectorProtocolError('invalid-request', message)
}

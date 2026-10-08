import type { AgentHandle, DevframeNodeContext } from 'devframe'
import type {
  InspectorAuditItem,
  InspectorCoverageItem,
  InspectorFindingDetail,
  InspectorFindingSummary,
  InspectorRuleItem,
  InspectorSnapshot,
  GetAuditRequest,
  GetFindingRequest,
  QueryAuditRequest,
  QueryCoverageRequest,
  QueryFindingsRequest,
  QueryRulesRequest
} from './protocol.js'
import { InspectorProtocolError } from './protocol.js'
import type { InspectorReportStore, InspectorScanDiffFinding } from './report-store.js'

export const VUE_DOCTOR_AGENT_HELP = `Vue Doctor diagnoses a Vue project from a completed, immutable report snapshot.

Recommended workflow:
1. Call vue-doctor_get-overview and keep its snapshotId.
2. If coverageStatus is partial or blocked, inspect vue-doctor_get-coverage before judging the findings. Zero findings is clean only when coverageStatus is complete.
3. Page through vue-doctor_list-findings, then call vue-doctor_get-finding and vue-doctor_get-source-context for selected finding IDs.
4. Edit project files with your normal file tools. Vue Doctor MCP never writes source files.
5. Call vue-doctor_rescan with the current snapshotId, then inspect the returned diff. If a stale-snapshot error is returned, call vue-doctor_get-overview and retry with the new snapshotId.

Rules and suppressions are available through vue-doctor_list-rules, vue-doctor_list-suppressions, and vue-doctor_get-suppression. Responses are intentionally bounded; use offsets to continue.`

const defaultPageLimit = 20
const maxPageLimit = 50
const maxDetailLimit = 20
const maxSourceContextLines = 10
const maxSourceBytes = 16 * 1024
const maxFacetItems = 20
const maxArrayItems = 20
const maxText = 512
const maxLongText = 1024
// Devframe's MCP adapter returns this payload twice: structuredContent plus a
// human-readable JSON text block. A 24 KiB payload keeps the complete MCP
// tools/call result under the separate 64 KiB wire budget, including escapes.
const maxResponseBytes = 24 * 1024
const maxMcpResultBytes = 64 * 1024
const maxIdentifierBytes = 512
const clippedTextMarker = '\u0000vue-doctor-clipped\u0000'

const emptyInputSchema = objectSchema({})
const resultOutputSchema = {
  type: 'object',
  required: ['ok', 'snapshotId', 'coverageStatus'],
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    snapshotId: { type: ['string', 'null'] },
    coverageStatus: { type: ['string', 'null'], enum: ['complete', 'partial', 'blocked', null] }
  }
} as const

export function registerVueDoctorAgent(context: DevframeNodeContext, store: InspectorReportStore): () => void {
  const handles: AgentHandle[] = []
  const tool = (input: Parameters<DevframeNodeContext['agent']['registerTool']>[0]) => {
    handles.push(context.agent.registerTool(input))
  }

  tool({
    id: 'vue-doctor:help', title: 'Vue Doctor help', safety: 'read', tags: ['vue', 'diagnostics', 'help'],
    description: 'Read the short Vue Doctor agent workflow, including coverage and stale-snapshot rules.',
    inputSchema: emptyInputSchema, outputSchema: resultOutputSchema,
    handler: agentHandler(store, args => {
      strictObject(args, [])
      return { help: VUE_DOCTOR_AGENT_HELP }
    })
  })
  tool({
    id: 'vue-doctor:get-overview', title: 'Get Vue Doctor overview', safety: 'read', tags: ['vue', 'diagnostics'],
    description: 'Get the current bounded project summary, diagnostic counts, coverage status, and top facets. Call this first.',
    inputSchema: emptyInputSchema, outputSchema: resultOutputSchema,
    handler: agentHandler(store, args => {
      strictObject(args, [])
      return { overview: projectOverview(store.getSnapshot()) }
    })
  })
  tool({
    id: 'vue-doctor:list-findings', title: 'List Vue Doctor findings', safety: 'read', tags: ['vue', 'diagnostics'],
    description: 'Page and filter active diagnostics from one immutable snapshot. Default limit 20; maximum 50.',
    inputSchema: findingsQuerySchema, outputSchema: resultOutputSchema,
    handler: agentHandler(store, args => {
      const input = queryInput(args, ['severity', 'confidence', 'domain', 'rule', 'package', 'source', 'file', 'includeSuggestions']) as QueryFindingsRequest
      const result = store.queryFindings(input)
      return { findings: boundedPage(result, findingSummary) }
    })
  })
  tool({
    id: 'vue-doctor:get-finding', title: 'Get Vue Doctor finding', safety: 'read', tags: ['vue', 'diagnostics', 'evidence'],
    description: 'Get bounded evidence and remediation details for one finding ID. Evidence limit defaults to 20 and cannot exceed 20.',
    inputSchema: detailSchema('evidence'), outputSchema: resultOutputSchema,
    handler: agentHandler(store, args => {
      const input = detailInput(args, 'evidenceOffset', 'evidenceLimit') as GetFindingRequest
      return { finding: findingDetail(store.getFinding(input)) }
    })
  })
  tool({
    id: 'vue-doctor:get-coverage', title: 'Get Vue Doctor coverage', safety: 'read', tags: ['vue', 'coverage'],
    description: 'Page coverage gaps and skipped checks. Inspect this whenever coverage is partial or blocked.',
    inputSchema: coverageQuerySchema, outputSchema: resultOutputSchema,
    handler: agentHandler(store, args => {
      const input = queryInput(args, ['category', 'status']) as QueryCoverageRequest
      const result = store.getCoverage(input)
      return {
        coverage: {
          ...boundedPage(result, coverageItem),
          summary: result.summary.slice(0, maxArrayItems)
        }
      }
    })
  })
  tool({
    id: 'vue-doctor:list-rules', title: 'List Vue Doctor rules', safety: 'read', tags: ['vue', 'rules'],
    description: 'Page registered rule checks, including unavailable, manual, runtime, disabled, and finding-bearing rules.',
    inputSchema: rulesQuerySchema, outputSchema: resultOutputSchema,
    handler: agentHandler(store, args => {
      const input = queryInput(args, ['status', 'pack']) as QueryRulesRequest
      return { rules: boundedPage(store.queryRules(input), ruleItem) }
    })
  })
  tool({
    id: 'vue-doctor:list-suppressions', title: 'List Vue Doctor suppressions', safety: 'read', tags: ['vue', 'suppressions', 'audit'],
    description: 'Page applied, unused, and invalid local suppression directives without mixing them into active findings.',
    inputSchema: suppressionsQuerySchema, outputSchema: resultOutputSchema,
    handler: agentHandler(store, args => {
      const input = queryInput(args, ['status', 'rule']) as QueryAuditRequest
      return { suppressions: boundedPage(store.queryAudit(input), suppressionItem) }
    })
  })
  tool({
    id: 'vue-doctor:get-suppression', title: 'Get Vue Doctor suppression', safety: 'read', tags: ['vue', 'suppressions', 'audit'],
    description: 'Get one suppression directive and a bounded page of diagnostics it suppressed.',
    inputSchema: detailSchema('diagnostic'), outputSchema: resultOutputSchema,
    handler: agentHandler(store, args => {
      const input = detailInput(args, 'diagnosticOffset', 'diagnosticLimit') as GetAuditRequest
      return { suppression: suppressionItem(store.getAudit(input), true) }
    })
  })
  tool({
    id: 'vue-doctor:get-source-context', title: 'Get finding source context', safety: 'read', tags: ['vue', 'source', 'evidence'],
    description: 'Read source only through a finding ID. The path is root-confined; context is at most 10 lines each side and 16 KiB total.',
    inputSchema: sourceContextSchema, outputSchema: resultOutputSchema,
    handler: agentHandler(store, async args => {
      const input = sourceInput(args)
      const snippet = await store.getSnippet(input)
      const bounded = boundedUtf8(snippet.content, maxSourceBytes)
      return {
        source: {
          snapshotId: snippet.snapshotId,
          findingId: identifier(snippet.findingId, 'finding id'),
          file: text(snippet.file),
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          language: text(snippet.language, 64),
          content: bounded.value,
          truncated: bounded.truncated,
          ...(snippet.highlightLine ? { highlightLine: snippet.highlightLine } : {})
        }
      }
    })
  })
  tool({
    id: 'vue-doctor:rescan', title: 'Rescan with Vue Doctor', safety: 'action', tags: ['vue', 'diagnostics', 'scan'],
    description: 'Explicitly invalidate and rescan the project from the supplied current snapshot ID. Returns a bounded before/after diff.',
    inputSchema: snapshotSchema, outputSchema: resultOutputSchema,
    handler: agentHandler(store, async args => {
      const input = snapshotInput(args)
      const result = await store.run(input)
      const snapshot = store.getSnapshot()
      const diff = store.getLastScanDiff()
      if (result.snapshotId !== snapshot.snapshotId || diff?.afterSnapshotId !== snapshot.snapshotId) {
        throw new InspectorProtocolError('stale-snapshot', 'A newer report replaced the completed rescan before its result could be bound.', {
          requestedSnapshotId: result.snapshotId,
          currentSnapshotId: snapshot.snapshotId
        })
      }
      return boundAgentResult(snapshot, {
        accepted: result.accepted,
        revision: result.revision,
        diff: scanDiff(diff)
      })
    })
  })
  tool({
    id: 'vue-doctor:get-last-scan-diff', title: 'Get last Vue Doctor scan diff', safety: 'read', tags: ['vue', 'diagnostics', 'scan'],
    description: 'Read the bounded diff from the latest successful rescan. A failed rescan leaves the previous successful diff intact.',
    inputSchema: emptyInputSchema, outputSchema: resultOutputSchema,
    handler: agentHandler(store, args => {
      strictObject(args, [])
      return { diff: scanDiff(store.getLastScanDiff()) }
    })
  })

  handles.push(context.agent.registerResource({
    id: 'vue-doctor:help',
    name: 'Vue Doctor agent workflow',
    description: 'Short instructions for diagnosing, editing, and rescanning a Vue project.',
    mimeType: 'text/plain',
    read: () => ({ text: VUE_DOCTOR_AGENT_HELP, mimeType: 'text/plain' })
  }))
  handles.push(context.agent.registerResource({
    id: 'vue-doctor:overview',
    name: 'Current Vue Doctor overview',
    description: 'Bounded live overview of the current Vue Doctor report snapshot.',
    mimeType: 'application/json',
    read: () => {
      const snapshot = store.getSnapshot()
      return { json: finalizeAgentResponse(agentEnvelope(snapshot, { overview: projectOverview(snapshot) })) }
    }
  }))

  return () => {
    for (const handle of handles.splice(0).reverse()) handle.unregister()
  }
}

function agentHandler(
  store: InspectorReportStore,
  handler: (args: unknown) => unknown | Promise<unknown>
): (args: unknown) => Promise<Record<string, unknown>> {
  return async (args) => {
    try {
      const before = store.getSnapshot()
      const handled = await handler(args)
      const current = store.getSnapshot()
      const bound = isBoundAgentResult(handled) ? handled : undefined
      if (!bound && before.snapshotId !== current.snapshotId) {
        throw new InspectorProtocolError('stale-snapshot', 'The report changed while the agent request was running.', {
          requestedSnapshotId: before.snapshotId,
          currentSnapshotId: current.snapshotId
        })
      }
      return finalizeAgentResponse(agentEnvelope(bound?.snapshot ?? current, bound ? bound.value : handled))
    } catch (cause) {
      return finalizeAgentResponse(agentError(store, cause))
    }
  }
}

const boundAgentResultMarker = Symbol('vue-doctor-agent-bound-result')

interface BoundAgentResult {
  [boundAgentResultMarker]: true
  snapshot: InspectorSnapshot
  value: unknown
}

function boundAgentResult(snapshot: InspectorSnapshot, value: unknown): BoundAgentResult {
  return { [boundAgentResultMarker]: true, snapshot, value }
}

function isBoundAgentResult(value: unknown): value is BoundAgentResult {
  return typeof value === 'object'
    && value !== null
    && (value as Partial<BoundAgentResult>)[boundAgentResultMarker] === true
}

function agentEnvelope(snapshot: InspectorSnapshot, value: unknown): Record<string, unknown> {
  return {
    ok: true,
    snapshotId: snapshot.snapshotId,
    coverageStatus: snapshot.coverageStatus,
    clean: snapshot.counts.findings === 0 && snapshot.coverageStatus === 'complete',
    ...(isObject(value) ? value : { value })
  }
}

function agentError(store: InspectorReportStore, cause: unknown): Record<string, unknown> {
  let snapshot: InspectorSnapshot | undefined
  try { snapshot = store.getSnapshot() } catch { /* The store may be closed. */ }
  const protocol = cause instanceof InspectorProtocolError ? cause : undefined
  const externalCode = isObject(cause) && typeof cause.code === 'string' ? cause.code : undefined
  const code = protocol?.code ?? externalCode ?? 'internal-error'
  return {
    ok: false,
    snapshotId: snapshot?.snapshotId ?? null,
    coverageStatus: snapshot?.coverageStatus ?? null,
    clean: false,
    error: {
      code,
      message: text(cause instanceof Error ? cause.message : String(cause), maxLongText),
      recovery: recoveryFor(code),
      ...(protocol?.details ? { details: protocol.details } : {})
    }
  }
}

function recoveryFor(code: string): string {
  if (code === 'stale-snapshot') return 'Call vue-doctor_get-overview, then retry with its current snapshotId.'
  if (code === 'not-found') return 'List the relevant findings or suppressions again and use an ID from the current snapshot.'
  if (code === 'invalid-request') return 'Correct the input using the advertised tool schema or call vue-doctor_help.'
  if (code === 'run-unavailable') return 'Start Vue Doctor from an active project analysis session or use vue-doctor mcp <root>.'
  if (code === 'run-failed') return 'Inspect the error and current overview. The last successful snapshot remains readable.'
  if (code === 'source-unavailable' || code === 'outside-root') return 'Choose a current finding with an authorized project source location.'
  if (code === 'closed') return 'Restart the Vue Doctor Inspector or stdio MCP process.'
  return 'Call vue-doctor_help and retry with bounded, schema-valid inputs.'
}

function projectOverview(snapshot: InspectorSnapshot): Record<string, unknown> {
  const facet = (items: InspectorSnapshot['facets']['rules'], truncated: boolean) => ({
    items: items.slice(0, maxFacetItems).map(item => ({ value: text(item.value), count: item.count })),
    truncated: truncated || items.length > maxFacetItems
  })
  return {
    createdAt: snapshot.createdAt,
    project: {
      name: text(snapshot.project.name),
      ...(snapshot.project.root ? { root: text(snapshot.project.root) } : {}),
      vueFramework: snapshot.project.vueFramework,
      ...(snapshot.project.vueVersion ? { vueVersion: text(snapshot.project.vueVersion, 64) } : {}),
      ...(snapshot.project.viteVersion ? { viteVersion: text(snapshot.project.viteVersion, 64) } : {})
    },
    counts: snapshot.counts,
    run: snapshot.run,
    facets: {
      severities: facet(snapshot.facets.severities, snapshot.facetTruncated.severities),
      domains: facet(snapshot.facets.domains, snapshot.facetTruncated.domains),
      rules: facet(snapshot.facets.rules, snapshot.facetTruncated.rules),
      packages: facet(snapshot.facets.packages, snapshot.facetTruncated.packages),
      sources: facet(snapshot.facets.sources, snapshot.facetTruncated.sources)
    }
  }
}

function boundedPage<T, R>(page: { snapshotId: string; offset: number; limit: number; total: number; items: T[] }, map: (item: T) => R) {
  return {
    offset: page.offset,
    limit: page.limit,
    total: page.total,
    returned: page.items.length,
    truncated: page.offset + page.items.length < page.total,
    items: page.items.map(map)
  }
}

function findingSummary(item: InspectorFindingSummary) {
  return {
    id: identifier(item.id, 'finding id'), ruleCode: identifier(item.ruleCode, 'rule code'), severity: item.severity, confidence: item.confidence,
    message: text(item.message), source: text(item.source), hasSuggestions: item.hasSuggestions,
    ...(item.file ? { file: text(item.file) } : {}), ...(item.line ? { line: item.line } : {}),
    ...(item.column ? { column: item.column } : {}), ...(item.domain ? { domain: text(item.domain) } : {}),
    ...(item.rulePack ? { rulePack: text(item.rulePack) } : {}), ...(item.package ? { package: text(item.package) } : {})
  }
}

function findingDetail(item: InspectorFindingDetail) {
  return {
    ...findingSummary(item),
    evidenceOffset: item.evidenceOffset,
    evidenceLimit: Math.min(item.evidenceLimit, maxDetailLimit),
    evidenceTotal: item.evidenceTotal,
    evidenceReturned: item.evidence.length,
    evidenceTruncated: item.evidenceOffset + item.evidence.length < item.evidenceTotal,
    evidence: item.evidence.slice(0, maxDetailLimit).map(evidence => ({
      kind: text(evidence.kind), ...(evidence.file ? { file: text(evidence.file) } : {}),
      ...(evidence.line ? { line: evidence.line } : {}), ...(evidence.column ? { column: evidence.column } : {}),
      ...(evidence.endLine ? { endLine: evidence.endLine } : {}), ...(evidence.endColumn ? { endColumn: evidence.endColumn } : {}),
      ...(evidence.message ? { message: text(evidence.message) } : {}),
      ...(evidence.git ? { git: {
        commit: text(evidence.git.commit, 128), authorName: text(evidence.git.authorName),
        ...(evidence.git.authoredAt ? { authoredAt: text(evidence.git.authoredAt, 128) } : {}),
        ...(evidence.git.summary ? { summary: text(evidence.git.summary) } : {}),
        ...(evidence.git.uncommitted !== undefined ? { uncommitted: evidence.git.uncommitted } : {})
      } } : {})
    })),
    suggestions: item.suggestions.slice(0, maxArrayItems).map(suggestion => ({
      title: text(suggestion.title), ...(suggestion.description ? { description: text(suggestion.description, maxLongText) } : {})
    })),
    suggestionsTruncated: item.suggestions.length > maxArrayItems,
    tags: item.tags.slice(0, maxArrayItems).map(value => text(value, 128)),
    tagsTruncated: item.tags.length > maxArrayItems,
    ...(item.location ? { location: item.location } : {}),
    edits: item.edits.slice(0, maxArrayItems).map(edit => ({
      file: text(edit.file), start: edit.start, end: edit.end, newText: text(edit.newText, maxLongText)
    })),
    editsTruncated: item.edits.length > maxArrayItems
  }
}

function coverageItem(item: InspectorCoverageItem) {
  return {
    id: identifier(item.id, 'coverage id'), category: item.category, status: item.status, title: text(item.title), message: text(item.message),
    ...(item.file ? { file: text(item.file) } : {}), ...(item.ruleCode ? { ruleCode: text(item.ruleCode) } : {}),
    ...(item.package ? { package: text(item.package) } : {}), ...(item.reasonCode ? { reasonCode: text(item.reasonCode) } : {}),
    ...(item.count !== undefined ? { count: item.count } : {})
  }
}

function ruleItem(item: InspectorRuleItem) {
  return {
    code: identifier(item.code, 'rule code'), name: text(item.name), pack: text(item.pack), status: item.status,
    ...(item.severity ? { severity: item.severity } : {}), ...(item.summary ? { summary: text(item.summary) } : {}),
    findingCount: item.findingCount, ...(item.skipReason ? { skipReason: text(item.skipReason) } : {}),
    ...(item.verification ? { verification: item.verification } : {}),
    tags: item.tags.slice(0, maxArrayItems).map(value => text(value, 128)),
    standards: item.standards.slice(0, maxArrayItems).map(value => text(value, 128)),
    metadataTruncated: item.tags.length > maxArrayItems || item.standards.length > maxArrayItems
  }
}

function suppressionItem(item: InspectorAuditItem, includeDiagnostics = false) {
  return {
    id: identifier(item.id, 'suppression id'), status: item.status, ...(item.ruleCode ? { ruleCode: identifier(item.ruleCode, 'rule code') } : {}),
    ...(item.reason ? { reason: text(item.reason) } : {}), ...(item.message ? { message: text(item.message) } : {}),
    diagnosticTotal: item.diagnosticTotal, diagnosticOffset: item.diagnosticOffset,
    diagnosticLimit: Math.min(item.diagnosticLimit, maxDetailLimit),
    directive: {
      file: text(item.directive.file), ...(item.directive.line ? { line: item.directive.line } : {}),
      ...(item.directive.column ? { column: item.directive.column } : {}), text: text(item.directive.text),
      ...(item.directive.mode ? { mode: item.directive.mode } : {})
    },
    ...(includeDiagnostics ? {
      diagnostics: item.diagnostics.slice(0, maxDetailLimit).map(diagnostic => ({
        id: identifier(diagnostic.id, 'diagnostic id'), severity: diagnostic.severity, message: text(diagnostic.message),
        ...(diagnostic.file ? { file: text(diagnostic.file) } : {}), ...(diagnostic.line ? { line: diagnostic.line } : {}),
        ...(diagnostic.column ? { column: diagnostic.column } : {})
      })),
      diagnosticsReturned: item.diagnostics.length,
      diagnosticsTruncated: item.diagnosticOffset + item.diagnostics.length < item.diagnosticTotal
    } : {})
  }
}

function scanDiff(value: ReturnType<InspectorReportStore['getLastScanDiff']>) {
  if (!value) return { available: false }
  const sample = (items: InspectorScanDiffFinding[]) => items.map(finding => ({
    id: identifier(finding.id, 'finding id'), ruleCode: identifier(finding.ruleCode, 'rule code'), severity: finding.severity,
    message: text(finding.message), ...(finding.file ? { file: text(finding.file) } : {}),
    ...(finding.line ? { line: finding.line } : {}), ...(finding.column ? { column: finding.column } : {}),
    truncatedFields: finding.truncatedFields
  }))
  return {
    available: true,
    beforeSnapshotId: value.beforeSnapshotId,
    afterSnapshotId: value.afterSnapshotId,
    createdAt: value.createdAt,
    coverage: value.coverage,
    suppressed: value.suppressed,
    requiredSkipped: value.requiredSkipped,
    findings: {
      ...value.findings,
      samples: {
        added: sample(value.findings.samples.added),
        removed: sample(value.findings.samples.removed),
        changed: sample(value.findings.samples.changed)
      }
    }
  }
}

function queryInput(args: unknown, extraKeys: readonly string[]): Record<string, any> {
  const allowed = ['snapshotId', 'offset', 'limit', 'query', ...extraKeys]
  const input = strictObject(args, allowed)
  const result: Record<string, any> = {
    snapshotId: requiredString(input.snapshotId, 'snapshotId', 128),
    offset: integer(input.offset, 'offset', 0, Number.MAX_SAFE_INTEGER, 0),
    limit: integer(input.limit, 'limit', 1, maxPageLimit, defaultPageLimit)
  }
  if (input.query !== undefined) result.query = optionalString(input.query, 'query', 200)
  for (const key of extraKeys) {
    if (input[key] === undefined) continue
    if (key === 'includeSuggestions') {
      if (typeof input[key] !== 'boolean') invalid(`${key} must be a boolean.`)
      result[key] = input[key]
    } else if (key === 'severity') result[key] = enumOrArray(input[key], key, ['error', 'warning', 'info'])
    else if (key === 'confidence') result[key] = enumOrArray(input[key], key, ['low', 'medium', 'high'])
    else result[key] = requiredString(input[key], key, maxText)
  }
  return result
}

function detailInput(args: unknown, offsetKey: string, limitKey: string): Record<string, any> {
  const input = strictObject(args, ['snapshotId', 'id', offsetKey, limitKey])
  return {
    snapshotId: requiredString(input.snapshotId, 'snapshotId', 128),
    id: requiredString(input.id, 'id', maxText),
    [offsetKey]: integer(input[offsetKey], offsetKey, 0, Number.MAX_SAFE_INTEGER, 0),
    [limitKey]: integer(input[limitKey], limitKey, 1, maxDetailLimit, maxDetailLimit)
  }
}

function sourceInput(args: unknown) {
  const input = strictObject(args, ['snapshotId', 'id', 'contextLines'])
  return {
    snapshotId: requiredString(input.snapshotId, 'snapshotId', 128),
    id: requiredString(input.id, 'id', maxText),
    contextLines: integer(input.contextLines, 'contextLines', 0, maxSourceContextLines, 3)
  }
}

function snapshotInput(args: unknown) {
  const input = strictObject(args, ['snapshotId'])
  return { snapshotId: requiredString(input.snapshotId, 'snapshotId', 128) }
}

function strictObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) invalid('Input must be a JSON object.')
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`Unknown input field: ${key}.`)
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} must be a non-empty string.`)
  if (value.length > limit) invalid(`${field} must be at most ${limit} characters.`)
  return value
}

function optionalString(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string') invalid(`${field} must be a string.`)
  if (value.length > limit) invalid(`${field} must be at most ${limit} characters.`)
  return value
}

function integer(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(`${field} must be an integer between ${min} and ${max}.`)
  return Number(value)
}

function enumOrArray(value: unknown, field: string, choices: readonly string[]): string | string[] {
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0 || values.length > choices.length || values.some(item => typeof item !== 'string' || !choices.includes(item))) {
    invalid(`${field} contains an unsupported value.`)
  }
  return Array.isArray(value) ? values as string[] : values[0] as string
}

function invalid(message: string): never {
  throw new InspectorProtocolError('invalid-request', message)
}

function text(value: string, limit = maxText): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…${clippedTextMarker}`
}

function identifier(value: string, label: string): string {
  if (Buffer.byteLength(value) > maxIdentifierBytes) {
    throw new InspectorProtocolError('invalid-request', `${label} exceeds the ${maxIdentifierBytes}-byte Agent contract and cannot be exposed safely.`)
  }
  return value
}

function boundedUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return { value, truncated: false }
  let end = maxBytes - 3
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--
  return { value: `${bytes.subarray(0, end).toString('utf8')}…`, truncated: true }
}

function finalizeAgentResponse(value: Record<string, unknown>): Record<string, unknown> {
  const clippedFields: string[] = []
  const normalized = normalizeOutput(value, '', clippedFields) as Record<string, unknown>
  const omitted = new Map<string, number>()
  while (serializedBytes(normalized) > maxResponseBytes - 2_048 || mcpResultBytes(normalized) > maxMcpResultBytes - 4_096) {
    const arrays = collectArrays(normalized)
      .filter(candidate => candidate.value.length > 0)
      .sort((left, right) => right.value.length - left.value.length || left.path.localeCompare(right.path))
    const candidate = arrays[0]
    if (!candidate) break
    candidate.value.pop()
    omitted.set(candidate.path, (omitted.get(candidate.path) ?? 0) + 1)
    markArrayTruncated(candidate.parent, candidate.key, candidate.value.length)
  }
  const truncated = clippedFields.length > 0 || omitted.size > 0
  normalized.response = {
    maxBytes: maxResponseBytes,
    mcpResultMaxBytes: maxMcpResultBytes,
    bytes: 0,
    mcpResultBytes: 0,
    truncated,
    clippedFieldCount: clippedFields.length,
    clippedFields: clippedFields.slice(0, 20),
    clippedFieldsTruncated: clippedFields.length > 20,
    omittedItems: [...omitted].slice(0, 20).map(([path, count]) => ({ path, count })),
    omittedItemsTruncated: omitted.size > 20
  }
  while (serializedBytes(normalized) > maxResponseBytes || mcpResultBytes(normalized) > maxMcpResultBytes) {
    const arrays = collectArrays(normalized)
      .filter(candidate => candidate.value.length > 0 && !candidate.path.startsWith('response.'))
      .sort((left, right) => right.value.length - left.value.length || left.path.localeCompare(right.path))
    const candidate = arrays[0]
    if (!candidate) break
    candidate.value.pop()
    omitted.set(candidate.path, (omitted.get(candidate.path) ?? 0) + 1)
    markArrayTruncated(candidate.parent, candidate.key, candidate.value.length)
  }
  const response = normalized.response as Record<string, unknown>
  response.omittedItems = [...omitted].slice(0, 20).map(([path, count]) => ({ path, count }))
  response.omittedItemsTruncated = omitted.size > 20
  response.truncated = clippedFields.length > 0 || omitted.size > 0
  for (let iteration = 0; iteration < 4; iteration++) {
    response.bytes = serializedBytes(normalized)
    response.mcpResultBytes = mcpResultBytes(normalized)
  }
  if (serializedBytes(normalized) > maxResponseBytes || mcpResultBytes(normalized) > maxMcpResultBytes) return responseTooLarge(value)
  return normalized
}

function normalizeOutput(value: unknown, path: string, clippedFields: string[]): unknown {
  if (typeof value === 'string') {
    if (isIdentifierPath(path)) return identifier(value.replaceAll(clippedTextMarker, ''), path)
    const explicitlyClipped = value.includes(clippedTextMarker)
    const clean = value.replaceAll(clippedTextMarker, '')
    const bounded = boundedUtf8(clean, path === 'source.content' ? maxSourceBytes : maxText * 4)
    if (explicitlyClipped || bounded.truncated) clippedFields.push(path || '$')
    return bounded.value
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeOutput(item, `${path}[${index}]`, clippedFields))
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, normalizeOutput(item, path ? `${path}.${key}` : key, clippedFields)]))
  }
  return value
}

interface ArrayCandidate {
  value: unknown[]
  parent: Record<string, unknown> | unknown[]
  key: string | number
  path: string
}

function collectArrays(value: unknown): ArrayCandidate[] {
  const candidates: ArrayCandidate[] = []
  const visit = (current: unknown, path: string, parent?: Record<string, unknown> | unknown[], key?: string | number) => {
    if (Array.isArray(current)) {
      if (parent && key !== undefined) candidates.push({ value: current, parent, key, path })
      current.forEach((item, index) => visit(item, `${path}[${index}]`, current, index))
      return
    }
    if (isObject(current)) for (const [childKey, child] of Object.entries(current)) {
      visit(child, path ? `${path}.${childKey}` : childKey, current, childKey)
    }
  }
  visit(value, '')
  return candidates
}

function markArrayTruncated(parent: Record<string, unknown> | unknown[], key: string | number, returned: number): void {
  if (Array.isArray(parent) || typeof key !== 'string') return
  if (key === 'items') {
    parent.returned = returned
    parent.truncated = true
    return
  }
  if (['evidence', 'suggestions', 'tags', 'edits', 'diagnostics'].includes(key)) {
    parent[`${key}Truncated`] = true
    parent[`${key}Returned`] = returned
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function mcpResultBytes(value: unknown): number {
  const text = JSON.stringify(value, null, 2)
  return Buffer.byteLength(JSON.stringify({
    content: [{ type: 'text', text }],
    structuredContent: value
  }))
}

function isIdentifierPath(path: string): boolean {
  return /(?:^|\.)(?:snapshotId|beforeSnapshotId|afterSnapshotId|findingId|id)$/u.test(path)
}

function responseTooLarge(source: Record<string, unknown>): Record<string, unknown> {
  const snapshotId = typeof source.snapshotId === 'string' && Buffer.byteLength(source.snapshotId) <= maxIdentifierBytes
    ? source.snapshotId
    : null
  const coverageStatus = ['complete', 'partial', 'blocked'].includes(String(source.coverageStatus))
    ? source.coverageStatus
    : null
  const fallback: Record<string, unknown> = {
    ok: false,
    snapshotId,
    coverageStatus,
    clean: false,
    error: {
      code: 'response-too-large',
      message: 'The bounded Vue Doctor response could not fit within the 24 KiB payload and 64 KiB MCP result budgets.',
      recovery: 'Narrow the query, lower the page limit, or request one finding by ID.'
    },
    response: {
      maxBytes: maxResponseBytes,
      mcpResultMaxBytes: maxMcpResultBytes,
      bytes: 0,
      mcpResultBytes: 0,
      truncated: true,
      clippedFieldCount: 0,
      clippedFields: [],
      clippedFieldsTruncated: false,
      omittedItems: [],
      omittedItemsTruncated: false
    }
  }
  const metadata = fallback.response as Record<string, unknown>
  for (let iteration = 0; iteration < 4; iteration++) {
    metadata.bytes = serializedBytes(fallback)
    metadata.mcpResultBytes = mcpResultBytes(fallback)
  }
  return fallback
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[] = []) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) }
}

const snapshotProperty = { type: 'string', pattern: '^vds1:[a-f0-9]{32}$' }
const pageProperties = {
  snapshotId: snapshotProperty,
  offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: maxPageLimit, default: defaultPageLimit },
  query: { type: 'string', maxLength: 200 }
}
const snapshotSchema = objectSchema({ snapshotId: snapshotProperty }, ['snapshotId'])
const findingsQuerySchema = objectSchema({
  ...pageProperties,
  severity: { oneOf: [{ enum: ['error', 'warning', 'info'] }, { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ['error', 'warning', 'info'] } }] },
  confidence: { oneOf: [{ enum: ['low', 'medium', 'high'] }, { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ['low', 'medium', 'high'] } }] },
  domain: { type: 'string', maxLength: maxText }, rule: { type: 'string', maxLength: maxText },
  package: { type: 'string', maxLength: maxText }, source: { type: 'string', maxLength: maxText },
  file: { type: 'string', maxLength: maxText }, includeSuggestions: { type: 'boolean' }
}, ['snapshotId'])
const coverageQuerySchema = objectSchema({
  ...pageProperties,
  category: { enum: ['source', 'parse', 'context', 'contract', 'skipped', 'domain'] },
  status: { enum: ['complete', 'partial', 'blocked', 'skipped', 'not-covered', 'not-reported'] }
}, ['snapshotId'])
const rulesQuerySchema = objectSchema({
  ...pageProperties,
  status: { enum: ['checked', 'partial', 'not-applicable', 'unavailable', 'manual', 'runtime', 'policy-pending', 'disabled', 'not-reported'] },
  pack: { type: 'string', maxLength: maxText }
}, ['snapshotId'])
const suppressionsQuerySchema = objectSchema({
  ...pageProperties,
  status: { enum: ['applied', 'invalid', 'unused'] },
  rule: { type: 'string', maxLength: maxText }
}, ['snapshotId'])
function detailSchema(prefix: 'evidence' | 'diagnostic') {
  return objectSchema({
    snapshotId: snapshotProperty, id: { type: 'string', minLength: 1, maxLength: maxText },
    [`${prefix}Offset`]: { type: 'integer', minimum: 0 },
    [`${prefix}Limit`]: { type: 'integer', minimum: 1, maximum: maxDetailLimit, default: maxDetailLimit }
  }, ['snapshotId', 'id'])
}
const sourceContextSchema = objectSchema({
  snapshotId: snapshotProperty,
  id: { type: 'string', minLength: 1, maxLength: maxText },
  contextLines: { type: 'integer', minimum: 0, maximum: maxSourceContextLines, default: 3 }
}, ['snapshotId', 'id'])

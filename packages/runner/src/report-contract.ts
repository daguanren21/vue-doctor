import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  Diagnostic,
  DiagnosticPosition,
  DiagnosticPrimaryLocation,
  DoctorReport,
  DoctorSuppressionAudit
} from '@vue-doctor/core'
import type { SourceSuppressionDirective, SourceSuppressionScan } from '@vue-doctor/source'

export interface DoctorReportTargetFacts {
  root: string
  scope?: string | string[]
  requestedFiles?: readonly string[]
  files: readonly string[]
}

export interface DoctorReportSuppressionFacts {
  scans: readonly SourceSuppressionScan[]
  registeredRuleCodes: Iterable<string>
}

export interface FinalizeDoctorReportOptions {
  target: DoctorReportTargetFacts
  generation?: number
  suppression?: DoctorReportSuppressionFacts
}

/** Build the portable v1 report contract, then apply audited local suppressions. */
export function finalizeDoctorReport(
  report: DoctorReport,
  options: FinalizeDoctorReportOptions
): DoctorReport {
  const root = resolve(options.target.root)
  const diagnostics = finalizeDiagnostics(report.diagnostics, root)
  const scopes = normalizePaths(root, toArray(options.target.scope))
  const mode = options.target.requestedFiles !== undefined
    ? 'files'
    : options.target.scope !== undefined
      ? 'scope'
      : 'project'
  const generation = options.generation ?? report.run?.generation
  const finalized: DoctorReport = {
    ...report,
    schemaVersion: 1,
    run: {
      status: report.coverage.status,
      target: {
        mode,
        scopes,
        ...(options.target.requestedFiles !== undefined
          ? { requestedFiles: normalizePaths(root, options.target.requestedFiles) }
          : {}),
        files: normalizePaths(root, options.target.files)
      },
      ...(generation !== undefined ? { generation } : {})
    },
    diagnostics
  }
  return options.suppression
    ? applyDoctorSuppressions(finalized, root, options.suppression)
    : finalized
}

function finalizeDiagnostics(diagnostics: readonly Diagnostic[], root: string): Diagnostic[] {
  const finalized = diagnostics.map((diagnostic) => {
    const primaryLocation = createPrimaryLocation(diagnostic, root)
    const normalized: Diagnostic = {
      ...diagnostic,
      fixes: diagnostic.fixes.map((fix) => ({ ...fix, kind: 'suggestion' as const })),
      ...(primaryLocation ? { primaryLocation } : {})
    }
    return {
      ...normalized,
      id: createDiagnosticId(normalized, root)
    }
  })

  const unique = new Map<string, Diagnostic>()
  for (const diagnostic of finalized) {
    const key = exactDiagnosticKey(diagnostic, root)
    if (!unique.has(key)) unique.set(key, diagnostic)
  }
  return [...unique.values()]
}

function createPrimaryLocation(diagnostic: Diagnostic, root: string): DiagnosticPrimaryLocation | undefined {
  const explicit = diagnostic.primaryLocation
  const evidence = selectPrimaryEvidence(diagnostic, root)
  const file = explicit?.file || diagnostic.file || evidence?.file
  if (!file) return undefined

  const explicitStart = validPosition(explicit?.start)
  const evidenceStart = validPosition(evidence?.line === undefined
    ? undefined
    : { line: evidence.line, ...(evidence.column !== undefined ? { column: evidence.column } : {}) })
  // A producer-supplied location is one atomic fact. Never graft coordinates
  // from evidence for another file onto an explicit file-only location.
  const start = explicit?.file ? explicitStart : evidenceStart
  if (!start) return { file: normalizePath(root, file), precision: 'file' }

  const rawEnd = explicit?.file
    ? explicit.end
    : evidence?.endColumn !== undefined
      ? { line: evidence.endLine ?? start.line, column: evidence.endColumn }
      : undefined
  const end = validPosition(rawEnd)
  if (start.column !== undefined && end?.column !== undefined && positionAtOrAfter(
    { line: end.line, column: end.column },
    { line: start.line, column: start.column }
  )) {
    return { file: normalizePath(root, file), start, end, precision: 'range' }
  }
  if (start.column !== undefined) {
    return { file: normalizePath(root, file), start, precision: 'point' }
  }
  return { file: normalizePath(root, file), start, precision: 'line' }
}

function selectPrimaryEvidence(diagnostic: Diagnostic, root: string) {
  const withLocation = diagnostic.evidence.filter((item) => item.file || item.line !== undefined)
  const eligible = diagnostic.file
    ? withLocation.filter((item) => (
        !item.file || normalizePath(root, item.file) === normalizePath(root, diagnostic.file!)
      ))
    : withLocation
  const candidates = eligible.some((item) => item.line !== undefined)
    ? eligible.filter((item) => item.line !== undefined)
    : eligible
  return [...candidates].sort((left, right) => (
    (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
    || (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.file ? normalizePath(root, left.file) : '', right.file ? normalizePath(root, right.file) : '')
    || compareText(left.kind, right.kind)
    || compareText(
      left.message ? normalizeFactText(left.message, root) : '',
      right.message ? normalizeFactText(right.message, root) : ''
    )
    || (left.endLine ?? Number.MAX_SAFE_INTEGER) - (right.endLine ?? Number.MAX_SAFE_INTEGER)
    || (left.endColumn ?? Number.MAX_SAFE_INTEGER) - (right.endColumn ?? Number.MAX_SAFE_INTEGER)
  ))[0]
}

function validPosition(position: { line?: number; column?: number } | undefined): DiagnosticPosition | undefined {
  if (!position || !Number.isInteger(position.line) || Number(position.line) < 1) return undefined
  if (position.column !== undefined && (!Number.isInteger(position.column) || position.column < 1)) {
    return { line: position.line! }
  }
  return {
    line: position.line!,
    ...(position.column !== undefined ? { column: position.column } : {})
  }
}

function positionAtOrAfter(end: { line: number; column: number }, start: { line: number; column: number }) {
  return end.line > start.line || (end.line === start.line && end.column >= start.column)
}

function createDiagnosticId(diagnostic: Diagnostic, root: string) {
  const evidence = diagnostic.evidence
    .map(({ git: _git, ...item }) => ({
      ...item,
      ...(item.file ? { file: normalizePath(root, item.file) } : {}),
      ...(item.message ? { message: normalizeFactText(item.message, root) } : {})
    }))
    .sort((left, right) => compareText(canonicalStringify(left), canonicalStringify(right)))
  const facts = {
    code: diagnostic.code,
    message: normalizeFactText(diagnostic.message, root),
    ...(diagnostic.primaryLocation ? { primaryLocation: diagnostic.primaryLocation } : {}),
    evidence
  }
  const digest = createHash('sha256').update(canonicalStringify(facts)).digest('hex').slice(0, 32)
  return `vd1:${digest}`
}

function exactDiagnosticKey(diagnostic: Diagnostic, root: string) {
  const { id: _id, ...withoutId } = diagnostic
  return canonicalStringify({
    ...withoutId,
    ...(withoutId.file ? { file: normalizePath(root, withoutId.file) } : {}),
    evidence: withoutId.evidence.map((item) => ({
      ...item,
      ...(item.file ? { file: normalizePath(root, item.file) } : {})
    })).sort((left, right) => compareText(canonicalStringify(left), canonicalStringify(right)))
  })
}

function applyDoctorSuppressions(
  report: DoctorReport,
  root: string,
  facts: DoctorReportSuppressionFacts
): DoctorReport {
  const registered = new Set(facts.registeredRuleCodes)
  const suppressed = new Set<Diagnostic>()
  const audits: DoctorSuppressionAudit[] = []
  const entries = facts.scans.flatMap((scan) => scan.directives.map((directive) => ({ scan, directive })))
    .sort((left, right) => compareSuppressionEntries(left.directive, right.directive, root))

  for (const { scan, directive } of entries) {
    const auditDirective = {
      text: directive.text,
      location: suppressionLocation(directive, root),
      ...(directive.mode ? { mode: directive.mode } : {})
    }
    const common = {
      ...(directive.ruleCode ? { ruleCode: directive.ruleCode } : {}),
      ...(directive.reason ? { reason: directive.reason } : {}),
      directive: auditDirective,
      diagnostics: [] as Diagnostic[]
    }

    if (!scan.complete || directive.status === 'invalid' || !directive.ruleCode || !directive.reason
      || !directive.mode || directive.targetLine === undefined) {
      audits.push({
        status: 'invalid',
        ...common,
        message: directive.message ?? 'Suppression ignored because the source could not be parsed completely.'
      })
      continue
    }
    if (!registered.has(directive.ruleCode)) {
      audits.push({
        status: 'invalid',
        ...common,
        message: `Unknown Doctor rule code "${directive.ruleCode}".`
      })
      continue
    }

    const directiveFile = normalizePath(root, directive.file)
    const matches = report.diagnostics.filter((diagnostic) => (
      diagnostic.code === directive.ruleCode
      && diagnostic.primaryLocation?.file === directiveFile
      && diagnostic.primaryLocation.start?.line === directive.targetLine
    ))
    if (matches.length === 0) {
      audits.push({
        status: 'unused',
        ...common,
        message: 'No diagnostic matched this rule and source line.'
      })
      continue
    }
    matches.forEach((diagnostic) => suppressed.add(diagnostic))
    audits.push({ status: 'applied', ...common, diagnostics: matches })
  }

  return {
    ...report,
    diagnostics: report.diagnostics.filter((diagnostic) => !suppressed.has(diagnostic)),
    ...(report.domainCoverage ? {
      domainCoverage: report.domainCoverage.map((coverage) => {
        const suppressedCount = [...suppressed].filter((diagnostic) => (
          (diagnostic.domain ?? 'unclassified') === coverage.domain
        )).length
        if (suppressedCount === 0) return coverage
        return {
          ...coverage,
          diagnosticCount: Math.max(0, coverage.diagnosticCount - suppressedCount),
          suppressedDiagnosticCount: (coverage.suppressedDiagnosticCount ?? 0) + suppressedCount
        }
      })
    } : {}),
    ...((report.suppressionAudit?.length ?? 0) > 0 || audits.length > 0
      ? { suppressionAudit: [...(report.suppressionAudit ?? []), ...audits] }
      : {})
  }
}

function suppressionLocation(directive: SourceSuppressionDirective, root: string): DiagnosticPrimaryLocation {
  const start = directive.location.start
  const end = directive.location.end
  return {
    file: normalizePath(root, directive.file),
    start,
    end,
    precision: 'range'
  }
}

function compareSuppressionEntries(
  left: SourceSuppressionDirective,
  right: SourceSuppressionDirective,
  root: string
) {
  return compareText(normalizePath(root, left.file), normalizePath(root, right.file))
    || left.location.start.line - right.location.start.line
    || left.location.start.column - right.location.start.column
    || compareText(left.text, right.text)
}

function normalizePaths(root: string, paths: readonly string[]) {
  return [...new Set(paths.map((file) => normalizePath(root, file)))].sort(compareText)
}

function normalizePath(root: string, file: string) {
  if (/^<[^>]+>$/.test(file)) return file
  const portable = file.replaceAll('\\', '/')
  const absolute = isAbsolute(portable) ? resolve(portable) : resolve(root, portable)
  const normalized = relative(root, absolute).replaceAll('\\', '/')
  return normalized || '.'
}

function normalizeFactText(value: string, root: string) {
  const portableRoot = root.replaceAll('\\', '/')
  const candidates = new Set([root, portableRoot])
  let normalized = value
  for (const candidate of candidates) {
    if (!candidate) continue
    normalized = normalized.replaceAll(candidate, '<root>')
  }
  return normalized
}

function toArray(value: string | string[] | undefined): readonly string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
  return `{${entries.join(',')}}`
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

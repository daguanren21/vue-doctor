import type { DoctorReport, DiagnosticPrimaryLocation } from './types.js'

export const DOCTOR_REPORT_SCHEMA_VERSION = 1 as const

/** Unversioned reports are legacy v0. Future versions are never interpreted as v0. */
export function getDoctorReportSchemaVersion(value: unknown): 0 | 1 | undefined {
  if (!isRecord(value)) return undefined
  return value.schemaVersion === undefined ? 0 : value.schemaVersion === 1 ? 1 : undefined
}

export function isSupportedDoctorReport(value: unknown): value is DoctorReport {
  const version = getDoctorReportSchemaVersion(value)
  if (version === undefined || !isRecord(value)) return false
  const project = value.project
  const inventory = value.inventory
  const coverage = value.coverage
  if (!isRecord(project) || typeof project.root !== 'string'
    || !['vue2.7', 'vue3', 'unsupported', 'unknown'].includes(String(project.vueFramework))
    || !isStringArray(project.uiLibraries) || !isRecord(inventory) || typeof inventory.root !== 'string'
    || !isRecord(inventory.packages) || !isRecord(coverage) || !isCoverageStatus(coverage.status)
    || !isRecord(coverage.source) || !isCoverageStatus(coverage.source.status)
    || !Number.isInteger(coverage.source.scannedFileCount) || Number(coverage.source.scannedFileCount) < 0
    || !Array.isArray(coverage.source.failedFiles)
    || !coverage.source.failedFiles.every((item: unknown) => isRecord(item)
      && typeof item.file === 'string' && typeof item.message === 'string' && typeof item.block === 'string')
    || !Array.isArray(coverage.componentLibraries) || !coverage.componentLibraries.every(item => isLibraryCoverage(item, version))
    || !optional(coverage.source.discoveryIssues, value => Array.isArray(value) && value.every(item => isRecord(item)
      && typeof item.kind === 'string' && typeof item.path === 'string' && typeof item.message === 'string'))
    || !optional(coverage.source.contextIssues, isContextIssues)
    || !Array.isArray(value.diagnostics)) return false
  if (!value.diagnostics.every(item => isDiagnostic(item, version))
    || !optional(value.checks, isChecks)
    || !optional(value.skippedChecks, input => Array.isArray(input) && input.every(item => isRecord(item)
      && typeof item.ruleCode === 'string' && typeof item.required === 'boolean' && typeof item.reason === 'string'
      && isEvidenceArray(item.evidence, version === 1 ? 1 : 0)))
    || !optional(value.rulePacks, input => Array.isArray(input) && input.every(item => isRecord(item)
      && typeof item.name === 'string' && isCoverageStatus(item.coverageStatus)
      && optional(item.checks, isChecks) && Array.isArray(item.rules) && item.rules.every(isRule)))
    || !optional(value.ruleCatalogs, input => Array.isArray(input) && input.every(item => isRecord(item)
      && typeof item.name === 'string' && Array.isArray(item.rules) && item.rules.every(isRule)))
    || !optional(value.domainCoverage, input => Array.isArray(input) && input.every(item => isRecord(item)
      && typeof item.domain === 'string' && ['complete', 'partial', 'not-covered', 'not-reported'].includes(String(item.status))
      && ['ruleCount', 'diagnosticCount', 'pendingCheckCount', 'unavailableCheckCount', 'unreportedCheckCount', 'inactiveRuleCount']
        .every(key => isCount(item[key]))))
    || !optional(value.projectContext, isProjectContext)
    || !optional(value.suppressionAudit, input => Array.isArray(input) && input.every(item => isRecord(item)
      && ['applied', 'unused', 'invalid'].includes(String(item.status))
      && optional(item.ruleCode, isString) && optional(item.reason, isString) && optional(item.message, isString)
      && isRecord(item.directive) && typeof item.directive.text === 'string'
      && isDiagnosticPrimaryLocation(item.directive.location)
      && optional(item.directive.mode, mode => mode === 'line' || mode === 'next-line')
      && Array.isArray(item.diagnostics) && item.diagnostics.every(finding => isDiagnostic(finding, version))
      && (version === 0 || (item.status === 'invalid' ? item.diagnostics.length === 0 : (typeof item.ruleCode === 'string' && Boolean(item.ruleCode.trim())
        && typeof item.reason === 'string' && Boolean(item.reason.trim())
        && (item.directive.mode === 'line' || item.directive.mode === 'next-line')
        && (item.status === 'applied' ? item.diagnostics.length > 0 : item.diagnostics.length === 0))))))) return false
  if (version === 0) return true
  const run = value.run
  return isRecord(run) && isCoverageStatus(run.status) && isRecord(run.target)
    && ['project', 'scope', 'files'].includes(String(run.target.mode))
    && isStringArray(run.target.scopes) && isStringArray(run.target.files)
    && (run.target.requestedFiles === undefined || isStringArray(run.target.requestedFiles))
    && optional(run.generation, isCount)
}

export function isDiagnosticPrimaryLocation(value: unknown): value is DiagnosticPrimaryLocation {
  if (!isRecord(value) || typeof value.file !== 'string' || !value.file
    || !['file', 'line', 'point', 'range'].includes(String(value.precision))) return false
  if (value.precision === 'file') return value.start === undefined && value.end === undefined
  if (!isPosition(value.start)) return false
  if (value.precision === 'line') return value.end === undefined && value.start.column === undefined
  if (value.start.column === undefined) return false
  if (value.precision === 'point') return value.end === undefined
  if (!isPosition(value.end) || value.end.column === undefined) return false
  return value.end.line > value.start.line
    || (value.end.line === value.start.line && value.end.column >= value.start.column)
}

function isDiagnostic(value: unknown, version: 0 | 1): boolean {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
    && ['info', 'warning', 'error'].includes(String(value.severity))
    && ['low', 'medium', 'high'].includes(String(value.confidence))
    && optional(value.file, isString) && optional(value.rulePack, isString) && optional(value.tags, isStringArray)
    && isEvidenceArray(value.evidence, version === 1 ? 1 : 0) && Array.isArray(value.fixes)
    && value.fixes.every(item => isRecord(item) && typeof item.title === 'string'
      && optional(item.description, isString) && optional(item.kind, kind => kind === 'suggestion'))
    && optional(value.primaryLocation, isDiagnosticPrimaryLocation)
    && optional(value.edits, input => Array.isArray(input) && input.every(edit => isRecord(edit)
      && typeof edit.file === 'string' && typeof edit.newText === 'string'
      && isDiagnosticPrimaryLocation({ file: edit.file, precision: 'range', start: edit.start, end: edit.end })))
    && (version === 0 || (typeof value.id === 'string' && /^vd1:[a-f0-9]{32}$/.test(value.id)))
}

function isEvidenceArray(value: unknown, minimumCoordinate = 0): boolean {
  return Array.isArray(value) && value.every(item => isRecord(item) && typeof item.kind === 'string'
    && optional(item.file, isString) && optional(item.message, isString)
    && ['line', 'column', 'endLine', 'endColumn'].every(key => optional(item[key], input => Number.isInteger(input) && Number(input) >= minimumCoordinate))
    && optional(item.git, git => isRecord(git) && typeof git.commit === 'string' && typeof git.authorName === 'string'))
}

function isChecks(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => isRecord(item) && typeof item.ruleCode === 'string'
    && ['checked', 'partial', 'not-applicable', 'unavailable', 'manual', 'runtime', 'policy-pending', 'disabled'].includes(String(item.status))
    && optional(item.rulePack, isString) && optional(item.reason, isString) && optional(item.files, isCount))
}

function isRule(value: unknown): boolean {
  return isRecord(value) && typeof value.code === 'string' && typeof value.title === 'string'
    && typeof value.description === 'string' && optional(value.tags, isStringArray) && optional(value.standards, isStringArray)
}

function isLibraryCoverage(value: unknown, version: 0 | 1): boolean {
  return isRecord(value) && isRecord(value.package) && typeof value.package.canonicalName === 'string'
    && typeof value.package.dependencyName === 'string' && isCoverageStatus(value.status)
    && isEvidenceArray(value.contractSources, version === 1 ? 1 : 0) && isRecord(value.dimensions)
    && ['props', 'events', 'models', 'slots'].every(key => ['known', 'partial', 'unknown'].includes(String((value.dimensions as Record<string, unknown>)[key])))
    && Array.isArray(value.problems) && value.problems.every(item => isRecord(item)
      && typeof item.code === 'string' && typeof item.message === 'string' && isEvidenceArray(item.evidence, version === 1 ? 1 : 0))
}

function isContextIssues(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => isRecord(item) && typeof item.code === 'string'
    && typeof item.message === 'string' && optional(item.file, isString) && optional(item.targetFiles, isStringArray))
}

function isProjectContext(value: unknown): boolean {
  return isRecord(value) && typeof value.root === 'string' && isStringArray(value.files) && isContextIssues(value.issues)
    && Array.isArray(value.packages) && value.packages.every(item => isRecord(item) && typeof item.root === 'string'
      && isRecord(item.inventory) && isRecord(item.inventory.packages) && isStringArray(item.targetFiles))
    && Array.isArray(value.applications) && value.applications.every(item => isRecord(item)
      && typeof item.id === 'string' && typeof item.entryFile === 'string' && typeof item.packageRoot === 'string'
      && ['vue3', 'vue2.7'].includes(String(item.framework)) && isStringArray(item.rootComponentFiles)
      && isStringArray(item.reachableFiles) && Array.isArray(item.plugins) && item.plugins.every(plugin => isRecord(plugin)
        && typeof plugin.file === 'string' && typeof plugin.localName === 'string' && isRecord(plugin.package)
        && typeof plugin.package.packageName === 'string' && typeof plugin.package.specifier === 'string'))
}

function optional(value: unknown, predicate: (value: unknown) => boolean): boolean {
  return value === undefined || predicate(value)
}

function isString(value: unknown): boolean { return typeof value === 'string' }
function isCount(value: unknown): boolean { return Number.isInteger(value) && Number(value) >= 0 }

function isPosition(value: unknown): value is { line: number; column?: number } {
  return isRecord(value) && Number.isInteger(value.line) && Number(value.line) >= 1
    && (value.column === undefined || (Number.isInteger(value.column) && Number(value.column) >= 1))
}

function isCoverageStatus(value: unknown): boolean {
  return value === 'complete' || value === 'partial' || value === 'blocked'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

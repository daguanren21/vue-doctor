import type { DoctorRuleCheck, DoctorRuleDefinition, DoctorRulePackReport } from './rule-packs.js'
import type { CoverageStatus, Diagnostic, SkippedCheck } from './types.js'

export const doctorDiagnosticDomains = [
  'component-library', 'styles', 'interaction', 'vue', 'vite', 'conventions', 'unclassified'
] as const

export type DoctorDiagnosticDomain = typeof doctorDiagnosticDomains[number]
export type DoctorDomainCoverageStatus = 'not-covered' | 'not-reported' | 'partial' | 'complete'

export interface DoctorRuleCatalog {
  name: string
  rules: readonly DoctorRuleDefinition[]
}

export interface DoctorDomainCoverage {
  domain: DoctorDiagnosticDomain
  status: DoctorDomainCoverageStatus
  ruleCount: number
  diagnosticCount: number
  suppressedDiagnosticCount?: number
  pendingCheckCount: number
  unavailableCheckCount: number
  unreportedCheckCount: number
  inactiveRuleCount: number
}

export function isDoctorDiagnosticDomain(value: unknown): value is DoctorDiagnosticDomain {
  return typeof value === 'string' && doctorDiagnosticDomains.includes(value as DoctorDiagnosticDomain)
}

export function applyDoctorRuleMetadata(
  diagnostics: readonly Diagnostic[],
  catalogs: readonly DoctorRuleCatalog[]
): Diagnostic[] {
  const definitions = new Map(catalogs.flatMap((catalog) => catalog.rules.map((rule) => [
    rule.code, { rule, rulePack: catalog.name }
  ] as const)))
  return diagnostics.map((diagnostic) => {
    const definition = definitions.get(diagnostic.code)
    return {
      ...diagnostic,
      domain: definition?.rule.domain ?? 'unclassified',
      tags: [...new Set(definition?.rule.tags ?? [])],
      ...(definition ? { rulePack: definition.rulePack } : {})
    }
  })
}

export function createDoctorDomainCoverage(options: {
  catalogs: readonly DoctorRuleCatalog[]
  diagnostics: readonly Diagnostic[]
  skippedChecks: readonly SkippedCheck[]
  checks?: readonly DoctorRuleCheck[]
  rulePacks?: readonly DoctorRulePackReport[]
  sourceStatus?: CoverageStatus
}): DoctorDomainCoverage[] {
  const definitions = options.catalogs.flatMap((catalog) => catalog.rules)
  const checks = new Map([...(options.rulePacks?.flatMap((pack) => pack.checks ?? []) ?? []), ...(options.checks ?? [])]
    .map((check) => [check.ruleCode, check]))
  const requiredSkips = new Set(options.skippedChecks.filter((skip) => skip.required).map((skip) => skip.ruleCode))
  return doctorDiagnosticDomains.map((domain) => {
    const rules = definitions.filter((rule) => (rule.domain ?? 'unclassified') === domain)
    const diagnosticCount = options.diagnostics.filter((diagnostic) => (diagnostic.domain ?? 'unclassified') === domain).length
    let pendingCheckCount = 0
    let unavailableCheckCount = 0
    let unreportedCheckCount = 0
    let inactiveRuleCount = 0
    for (const rule of rules) {
      const check = checks.get(rule.code)
      if (check?.status === 'disabled' || check?.status === 'not-applicable') inactiveRuleCount++
      else if (requiredSkips.has(rule.code) || check?.status === 'unavailable' || check?.status === 'partial') unavailableCheckCount++
      else if (check && ['manual', 'runtime', 'policy-pending'].includes(check.status)) pendingCheckCount++
      else if (!check) unreportedCheckCount++
    }
    const incomplete = unavailableCheckCount > 0 || pendingCheckCount > 0
      || (rules.length > 0 && options.sourceStatus !== undefined && options.sourceStatus !== 'complete')
    const status: DoctorDomainCoverageStatus = rules.length === 0 || inactiveRuleCount === rules.length
      ? 'not-covered'
      : incomplete ? 'partial' : unreportedCheckCount > 0 ? 'not-reported' : 'complete'
    return { domain, status, ruleCount: rules.length, diagnosticCount, pendingCheckCount, unavailableCheckCount, unreportedCheckCount, inactiveRuleCount }
  })
}

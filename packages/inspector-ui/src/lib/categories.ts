import { doctorDiagnosticDomains, isDoctorDiagnosticDomain } from '@vue-doctor/core/domains'
import type { Diagnostic, DoctorDiagnosticDomain } from '@vue-doctor/core'

export type DiagnosticCategory = DoctorDiagnosticDomain
export const diagnosticCategoryOrder = doctorDiagnosticDomains

export type CategoryFilter = DiagnosticCategory | 'all'

/** Style/suggestion rules that are useful but noisy for first-pass triage. */
const STYLE_SUGGESTION_CODES = new Set([
  'vue-prefer-use-template-ref',
  'vue-prefer-define-model'
])

const CATEGORY_ORDER = new Map(diagnosticCategoryOrder.map((domain, index) => [domain, index]))

const SEVERITY_ORDER: Record<Diagnostic['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2
}

export function categoryForDiagnostic(item: Diagnostic): DiagnosticCategory {
  if (isDoctorDiagnosticDomain(item.domain)) return item.domain
  // Older reports predate catalog metadata.
  if (item.code.startsWith('vue-') || item.code.startsWith('vue2-')) return 'vue'
  if (item.code.startsWith('component-') || item.code.startsWith('component-library-')) {
    return 'component-library'
  }
  return 'unclassified'
}

export function isStyleSuggestion(item: Diagnostic): boolean {
  return STYLE_SUGGESTION_CODES.has(item.code)
}

export function packageNameFromDiagnostic(item: Diagnostic): string | null {
  return item.message.match(/ from (.+?)@[^@ ]+/)?.[1]
    ?? item.message.match(/ from (.+?) does not/)?.[1]
    ?? null
}

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  // Correctness before style, then category, severity, code.
  const styleDiff = Number(isStyleSuggestion(a)) - Number(isStyleSuggestion(b))
  if (styleDiff !== 0) return styleDiff
  const categoryDiff = CATEGORY_ORDER.get(categoryForDiagnostic(a))! - CATEGORY_ORDER.get(categoryForDiagnostic(b))!
  if (categoryDiff !== 0) return categoryDiff
  const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  if (severityDiff !== 0) return severityDiff
  return a.code.localeCompare(b.code)
}

export function matchesPackageFilter(item: Diagnostic, packageName: string | null): boolean {
  if (!packageName) return true
  const extracted = packageNameFromDiagnostic(item)
  if (extracted === packageName) return true
  return item.message.includes(`${packageName}@`) || item.message.includes(`${packageName} `)
}

import { computed, reactive, ref, type Ref } from 'vue'
import type { Diagnostic, DoctorReport, DiagnosticSeverity } from '@vue-doctor/core'
import {
  categoryForDiagnostic,
  compareDiagnostics,
  isStyleSuggestion,
  matchesPackageFilter,
  packageNameFromDiagnostic,
  type CategoryFilter,
  type DiagnosticCategory
} from '../lib/categories'

export type SeverityFilter = DiagnosticSeverity | 'all'
export type { CategoryFilter, DiagnosticCategory }

export function useInspectorFilters(report: Readonly<Ref<DoctorReport | null>>) {
  const query = ref('')
  const severity = ref<SeverityFilter>('all')
  // Default to all categories; search + sidebar params refine the list.
  const category = ref<CategoryFilter>('all')
  // Style suggestions (prefer-use-template-ref / prefer-define-model) are hidden by default.
  const includeStyleSuggestions = ref(false)
  const filters = reactive<{ rule: string | null; package: string | null; source: string | null }>({
    rule: null,
    package: null,
    source: null
  })
  const diagnostics = computed(() => report.value?.diagnostics ?? [])

  const queryTokens = computed(() => tokenizeQuery(query.value))

  const visibleDiagnostics = computed(() => {
    return diagnostics.value
      .filter((item) => matchesFilters(item, {
        severity: severity.value,
        category: category.value,
        includeStyleSuggestions: includeStyleSuggestions.value,
        packageName: filters.package,
        source: filters.source,
        rule: filters.rule,
        tokens: queryTokens.value
      }))
      .slice()
      .sort(compareDiagnostics)
  })

  const packageValues = computed(() =>
    [...new Set(
      diagnostics.value
        .filter((item) => matchesFilters(item, {
          severity: severity.value,
          category: category.value,
          includeStyleSuggestions: includeStyleSuggestions.value,
          packageName: null,
          source: filters.source,
          rule: filters.rule,
          tokens: queryTokens.value
        }))
        .map((item) => packageNameFromDiagnostic(item))
        .filter(Boolean) as string[]
    )].sort()
  )

  const sourceValues = computed(() =>
    [...new Set(
      diagnostics.value
        .filter((item) => matchesFilters(item, {
          severity: severity.value,
          category: category.value,
          includeStyleSuggestions: includeStyleSuggestions.value,
          packageName: filters.package,
          source: null,
          rule: filters.rule,
          tokens: queryTokens.value
        }))
        .map((item) => item.file)
        .filter(Boolean) as string[]
    )].sort()
  )

  const styleSuggestionCount = computed(() =>
    diagnostics.value.filter((item) =>
      isStyleSuggestion(item)
      && matchesFilters(item, {
        severity: severity.value,
        category: category.value,
        includeStyleSuggestions: true,
        packageName: filters.package,
        source: filters.source,
        rule: filters.rule,
        tokens: queryTokens.value
      })
    ).length
  )

  const hasActiveFilters = computed(() =>
    query.value.trim().length > 0
    || severity.value !== 'all'
    || category.value !== 'all'
    || filters.rule !== null
    || filters.package !== null
    || filters.source !== null
  )

  function clearFilters() {
    query.value = ''
    severity.value = 'all'
    category.value = 'all'
    // Keep style-suggestion preference; it is a view toggle, not a transient facet.
    filters.rule = null
    filters.package = null
    filters.source = null
  }

  function countFor(value: SeverityFilter) {
    return diagnostics.value.filter((item) => matchesFilters(item, {
      severity: value,
      category: category.value,
      includeStyleSuggestions: includeStyleSuggestions.value,
      packageName: filters.package,
      source: filters.source,
      rule: filters.rule,
      tokens: queryTokens.value
    })).length
  }

  function countForCategory(value: CategoryFilter) {
    return diagnostics.value.filter((item) => matchesFilters(item, {
      severity: severity.value,
      category: value,
      includeStyleSuggestions: includeStyleSuggestions.value,
      packageName: filters.package,
      source: filters.source,
      rule: filters.rule,
      tokens: queryTokens.value
    })).length
  }

  return {
    query,
    severity,
    category,
    includeStyleSuggestions,
    filters,
    diagnostics,
    visibleDiagnostics,
    packageValues,
    sourceValues,
    styleSuggestionCount,
    hasActiveFilters,
    countFor,
    countForCategory,
    clearFilters
  }
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function diagnosticSearchText(item: Diagnostic): string {
  const fixText = (item.fixes ?? [])
    .flatMap((fix) => [fix.title, fix.description ?? ''])
    .join(' ')
  const evidenceText = (item.evidence ?? [])
    .flatMap((entry) => [entry.message ?? '', entry.file ?? '', entry.kind ?? ''])
    .join(' ')

  return [
    item.code,
    item.message,
    item.file ?? '',
    item.severity,
    categoryForDiagnostic(item),
    item.rulePack ?? '',
    ...(item.tags ?? []),
    fixText,
    evidenceText
  ].join(' ').toLowerCase()
}

function matchesQuery(item: Diagnostic, tokens: string[]): boolean {
  if (tokens.length === 0) {
    return true
  }
  const haystack = diagnosticSearchText(item)
  return tokens.every((token) => haystack.includes(token))
}

function matchesFilters(
  item: Diagnostic,
  options: {
    severity: SeverityFilter
    category: CategoryFilter
    includeStyleSuggestions: boolean
    packageName: string | null
    source: string | null
    rule: string | null
    tokens: string[]
  }
): boolean {
  if (options.severity !== 'all' && item.severity !== options.severity) {
    return false
  }
  if (options.category !== 'all' && categoryForDiagnostic(item) !== options.category) {
    return false
  }
  if (!options.includeStyleSuggestions && isStyleSuggestion(item)) {
    return false
  }
  if (options.source && item.file !== options.source) {
    return false
  }
  if (options.rule && item.code !== options.rule) {
    return false
  }
  if (!matchesPackageFilter(item, options.packageName)) {
    return false
  }
  return matchesQuery(item, options.tokens)
}

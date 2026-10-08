import { describe, expect, test } from 'vitest'
import { ref } from 'vue'
import type { Diagnostic, DoctorReport } from '@vue-doctor/core'
import { useInspectorFilters } from './useInspectorFilters'

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'vue-security-restrict-v-html',
    severity: 'error',
    message: 'v-html can execute untrusted markup. Only render sanitized or trusted HTML here.',
    file: '/project/src/App.vue',
    evidence: [{
      kind: 'vue-source',
      file: '/project/src/App.vue',
      line: 1,
      message: 'v-html usage'
    }],
    fixes: [{
      title: 'Remove v-html or sanitize the HTML before rendering it.'
    }],
    confidence: 'high',
    ...overrides
  }
}

function report(items: Diagnostic[]): DoctorReport {
  return {
    project: { root: '/project', vueFramework: 'vue3', uiLibraries: [] },
    inventory: {
      root: '/project',
      packages: {}
    },
    coverage: {
      status: 'complete',
      source: {
        status: 'complete',
        scannedFileCount: 1,
        failedFiles: []
      },
      componentLibraries: []
    },
    diagnostics: items
  }
}

describe('useInspectorFilters', () => {
  test('finds custom rules through domain, cross-topic tags and provenance without duplicate counts', () => {
    const item = diagnostic({ code: 'team/interaction', domain: 'interaction', tags: ['styles', 'keyboard'], rulePack: 'team' })
    const { category, query, visibleDiagnostics, countForCategory } = useInspectorFilters(ref(report([item])))
    query.value = 'styles keyboard team'
    expect(visibleDiagnostics.value).toEqual([item])
    expect(countForCategory('interaction')).toBe(1)
    expect(countForCategory('styles')).toBe(0)
    category.value = 'styles'
    expect(visibleDiagnostics.value).toHaveLength(0)
  })
  test('matches remediation fix text in search queries', () => {
    const source = ref(report([
      diagnostic(),
      diagnostic({
        code: 'vue-prefer-use-template-ref',
        severity: 'info',
        message: 'prefer useTemplateRef',
        fixes: [{ title: 'Use useTemplateRef()' }]
      })
    ]))
    const { query, includeStyleSuggestions, category, visibleDiagnostics, countFor, countForCategory } = useInspectorFilters(source)

    category.value = 'all'
    includeStyleSuggestions.value = true
    query.value = 'Remove v-html or sanitize the HTML before rendering it'

    expect(visibleDiagnostics.value).toHaveLength(1)
    expect(visibleDiagnostics.value[0]?.code).toBe('vue-security-restrict-v-html')
    expect(countFor('error')).toBe(1)
    expect(countFor('info')).toBe(0)
    expect(countForCategory('vue')).toBe(1)
    expect(countForCategory('all')).toBe(1)
  })

  test('sidebar counts follow the active search query', () => {
    const source = ref(report([
      diagnostic({ severity: 'error' }),
      diagnostic({
        code: 'component-prop-unsupported',
        severity: 'warning',
        message: 'ExampleButton from example-ui@1.0.0 does not declare prop "ghost".',
        fixes: [{ title: 'Remove ghost prop' }]
      }),
      diagnostic({
        code: 'vue-prefer-define-model',
        severity: 'info',
        message: 'prefer defineModel',
        fixes: [{ title: 'Use defineModel()' }]
      })
    ]))
    const {
      query,
      category,
      includeStyleSuggestions,
      countFor,
      countForCategory,
      styleSuggestionCount
    } = useInspectorFilters(source)

    category.value = 'all'
    includeStyleSuggestions.value = false
    query.value = 'example-ui ghost'

    expect(countFor('all')).toBe(1)
    expect(countFor('warning')).toBe(1)
    expect(countFor('error')).toBe(0)
    expect(countForCategory('component-library')).toBe(1)
    expect(countForCategory('vue')).toBe(0)
    expect(styleSuggestionCount.value).toBe(0)
  })

  test('style suggestion toggle does not surface clear-filters', () => {
    const source = ref(report([
      diagnostic({
        code: 'vue-prefer-use-template-ref',
        severity: 'info',
        message: 'prefer useTemplateRef',
        fixes: [{ title: 'Use useTemplateRef()' }]
      })
    ]))
    const { includeStyleSuggestions, hasActiveFilters, clearFilters, category, severity } = useInspectorFilters(source)

    expect(hasActiveFilters.value).toBe(false)

    includeStyleSuggestions.value = true
    expect(hasActiveFilters.value).toBe(false)

    category.value = 'vue'
    expect(hasActiveFilters.value).toBe(true)

    clearFilters()
    expect(category.value).toBe('all')
    expect(severity.value).toBe('all')
    expect(includeStyleSuggestions.value).toBe(true)
    expect(hasActiveFilters.value).toBe(false)
  })
})

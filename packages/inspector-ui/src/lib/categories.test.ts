import { describe, expect, test } from 'vitest'
import type { Diagnostic } from '@vue-doctor/core'
import {
  categoryForDiagnostic,
  compareDiagnostics,
  isStyleSuggestion,
  matchesPackageFilter,
  packageNameFromDiagnostic
} from './categories'

function diagnostic(partial: Partial<Diagnostic> & Pick<Diagnostic, 'code' | 'message' | 'severity'>): Diagnostic {
  return {
    evidence: [],
    fixes: [],
    confidence: 'high',
    ...partial
  }
}

describe('categoryForDiagnostic', () => {
  test('prefers catalog domains and supports old Vue 2 reports', () => {
    expect(categoryForDiagnostic(diagnostic({ code: 'team/example', domain: 'styles', message: '', severity: 'warning' }))).toBe('styles')
    expect(categoryForDiagnostic(diagnostic({ code: 'component-example', domain: 'interaction', message: '', severity: 'warning' }))).toBe('interaction')
    expect(categoryForDiagnostic(diagnostic({ code: 'vue2-example', message: '', severity: 'warning' }))).toBe('vue')
  })
  test('classifies vue and component diagnostics', () => {
    expect(categoryForDiagnostic(diagnostic({
      code: 'vue-security-restrict-v-html',
      severity: 'warning',
      message: 'v-html'
    }))).toBe('vue')
    expect(categoryForDiagnostic(diagnostic({
      code: 'component-attribute-unverified',
      severity: 'info',
      message: 'ElTag from example-ui@3.1.1 does not declare attribute "index"'
    }))).toBe('component-library')
    expect(categoryForDiagnostic(diagnostic({
      code: 'coverage-something',
      severity: 'info',
      message: 'other'
    }))).toBe('unclassified')
  })
})

describe('isStyleSuggestion', () => {
  test('marks prefer-use-template-ref and prefer-define-model as style', () => {
    expect(isStyleSuggestion(diagnostic({
      code: 'vue-prefer-use-template-ref',
      severity: 'info',
      message: 'style'
    }))).toBe(true)
    expect(isStyleSuggestion(diagnostic({
      code: 'vue-prefer-define-model',
      severity: 'warning',
      message: 'style'
    }))).toBe(true)
    expect(isStyleSuggestion(diagnostic({
      code: 'vue-security-restrict-v-html',
      severity: 'error',
      message: 'correctness'
    }))).toBe(false)
  })
})

describe('compareDiagnostics', () => {
  test('orders correctness before style suggestions', () => {
    const style = diagnostic({ code: 'vue-prefer-use-template-ref', severity: 'error', message: 'a' })
    const correctness = diagnostic({ code: 'vue-security-restrict-v-html', severity: 'info', message: 'b' })
    expect(compareDiagnostics(correctness, style)).toBeLessThan(0)
    expect([style, correctness].sort(compareDiagnostics).map((item) => item.code)).toEqual([
      'vue-security-restrict-v-html',
      'vue-prefer-use-template-ref'
    ])
  })
})

describe('packageNameFromDiagnostic', () => {
  test('extracts package names and matches package filters', () => {
    const item = diagnostic({
      code: 'component-attribute-unverified',
      severity: 'info',
      message: 'ElTag from example-ui@3.1.1 does not declare attribute "index"'
    })
    expect(packageNameFromDiagnostic(item)).toBe('example-ui')
    expect(matchesPackageFilter(item, 'example-ui')).toBe(true)
    expect(matchesPackageFilter(item, 'vuedraggable')).toBe(false)
  })
})

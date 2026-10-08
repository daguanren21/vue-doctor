import { describe, expect, test } from 'vitest'
import {
  createDoctorRuleRegistry,
  isDoctorRuleApplicable,
  isDoctorRuleEnabled,
  resolveDoctorRuleSeverity,
  validateConfiguredDoctorRuleCodes,
  validateDoctorRulePacks
} from './rule-packs.js'
import type { DoctorRuleDefinition } from './rule-packs.js'

function rule(overrides: Partial<DoctorRuleDefinition> = {}): DoctorRuleDefinition {
  return {
    code: 'example/rule',
    title: 'Example rule',
    description: 'Example description.',
    ...overrides
  }
}

describe('Doctor rule registry', () => {
  test('rejects duplicate codes across definition groups', () => {
    expect(() => createDoctorRuleRegistry([[rule()], [rule()]])).toThrow(
      'Duplicate Doctor rule code: example/rule'
    )
  })

  test('rejects every unknown configured code, including disabled entries', () => {
    const registry = createDoctorRuleRegistry([[
      rule(),
      rule({ code: 'team/known' })
    ]])

    expect(() => validateConfiguredDoctorRuleCodes({
      'team/known': 'warning',
      'misspelled/two': 'off',
      'misspelled/one': 'error'
    }, registry)).toThrow(
      'Unknown Doctor rule codes in config "rules": misspelled/one, misspelled/two.'
    )
    expect(() => validateConfiguredDoctorRuleCodes({ 'team/known': 'off' }, registry)).not.toThrow()
  })

  test('keeps legacy rules enabled while supporting metadata defaults and explicit settings', () => {
    expect(isDoctorRuleEnabled(rule(), {})).toBe(true)
    expect(isDoctorRuleEnabled(rule({ defaultEnabled: false }), {})).toBe(false)
    expect(isDoctorRuleEnabled(rule({ defaultEnabled: false }), { 'example/rule': 'info' })).toBe(true)
    expect(isDoctorRuleEnabled(rule({ defaultEnabled: true }), { 'example/rule': 'off' })).toBe(false)
  })

  test('resolves severity metadata without changing explicit policy', () => {
    const definition = rule({ defaultSeverity: 'warning' })
    expect(resolveDoctorRuleSeverity(definition, {})).toBe('warning')
    expect(resolveDoctorRuleSeverity(definition, { 'example/rule': 'error' })).toBe('error')
    expect(resolveDoctorRuleSeverity(definition, { 'example/rule': 'off' })).toBeUndefined()
  })

  test('applies strict Vue major and minor constraints for generic rule packs', () => {
    const vue2Only = rule({ applicability: { vue: { only: 2 } } })
    const vue35 = rule({ applicability: { vue: { only: 3, minimumMinor: 5 } } })

    expect(isDoctorRuleApplicable(vue2Only, { vueVersion: '2.7.16' })).toBe(true)
    expect(isDoctorRuleApplicable(vue2Only, { vueVersion: '3.5.39' })).toBe(false)
    expect(isDoctorRuleApplicable(vue2Only, { vueVersion: '4.0.0' })).toBe(false)
    expect(isDoctorRuleApplicable(vue35, { vueVersion: '3.4.38' })).toBe(false)
    expect(isDoctorRuleApplicable(vue35, { vueVersion: '3.5.0' })).toBe(true)
    expect(isDoctorRuleApplicable(vue35, { assumeLatestVueVersion: false })).toBe(false)
    expect(isDoctorRuleApplicable(vue35, {})).toBe(true)
    expect(isDoctorRuleApplicable(rule({ applicability: {} }), { assumeLatestVueVersion: false })).toBe(true)
    expect(isDoctorRuleApplicable(rule({ applicability: { vue: {} } }), { assumeLatestVueVersion: false })).toBe(true)
  })

  test('accepts executable metadata declared by external rule packs', () => {
    const packs: unknown = [{
      name: 'example',
      rules: [rule({
        defaultEnabled: false,
        defaultSeverity: 'info',
        applicability: { vue: { only: 3, minimumMinor: 4 } },
        help: { problem: 'A concrete problem.', remediation: 'A concrete remediation.' },
        requires: {
          sourceBlocks: ['template'],
          allSourceBlocks: ['script'],
          vueVersion: 'known',
          ownership: 'matched',
          contractDimensions: ['props'],
          acceptance: 'known',
          signature: 'exact'
        }
      })],
      run: () => ({ diagnostics: [], skippedChecks: [] })
    }]

    expect(() => validateDoctorRulePacks(packs)).not.toThrow()
  })

  test.each([
    ['verification', { verification: 'typo' }],
    ['category', { category: {} }],
    ['standards', { standards: [''] }],
    ['standards type', { standards: 'WCAG' }],
    ['domain', { domain: 'html' }],
    ['tags', { tags: [''] }],
    ['tags type', { tags: 'styles' }],
    ['defaultEnabled', { defaultEnabled: 'yes' }],
    ['defaultSeverity', { defaultSeverity: 'off' }],
    ['help', { help: { problem: 'Missing remediation.' } }],
    ['sourceBlocks', { requires: { sourceBlocks: ['style'] } }],
    ['allSourceBlocks', { requires: { allSourceBlocks: ['style'] } }],
    ['Vue version capability', { requires: { vueVersion: 'guessed' } }],
    ['ownership', { requires: { ownership: 'ambiguous' } }],
    ['contractDimensions', { requires: { contractDimensions: ['attrs'] } }],
    ['acceptance', { requires: { acceptance: 'maybe' } }],
    ['signature', { requires: { signature: 'compatible' } }],
    ['applicability object', { applicability: 'vue3' }],
    ['Vue only', { applicability: { vue: { only: 4 } } }],
    ['negative minimumMinor', { applicability: { vue: { minimumMinor: -1 } } }],
    ['fractional minimumMinor', { applicability: { vue: { minimumMinor: 3.5 } } }],
    ['null minimumMinor', { applicability: { vue: { minimumMinor: null } } }],
    ['string minimumMinor', { applicability: { vue: { minimumMinor: '3' } } }],
    ['Vue 2 minimumMinor', { applicability: { vue: { only: 2, minimumMinor: 7 } } }]
  ])('rejects invalid external %s metadata', (_label, metadata) => {
    const packs: unknown = [{
      name: 'example',
      rules: [{ ...rule(), ...metadata }],
      run: () => ({ diagnostics: [], skippedChecks: [] })
    }]

    expect(() => validateDoctorRulePacks(packs)).toThrow('Rule definitions in example')
  })

  test.each(['css', '.', '.css/path', ' .css', 12])('rejects invalid source extension %s before running a pack', extension => {
    expect(() => validateDoctorRulePacks([{ name: 'example', rules: [rule()],
      sourceExtensions: [extension], run: () => ({ diagnostics: [], skippedChecks: [] }) }])).toThrow('dot-prefixed')
  })
})

import { describe, expect, test } from 'vitest'
import { componentLibraryRuleDefinitions } from '@vue-doctor/rule-pack-component-library/rules'
import { vueRuleDefinitions } from '@vue-doctor/rule-pack-vue/rules'
import { eslintRuleDefinitions } from '@vue-doctor/rule-pack-eslint'
import { getDiagnosticReference, listDiagnosticReferences } from './index.js'

describe('Diagnostic Reference', () => {
  test('preserves catalog identity, help text, and ordering', () => {
    const expected = [
      ...vueRuleDefinitions.map((rule) => ({ rulePack: 'vue', rule })),
      ...componentLibraryRuleDefinitions.map((rule) => ({ rulePack: 'component-library', rule })),
      ...eslintRuleDefinitions.map(rule => ({ rulePack: 'eslint', rule }))
    ].map(({ rulePack, rule }) => ({
      code: rule.code,
      rulePack,
      title: rule.title,
      problem: rule.help!.problem,
      remediation: rule.help!.remediation,
      domain: rule.domain,
      tags: rule.tags
    }))

    expect(listDiagnosticReferences()).toHaveLength(86 + eslintRuleDefinitions.length)
    expect(listDiagnosticReferences()).toEqual(expected)
  })

  test('lists stable component-library diagnostic codes', () => {
    expect(listDiagnosticReferences()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'component-event-payload-changed',
        rulePack: 'component-library',
        title: 'Component event payload changed'
      }),
      expect.objectContaining({
        code: 'component-prop-unsupported',
        rulePack: 'component-library',
        title: 'Component prop is unsupported'
      }),
      expect.objectContaining({
        code: 'component-prop-required-missing',
        rulePack: 'component-library',
        title: 'Required component prop is missing'
      }),
      expect.objectContaining({
        code: 'component-prop-type-mismatch',
        rulePack: 'component-library',
        title: 'Component prop type does not match'
      }),
      expect.objectContaining({
        code: 'component-attribute-unverified',
        rulePack: 'component-library',
        title: 'Component attribute support is unverified'
      }),
      expect.objectContaining({
        code: 'component-model-unsupported',
        rulePack: 'component-library',
        title: 'Component v-model contract is unsupported'
      }),
      expect.objectContaining({
        code: 'component-slot-unsupported',
        rulePack: 'component-library',
        title: 'Component slot is unsupported'
      }),
      expect.objectContaining({
        code: 'component-event-unsupported',
        rulePack: 'component-library',
        title: 'Component event is unsupported'
      })
    ]))
  })

  test('returns an explanation for a known diagnostic code', () => {
    expect(getDiagnosticReference('component-event-payload-changed')).toEqual(expect.objectContaining({
      code: 'component-event-payload-changed',
      problem: expect.stringContaining('requires more arguments'),
      remediation: expect.stringContaining('parameter names alone')
    }))
    expect(getDiagnosticReference('component-model-unsupported')).toEqual(expect.objectContaining({
      code: 'component-model-unsupported',
      problem: expect.stringContaining('v-model'),
      remediation: expect.stringContaining('model argument')
    }))
    expect(getDiagnosticReference('component-slot-unsupported')).toEqual(expect.objectContaining({
      code: 'component-slot-unsupported',
      problem: expect.stringContaining('slot'),
      remediation: expect.stringContaining('installed component metadata')
    }))
  })
  test('returns references for version-specific Vue API diagnostics', () => {
    expect(getDiagnosticReference('vue-api-version-unsupported')).toEqual(expect.objectContaining({
      code: 'vue-api-version-unsupported',
      rulePack: 'vue',
      remediation: expect.stringContaining('required minor version')
    }))
    expect(getDiagnosticReference('vue2-reactive-root-unsupported')).toEqual(expect.objectContaining({
      code: 'vue2-reactive-root-unsupported',
      problem: expect.stringContaining('Vue 2.7')
    }))
    expect(getDiagnosticReference('vue-use-template-ref-missing')).toEqual(expect.objectContaining({
      code: 'vue-use-template-ref-missing',
      problem: expect.stringContaining('template ref')
    }))
  })
})

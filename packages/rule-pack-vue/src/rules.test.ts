import { isDoctorRuleApplicable } from '@daguanren21/vue-doctor-core'
import { describe, expect, test } from 'vitest'
import { isVueRuleAvailable } from './index.js'
import {
  getVueRuleDefinition,
  getVueRulesForFailedSourceBlock,
  vueRuleDefinitions
} from './rules.js'

describe('Vue rule catalog', () => {
  test('keeps diagnostic codes unambiguous', () => {
    expect(new Set(vueRuleDefinitions.map((rule) => rule.code)).size).toBe(vueRuleDefinitions.length)
  })


  test('declares cross-block and version evidence where diagnostics need it', () => {
    for (const code of [
      'vue-template-shadow',
      'vue-model-on-prop',
      'vue-prefer-use-template-ref',
      'vue-use-template-ref-missing'
    ]) {
      expect(getVueRuleDefinition(code)?.requires).toMatchObject({
        sourceBlocks: ['script', 'script-setup'],
        allSourceBlocks: ['template']
      })
    }

    for (const rule of vueRuleDefinitions) {
      if (rule.requires?.vueVersion === 'known') {
        expect(isVueRuleAvailable(rule.code, undefined, { assumeLatest: false })).toBe(false)
      }
    }
  })

  test('preserves Vue 2, minor-version, unknown, and unsupported-major availability', () => {
    expect(isVueRuleAvailable('vue2-reactive-root-unsupported', '2.7.16')).toBe(true)
    expect(isVueRuleAvailable('vue2-reactive-root-unsupported', '3.3.13')).toBe(false)
    expect(isVueRuleAvailable('vue-prefer-define-model', '3.3.13')).toBe(false)
    expect(isVueRuleAvailable('vue-prefer-define-model', '3.4.38')).toBe(true)
    expect(isVueRuleAvailable('vue-prefer-use-template-ref', '3.4.38')).toBe(false)
    expect(isVueRuleAvailable('vue-prefer-use-template-ref', '3.5.39')).toBe(true)
    expect(isVueRuleAvailable('vue-app-api-misuse', undefined, { assumeLatest: false })).toBe(false)
    expect(isVueRuleAvailable('vue-watch-self-mutation', undefined, { assumeLatest: false })).toBe(false)
    expect(isVueRuleAvailable('vue-watch-derived-state', undefined, { assumeLatest: false })).toBe(true)
    expect(isVueRuleAvailable('vue-app-api-misuse', undefined, { assumeLatest: true })).toBe(true)
    expect(isVueRuleAvailable('vue2-reactive-root-unsupported', undefined, { assumeLatest: true })).toBe(false)

    const vue2Rule = getVueRuleDefinition('vue2-reactive-root-unsupported')!
    expect(isVueRuleAvailable(vue2Rule.code, '4.0.0')).toBe(true)
    expect(isDoctorRuleApplicable(vue2Rule, { vueVersion: '4.0.0' })).toBe(false)
  })

  test('exposes unique failed-block rules without mixing independent parser requirements', () => {
    const templateRules = getVueRulesForFailedSourceBlock('template')
    const scriptRules = getVueRulesForFailedSourceBlock('script')
    const setupRules = getVueRulesForFailedSourceBlock('script-setup')
    expect(new Set(setupRules)).toEqual(new Set(scriptRules))
    for (const [kind, rules] of [['template', templateRules], ['script', scriptRules]] as const) {
      expect(new Set(rules.map((rule) => rule.code)).size).toBe(rules.length)
      for (const rule of rules) {
        expect([
          ...rule.requires?.sourceBlocks ?? [],
          ...rule.requires?.allSourceBlocks ?? []
        ]).toContain(kind)
      }
    }
    expect(templateRules).toContain(getVueRuleDefinition('vue-template-v-for-key'))
    expect(templateRules).not.toContain(getVueRuleDefinition('vue-prop-mutated'))
    expect(scriptRules).toContain(getVueRuleDefinition('vue-prop-mutated'))
    expect(scriptRules).not.toContain(getVueRuleDefinition('vue-template-v-for-key'))
    expect(templateRules).toContain(getVueRuleDefinition('vue-template-shadow'))
    expect(scriptRules).toContain(getVueRuleDefinition('vue-template-shadow'))
  })
})

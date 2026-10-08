import { isDoctorRuleApplicable } from '@vue-doctor/core'
import { describe, expect, test } from 'vitest'
import { isVueRuleAvailable } from './index.js'
import {
  getVueRuleDefinition,
  getVueRulesForFailedSourceBlock,
  vueRuleDefinitions
} from './rules.js'

describe('Vue rule catalog', () => {
  test('declares metadata for every builtin diagnostic exactly once', () => {
    expect(vueRuleDefinitions).toHaveLength(78)
    expect(new Set(vueRuleDefinitions.map((rule) => rule.code)).size).toBe(78)
    for (const rule of vueRuleDefinitions) {
      expect(rule).toMatchObject({
        verification: 'static',
        defaultEnabled: expect.any(Boolean),
        defaultSeverity: expect.stringMatching(/^(info|warning|error)$/),
        requires: {
          sourceBlocks: expect.arrayContaining([
            expect.stringMatching(/^(template|script|script-setup)$/)
          ])
        },
        help: {
          problem: expect.any(String),
          remediation: expect.any(String)
        }
      })
      expect(rule.requires?.sourceBlocks).not.toHaveLength(0)
    }
  })

  test('declares script evidence for rules that do not participate in parse-failure ordering', () => {
    const unordered = vueRuleDefinitions.filter((rule) => (
      !getVueRulesForFailedSourceBlock('template').includes(rule)
      && !getVueRulesForFailedSourceBlock('script').includes(rule)
    ))

    expect(unordered).toHaveLength(29)
    for (const rule of unordered) {
      expect(rule.requires?.sourceBlocks).toEqual(['script', 'script-setup'])
    }
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

    const versionRequired = vueRuleDefinitions
      .filter((rule) => rule.requires?.vueVersion === 'known')
      .map((rule) => rule.code)
    expect(versionRequired).toEqual([
      'vue-watch-self-mutation',
      'vue-watch-async-stale-write',
      'vue-watch-once-unsupported',
      'vue-watch-numeric-deep-unsupported',
      'vue-effect-scope-pause-resume-unsupported',
      'vue-watch-handle-pause-resume-unsupported',
      'vue-api-version-unsupported'
    ])
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

  test('preserves exact parse-failure rule membership and order', () => {
    expect(getVueRulesForFailedSourceBlock('template').map((rule) => rule.code)).toEqual([
      'vue-security-restrict-v-html',
      'vue-template-v-for-key',
      'vue-template-v-for-key-placement',
      'vue-template-v-if-for',
      'vue-template-shadow',
      'vue-html-button-has-type',
      'vue-model-on-prop',
      'vue-model-on-scope-var',
      'vue-if-else-duplicate-key',
      'vue-else-without-if',
      'vue-if-missing-expression',
      'vue-for-missing-expression',
      'vue-invalid-key-nan',
      'vue-v-bind-sync-removed',
      'vue-v-on-native-removed',
      'vue-filters-removed',
      'vue-keepalive-single-child',
      'vue-slot-mixed-usage',
      'vue-slot-duplicate-name',
      'vue-vnode-hook-prefix',
      'vue-data-allow-mismatch-surgical'
    ])
    const scriptRules = [
      'vue-prop-mutated',
      'vue-setup-props-destructure',
      'vue-ref-as-operand',
      'vue-defineprops-watch-getter',
      'vue-watch-require-cleanup',
      'vue-watch-derived-state',
      'vue-watch-reactive-property',
      'vue-watch-self-mutation',
      'vue-watch-async-stale-write',
      'vue-shallow-ref-nested-mutation',
      'vue-reactive-reassignment',
      'vue-readonly-mutation',
      'vue-shallow-reactive-nested-mutation',
      'vue-detached-effect-scope-require-stop',
      'vue-custom-ref-incomplete-contract',
      'vue-to-refs-plain-object',
      'vue-watch-require-post-flush',
      'vue-watch-effect-await-read',
      'vue-onwatcher-cleanup-after-await',
      'vue-lifecycle-require-cleanup',
      'vue-lifecycle-no-mutation-in-onupdated',
      'vue-prefer-use-template-ref',
      'vue-ssr-no-browser-api-in-setup',
      'vue-ssr-no-random-or-local-time-render',
      'vue-prefer-define-model',
      'vue-async-setup-without-suspense',
      'vue-usemodel-undeclared-prop',
      'vue-usemodel-missing-prop',
      'vue-template-shadow'
    ]
    expect(getVueRulesForFailedSourceBlock('script').map((rule) => rule.code)).toEqual(scriptRules)
    expect(getVueRulesForFailedSourceBlock('script-setup').map((rule) => rule.code)).toEqual(scriptRules)
  })
})

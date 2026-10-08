import type {
  ComponentContract,
  ComponentLibraryEvidence,
  ContractKnowledge
} from '@vue-doctor/component-library'
import type { ComponentUsageContractMatch } from '@vue-doctor/rule-pack-component-library'
import type {
  DoctorRuleCheck,
  PackageResolution,
  SkippedCheck
} from '@vue-doctor/core'
import type {
  SourceBlockResult,
  VueComponentUsage,
  VueSourceFileResult,
  VueSourceUsageReport
} from '@vue-doctor/source'
import { analyzeSourceText } from '@vue-doctor/source'
import { describe, expect, test } from 'vitest'
import { createBuiltinDoctorChecks } from './builtin-checks.js'

function source(...files: VueSourceFileResult[]): VueSourceUsageReport {
  return {
    root: '/project',
    files: files.map((file) => file.file),
    components: [],
    globalPlugins: [],
    fileResults: files
  }
}

function file(name: string, blocks: SourceBlockResult[]): VueSourceFileResult {
  return { file: `/project/${name}`, blocks }
}

const availableScript: SourceBlockResult[] = [
  { kind: 'template', status: 'absent' },
  { kind: 'script', status: 'available' },
  { kind: 'script-setup', status: 'absent' }
]

function check(checks: readonly DoctorRuleCheck[], code: string): DoctorRuleCheck {
  const result = checks.find((item) => item.ruleCode === code)
  if (!result) throw new Error(`Missing check ${code}`)
  return result
}

describe('builtin Doctor checks', () => {
  test('records every builtin rule without inventing work for a zero-target scan', () => {
    const result = createBuiltinDoctorChecks({
      source: source(),
      matches: [],
      rules: {}
    })

    expect(result.checks).toHaveLength(86)
    expect(new Set(result.checks.map((item) => item.ruleCode))).toHaveProperty('size', 86)
    expect(result.checks.every((item) => item.status === 'not-applicable' || item.status === 'disabled')).toBe(true)
    expect(result.skippedChecks).toEqual([])
    expect(check(result.checks, 'vue-watch-once-unsupported')).toMatchObject({
      rulePack: 'vue',
      status: 'not-applicable'
    })
  })

  test('distinguishes known applicability across Vue 2.7, 3.4, and 3.5', () => {
    const target = source(file('src/App.ts', availableScript))
    const vue27 = createBuiltinDoctorChecks({ source: target, matches: [], rules: {}, vueVersion: '2.7.16' })
    const vue34 = createBuiltinDoctorChecks({ source: target, matches: [], rules: {}, vueVersion: '3.4.38' })
    const vue35 = createBuiltinDoctorChecks({ source: target, matches: [], rules: {}, vueVersion: '3.5.13' })

    expect(check(vue27.checks, 'vue2-reactive-root-unsupported').status).toBe('checked')
    expect(check(vue34.checks, 'vue2-reactive-root-unsupported').status).toBe('not-applicable')
    expect(check(vue34.checks, 'vue-use-template-ref-missing').status).toBe('not-applicable')
    // Cross-block rules need a template target even when their Vue version is applicable.
    expect(check(vue35.checks, 'vue-use-template-ref-missing').status).toBe('not-applicable')
    expect(check(vue34.checks, 'vue-watch-once-unsupported').status).toBe('checked')
    expect(check(vue35.checks, 'vue-watch-once-unsupported').status).toBe('checked')
  })

  test('marks version-dependent source targets unavailable when their owning Vue version is unknown', () => {
    const result = createBuiltinDoctorChecks({
      source: source(file('src/App.ts', availableScript)),
      matches: [],
      rules: {}
    })

    expect(check(result.checks, 'vue-watch-once-unsupported')).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('Vue version evidence')
    })
    expect(check(result.checks, 'vue-computed-readonly-write')).toMatchObject({
      status: 'checked',
      files: 1
    })
    expect(result.skippedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleCode: 'vue-watch-once-unsupported',
        required: true,
        reason: 'missing-capability'
      })
    ]))
  })

  test('separates a known inapplicable major from an unsupported runtime capability', () => {
    const result = createBuiltinDoctorChecks({
      source: source(file('src/App.ts', availableScript)),
      matches: [],
      rules: {},
      vueVersion: '4.0.0'
    })

    expect(check(result.checks, 'vue-app-api-misuse').status).toBe('not-applicable')
    expect(check(result.checks, 'vue-watch-once-unsupported').status).toBe('unavailable')
    expect(result.skippedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleCode: 'vue-watch-once-unsupported',
        reason: 'unsupported-framework'
      })
    ]))
  })

  test('honors an explicit unknown package version instead of falling back to the root version', () => {
    const unknown = '/project/packages/unknown/App.ts'
    const vue27 = '/project/packages/vue2/App.ts'
    const result = createBuiltinDoctorChecks({
      source: source(
        file('packages/unknown/App.ts', availableScript),
        file('packages/vue2/App.ts', availableScript)
      ),
      matches: [],
      rules: {},
      vueVersion: '3.5.13',
      vueVersions: {
        [unknown]: undefined,
        [vue27]: '2.7.16'
      }
    })

    expect(check(result.checks, 'vue-usemodel-missing-prop').status).toBe('unavailable')
    expect(result.skippedChecks.some((skip) => (
      skip.ruleCode === 'vue-usemodel-missing-prop' && skip.file === unknown
    ))).toBe(true)
  })

  test('keeps partial parse coverage separate from real checked files', () => {
    const good = file('src/Good.ts', availableScript)
    const failed = file('src/Broken.ts', [
      { kind: 'template', status: 'absent' },
      { kind: 'script', status: 'failed', message: 'Unexpected token' },
      { kind: 'script-setup', status: 'absent' }
    ])
    const result = createBuiltinDoctorChecks({
      source: source(good, failed),
      matches: [],
      rules: {},
      vueVersion: '3.5.13'
    })

    expect(check(result.checks, 'vue-computed-readonly-write')).toMatchObject({
      status: 'partial',
      files: 1
    })
    expect(result.skippedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleCode: 'vue-computed-readonly-write',
        file: '/project/src/Broken.ts',
        reason: 'parse-failed'
      })
    ]))
  })

  test('does not turn omitted block kinds in plain script files into unavailable targets', () => {
    const result = createBuiltinDoctorChecks({
      source: source(file('src/plain.ts', [{ kind: 'script', status: 'available' }])),
      matches: [],
      rules: { 'vue-html-button-has-type': 'warning' },
      vueVersion: '3.5.13'
    })

    expect(check(result.checks, 'vue-html-button-has-type')).toMatchObject({
      status: 'not-applicable'
    })
    expect(result.skippedChecks.some((skip) => skip.ruleCode === 'vue-html-button-has-type')).toBe(false)
  })

  test('requires all declared companion blocks for cross-block rules', () => {
    const complete = file('src/Complete.vue', [
      { kind: 'template', status: 'available' },
      { kind: 'script', status: 'available' },
      { kind: 'script-setup', status: 'absent' }
    ])
    const templateFailed = file('src/Broken.vue', [
      { kind: 'template', status: 'failed', message: 'Invalid directive' },
      { kind: 'script', status: 'available' },
      { kind: 'script-setup', status: 'absent' }
    ])
    const result = createBuiltinDoctorChecks({
      source: source(complete, templateFailed),
      matches: [],
      rules: {},
      vueVersion: '3.5.13'
    })

    expect(check(result.checks, 'vue-template-shadow')).toMatchObject({ status: 'disabled' })
    const enabled = createBuiltinDoctorChecks({
      source: source(complete, templateFailed),
      matches: [],
      rules: { 'vue-template-shadow': 'warning' },
      vueVersion: '3.5.13'
    })
    expect(check(enabled.checks, 'vue-template-shadow')).toMatchObject({ status: 'partial', files: 1 })
    expect(enabled.skippedChecks.some((skip) => (
      skip.ruleCode === 'vue-template-shadow' && skip.file === '/project/src/Broken.vue'
    ))).toBe(true)
  })

  test('disabled rules never retain required skips', () => {
    const result = createBuiltinDoctorChecks({
      source: source(file('src/Broken.ts', [
        { kind: 'script', status: 'failed', message: 'broken' }
      ])),
      matches: [],
      rules: { 'vue-watch-once-unsupported': 'off' }
    })

    expect(check(result.checks, 'vue-watch-once-unsupported').status).toBe('disabled')
    expect(result.skippedChecks.some((skip) => skip.ruleCode === 'vue-watch-once-unsupported')).toBe(false)
  })

  test('aligns component checks with actual usage targets and contract skips', () => {
    const unknownProps = componentMatch('unknown')
    const payloadSkip: SkippedCheck = {
      ruleCode: 'component-event-payload-changed',
      required: true,
      reason: 'missing-capability',
      file: unknownProps.usage.file,
      package: unknownProps.library.package,
      evidence: [{
        kind: 'source-event-listener',
        file: unknownProps.usage.file,
        line: 4,
        message: 'Handler signature is unavailable.'
      }]
    }
    const result = createBuiltinDoctorChecks({
      source: source(file('src/App.vue', [
        { kind: 'template', status: 'available' },
        { kind: 'script', status: 'absent' },
        { kind: 'script-setup', status: 'absent' }
      ])),
      matches: [unknownProps],
      rules: { 'component-attribute-unverified': 'info' },
      vueVersion: '3.5.13',
      componentSkippedChecks: [payloadSkip]
    })

    expect(check(result.checks, 'component-prop-required-missing').status).toBe('unavailable')
    expect(check(result.checks, 'component-prop-unsupported').status).toBe('unavailable')
    expect(check(result.checks, 'component-attribute-unverified')).toMatchObject({ status: 'checked', files: 1 })
    expect(check(result.checks, 'component-event-payload-changed').status).toBe('unavailable')
    expect(check(result.checks, 'component-event-unsupported')).toMatchObject({ status: 'checked', files: 1 })
    expect(result.skippedChecks).toEqual(expect.arrayContaining([
      payloadSkip,
      expect.objectContaining({
        ruleCode: 'component-prop-required-missing',
        reason: 'missing-capability'
      }),
      expect.objectContaining({
        ruleCode: 'component-prop-unsupported',
        reason: 'missing-capability'
      })
    ]))
  })

  test('keeps dynamic prop spreads as required coverage gaps', () => {
    const spreadMatch = componentMatch('known')
    spreadMatch.contract.props.entries.set('value', { name: 'value', required: true })
    spreadMatch.usage.props = []
    spreadMatch.usage.propSpreads = [{ expression: 'attrs', loc: { line: 3, column: 4 } }]

    const result = createBuiltinDoctorChecks({
      source: source(file('src/App.vue', [{ kind: 'template', status: 'available' }])),
      matches: [spreadMatch],
      rules: { 'component-attribute-unverified': 'info' },
      vueVersion: '3.5.13'
    })

    expect(check(result.checks, 'component-prop-required-missing').status).toBe('unavailable')
    expect(check(result.checks, 'component-prop-unsupported').status).toBe('unavailable')
    expect(check(result.checks, 'component-attribute-unverified').status).toBe('not-applicable')
    expect(result.skippedChecks.some((skip) => skip.ruleCode === 'component-attribute-unverified')).toBe(false)
    expect(result.skippedChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleCode: 'component-prop-required-missing',
        evidence: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('dynamic v-bind') })
        ])
      }),
      expect.objectContaining({
        ruleCode: 'component-prop-unsupported',
        evidence: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('dynamic v-bind') })
        ])
      })
    ]))
  })

  test.each([
    { binding: '', required: undefined, vueVersion: '3.5.13', expected: 'checked' },
    { binding: ':value="selected"', required: 'value', vueVersion: '3.5.13', expected: 'checked' },
    { binding: 'v-model="selected"', required: 'value', vueVersion: '2.7.16', expected: 'checked' },
    { binding: 'v-model="selected"', required: 'modelValue', vueVersion: '3.5.13', expected: 'checked' },
    { binding: 'v-model="selected"', required: 'value', vueVersion: '3.5.13', expected: 'unavailable' },
    { binding: 'v-model="selected"', required: 'modelValue', vueVersion: '2.7.16', expected: 'unavailable' },
    { binding: 'v-model="selected"', required: 'value', vueVersion: undefined, expected: 'unavailable' }
  ])('requires spread proof only for possibly missing props: $binding $required Vue $vueVersion', ({ binding, required, vueVersion, expected }) => {
    const match = componentMatch('known')
    match.usage = analyzeSourceText('/project/src/App.vue', `<template><FixtureButton ${binding} v-bind="attrs" /></template>`).components[0]!
    if (required) match.contract.props.entries.set(required, { name: required, required: true })
    match.contract.vue2Model = { prop: 'value', event: 'input' }
    const result = createBuiltinDoctorChecks({
      source: source(file('src/App.vue', [{ kind: 'template', status: 'available' }])),
      matches: [match],
      rules: {},
      vueVersion
    })
    expect(check(result.checks, 'component-prop-required-missing').status).toBe(expected)
    expect(result.skippedChecks.some((skip) => skip.ruleCode === 'component-prop-required-missing')).toBe(expected === 'unavailable')
    // Unknown names in the spread still need support evidence, regardless of required-prop proof.
    expect(check(result.checks, 'component-prop-unsupported').status).not.toBe('checked')
  })

  test('uses package Vue ownership for native event targets and custom model mappings', () => {
    const match = componentMatch('known')
    match.usage = analyzeSourceText('/project/src/App.vue', '<template><FixtureButton @change.native="save($event)" v-model="selected" v-bind="attrs" /></template>').components[0]!
    match.contract.vue2Model = { prop: 'selected', event: 'change' }
    match.contract.props.entries.set('selected', { name: 'selected', required: true })
    const options = {
      source: source(file('src/App.vue', [{ kind: 'template', status: 'available' }])),
      matches: [match],
      rules: {},
      vueVersion: '3.5.13'
    }
    const vue2 = createBuiltinDoctorChecks({ ...options, vueVersions: { [match.usage.file]: '2.7.16' } })
    expect(check(vue2.checks, 'component-event-unsupported').status).toBe('not-applicable')
    expect(check(vue2.checks, 'component-event-payload-changed').status).toBe('not-applicable')
    expect(check(vue2.checks, 'component-prop-required-missing').status).toBe('checked')
    const unresolved = createBuiltinDoctorChecks({ ...options, vueVersions: { [match.usage.file]: undefined } })
    expect(check(unresolved.checks, 'component-event-unsupported').status).toBe('checked')
    expect(check(unresolved.checks, 'component-prop-required-missing').status).toBe('unavailable')
  })

  test('marks dynamic attributes unverified only when the acceptance boundary is unknown', () => {
    const spreadMatch = componentMatch('unknown')
    spreadMatch.usage.props = []
    spreadMatch.usage.propSpreads = [{ expression: 'attrs', loc: { line: 3, column: 4 } }]

    const result = createBuiltinDoctorChecks({
      source: source(file('src/App.vue', [{ kind: 'template', status: 'available' }])),
      matches: [spreadMatch],
      rules: { 'component-attribute-unverified': 'info' },
      vueVersion: '3.5.13'
    })

    expect(check(result.checks, 'component-prop-unsupported').status).toBe('unavailable')
    expect(check(result.checks, 'component-attribute-unverified').status).toBe('unavailable')
    expect(result.skippedChecks.some((skip) => skip.ruleCode === 'component-attribute-unverified')).toBe(true)
  })
})

function componentMatch(propsKnowledge: ContractKnowledge): ComponentUsageContractMatch {
  const packageIdentity: PackageResolution = {
    dependencyName: '@fixture/ui',
    canonicalName: '@fixture/ui',
    installedVersion: '1.0.0',
    packageRoot: '/project/node_modules/@fixture/ui',
    packageJsonPath: '/project/node_modules/@fixture/ui/package.json',
    importRoots: ['@fixture/ui'],
    source: 'installed'
  }
  const library: ComponentLibraryEvidence = {
    package: packageIdentity,
    artifacts: { declarationEntries: [], runtimeEntries: [], issues: [] }
  }
  const contract: ComponentContract = {
    name: 'FixtureButton',
    aliases: [],
    props: {
      knowledge: propsKnowledge,
      acceptance: propsKnowledge === 'known' ? 'closed' : 'unknown',
      entries: new Map(),
      issues: []
    },
    events: {
      knowledge: 'known',
      acceptance: 'closed',
      entries: new Map([['change', {
        name: 'change',
        signatures: [{ parameters: [], minArity: 0, maxArity: 0 }],
        source: 'metadata'
      }]]),
      issues: []
    },
    slots: { knowledge: 'known', acceptance: 'closed', entries: new Map(), issues: [] },
    fallthrough: { attributes: 'closed', listeners: 'closed' },
    sources: []
  }
  const usage: VueComponentUsage = {
    file: '/project/src/App.vue',
    tag: 'FixtureButton',
    componentName: 'FixtureButton',
    loc: { line: 2, column: 2 },
    props: [{ name: 'tone', kind: 'static', value: 'quiet', loc: { line: 3, column: 4 } }],
    propSpreads: [],
    events: [{ name: 'change', modifiers: [], loc: { line: 4, column: 4 } }],
    models: [],
    slots: [],
    directives: []
  }
  return { usage, library, contract }
}

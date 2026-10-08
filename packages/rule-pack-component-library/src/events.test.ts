import type {
  ComponentContract,
  ComponentLibraryEvidence,
  ContractDimension,
  EventContract,
  PropContract
} from '@vue-doctor/component-library'
import type {
  VueComponentUsage,
  VueDirectiveUsage,
  VueEventUsage,
  VueModelUsage,
  VuePropUsage,
  VueSlotUsage
} from '@vue-doctor/source'
import { analyzeSourceText } from '@vue-doctor/source'
import { describe, expect, test } from 'vitest'
import { diagnoseComponentLibraryUsage } from './index.js'
import { diagnoseComponentLibraryUsageResult } from './events.js'
import type { ComponentUsageContractMatch } from './types.js'

const contractFile = '/project/node_modules/example-ui/web-types.json'
const sourceFile = '/project/src/App.vue'

const library: ComponentLibraryEvidence = {
  package: {
    dependencyName: 'example-ui',
    canonicalName: 'example-ui',
    declaredVersion: '1.2.0',
    installedVersion: '1.2.3',
    importRoots: ['example-ui'],
    source: 'installed'
  },
  artifacts: {
    declarationEntries: [],
    runtimeEntries: [],
    issues: []
  }
}

const unknownDimension = <T>(): ContractDimension<T> => ({
  knowledge: 'unknown',
  acceptance: 'unknown',
  entries: new Map(),
  issues: []
})

const knownDimension = <T>(
  entries: Array<[string, T]> = [],
  acceptance: ContractDimension<T>['acceptance'] = 'closed'
): ContractDimension<T> => ({
  knowledge: 'known',
  acceptance,
  entries: new Map(entries),
  issues: []
})

const eventContract = (name: string, parameters: string[] = []): EventContract => ({
  name,
  signatures: [{
    parameters: parameters.map((parameter) => ({ name: parameter, optional: false, rest: false })),
    minArity: parameters.length,
    maxArity: parameters.length
  }],
  source: 'metadata'
})

function createUsage(overrides: Partial<VueComponentUsage> = {}): VueComponentUsage {
  return {
    file: sourceFile,
    tag: 'ExampleInput',
    componentName: 'ExampleInput',
    loc: { line: 2, column: 3 },
    props: [],
    propSpreads: [],
    events: [],
    models: [],
    slots: [],
    directives: [],
    ...overrides
  }
}

function createMatch(
  contractOverrides: Partial<ComponentContract>,
  usageOverrides: Partial<VueComponentUsage> = {},
  childContracts: ComponentContract[] = []
): ComponentUsageContractMatch {
  const contract: ComponentContract = {
    name: 'ExampleInput',
    aliases: ['example-input'],
    props: unknownDimension(),
    events: unknownDimension(),
    slots: unknownDimension(),
    fallthrough: { attributes: 'unknown', listeners: 'unknown' },
    sources: [{
      source: 'web-types',
      path: contractFile,
      relativePath: 'web-types.json'
    }],
    ...contractOverrides
  }
  const components = new Map(childContracts.flatMap((child) => (
    [child.name, ...child.aliases].map((name) => [name, child] as const)
  )))
  components.set(contract.name, contract)

  return {
    usage: createUsage(usageOverrides),
    library,
    contract,
    contracts: { components, sources: [], problems: [] }
  }
}

function childContract(
  name: string,
  props: ContractDimension<PropContract>,
  fallthrough: ComponentContract['fallthrough'] = { attributes: 'closed', listeners: 'unknown' }
): ComponentContract {
  return {
    name,
    aliases: [],
    props,
    events: unknownDimension(),
    slots: unknownDimension(),
    fallthrough,
    sources: []
  }
}

const unsupportedEvent: VueEventUsage = {
  name: 'ghost',
  modifiers: [],
  expression: 'onGhost',
  loc: { line: 3, column: 5 }
}

const unsupportedProp: VuePropUsage = {
  name: 'ghost-prop',
  kind: 'boolean',
  loc: { line: 3, column: 5 }
}

const loadingDirective: VueDirectiveUsage = {
  name: 'loading',
  modifiers: ['fullscreen'],
  loc: { line: 3, column: 5 }
}

const unsupportedSlot: VueSlotUsage = {
  name: 'suffix',
  loc: { line: 4, column: 5 }
}

const unsupportedModel: VueModelUsage = {
  argument: 'ghost',
  expression: 'ghost',
  modifiers: [],
  loc: { line: 3, column: 5 }
}

describe('component-library usage diagnostics', () => {
  test.each(['known', 'unknown'] as const)('excludes Vue 2 native listeners from %s component event contracts', (knowledge) => {
    const usage = analyzeSourceText(sourceFile, '<template><ExampleInput @click.native="save($event)" /></template>').components[0]!
    const match = createMatch({
      events: knowledge === 'known' ? knownDimension() : unknownDimension(),
      fallthrough: { attributes: 'closed', listeners: 'closed' }
    }, usage)
    expect(diagnoseComponentLibraryUsageResult({ matches: [match], vueVersion: '2.7.16' })).toEqual({
      diagnostics: [], skippedChecks: []
    })
    const vue3 = diagnoseComponentLibraryUsageResult({ matches: [match], vueVersion: '3.5.13' })
    expect(vue3.diagnostics.length + vue3.skippedChecks.length).toBe(1)
    const unresolved = diagnoseComponentLibraryUsageResult({ matches: [match] })
    expect(unresolved.diagnostics.length + unresolved.skippedChecks.length).toBe(1)
    const customUsage = analyzeSourceText(sourceFile, '<template><ExampleInput @click="close()" /></template>').components[0]!
    const custom = diagnoseComponentLibraryUsageResult({
      matches: [{ ...match, usage: customUsage }], vueVersion: '2.7.16'
    })
    expect(custom.diagnostics.length + custom.skippedChecks.length).toBe(1)
  })

  test.each(['known', 'partial'] as const)('asks for event support but not an unused payload signature with %s evidence', (knowledge) => {
    const usages = analyzeSourceText(sourceFile, `<script setup>
function ignore(value) { close() }
</script>
<template>
  <ExampleInput @change="close()" />
  <ExampleInput @change="open = false" />
  <ExampleInput @change="ignore" />
  <ExampleInput @change="() => close()" />
  <ExampleInput @change="(...args) => close()" />
  <ExampleInput @change="" />
  <ExampleInput @change />
</template>`).components
    const events = knownDimension<EventContract>([['change', { name: 'change', signatures: [], source: 'emit' }]])
    events.knowledge = knowledge
    const resolved = diagnoseComponentLibraryUsageResult({ matches: usages.map((usage) => createMatch({ events }, usage)) })
    expect(resolved).toEqual({ diagnostics: [], skippedChecks: [] })
    const unknown = diagnoseComponentLibraryUsageResult({
      matches: usages.map((usage) => createMatch({ events: unknownDimension() }, usage))
    })
    expect(unknown.skippedChecks).toHaveLength(usages.length)
    expect(unknown.skippedChecks.every((skip) => skip.ruleCode === 'component-event-unsupported' && skip.required)).toBe(true)
  })

  test.each(['mutate(finish)', 'const alias = finish; mutate(alias)'])('requires payload evidence after setup handler escape: %s', (mutation) => {
    const usage = analyzeSourceText(sourceFile, `<script setup>
function finish() {}
${mutation}
</script><template><ExampleInput @change="finish" /></template>`).components[0]!
    const result = diagnoseComponentLibraryUsageResult({
      matches: [createMatch({
        events: knownDimension([['change', { name: 'change', signatures: [], source: 'emit' }]])
      }, usage)]
    })
    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({ ruleCode: 'component-event-payload-changed', required: true })
    ])
  })

  test.each([
    'data() { return { done: value => consume(value) } }',
    'setup() { return { done: value => consume(value) } }',
    'created() { mutate(this) }',
    'created() { const vm = this; mutate(vm) }',
    'mixins: [runtimeMixin]'
  ])('requires payload evidence when Options method identity can be replaced: %s', (options) => {
    const usage = analyzeSourceText(sourceFile, `<script>
export default { methods: { done() {} }, ${options} }
</script><template><ExampleInput @change="done" /></template>`).components[0]!
    const result = diagnoseComponentLibraryUsageResult({
      matches: [createMatch({
        events: knownDimension([['change', { name: 'change', signatures: [], source: 'emit' }]])
      }, usage)]
    })
    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({ ruleCode: 'component-event-payload-changed', required: true })
    ])
  })

  test.each([
    'save($event)', 'value => save(value)', '(...args) => save(...args)',
    'handlers[current]', '() => eval(source)', 'function () { save(arguments[0]) }',
    '({ value }) => close()', '([value]) => close()', '(value = readDefault()) => close()',
    '(...args) => save(args[0])', 'value => { const { [value]: item } = state; close() }',
    'value => { const inner = (fallback = value) => save(fallback); inner() }'
  ])('keeps payload evidence required for %s', (handler) => {
    const usage = analyzeSourceText(sourceFile, `<template><ExampleInput @change="${handler}" /></template>`).components[0]!
    const result = diagnoseComponentLibraryUsageResult({
      matches: [createMatch({
        events: knownDimension([['change', { name: 'change', signatures: [], source: 'emit' }]])
      }, usage)]
    })
    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({ ruleCode: 'component-event-payload-changed', required: true })
    ])
  })

  test.each(['stop', 'prevent', 'self', 'enter'])('keeps implicit .%s payload reads unresolved', (modifier) => {
    const usage = analyzeSourceText(sourceFile, `<template><ExampleInput @change.${modifier}="close()" /></template>`).components[0]!
    const result = diagnoseComponentLibraryUsageResult({
      matches: [createMatch({
        events: knownDimension([['change', { name: 'change', signatures: [], source: 'emit' }]])
      }, usage)]
    })
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({ ruleCode: 'component-event-payload-changed', required: true })
    ])
  })

  test('does not report unsupported events when event knowledge is unknown', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        { events: unknownDimension() },
        { events: [unsupportedEvent] }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('does not report unsupported events when event knowledge is partial', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        { events: { knowledge: 'partial', acceptance: 'unknown', entries: new Map(), issues: [] } },
        { events: [unsupportedEvent] }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('returns required skips for unresolved event, model, and slot support', () => {
    const result = diagnoseComponentLibraryUsageResult({
      matches: [createMatch(
        {
          events: unknownDimension(),
          slots: unknownDimension(),
          fallthrough: { attributes: 'unknown', listeners: 'unknown' }
        },
        {
          events: [unsupportedEvent],
          models: [unsupportedModel],
          slots: [unsupportedSlot]
        }
      )]
    })

    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({ ruleCode: 'component-model-unsupported', required: true, reason: 'missing-capability' }),
      expect.objectContaining({ ruleCode: 'component-slot-unsupported', required: true, reason: 'missing-capability' }),
      expect.objectContaining({ ruleCode: 'component-event-unsupported', required: true, reason: 'missing-capability' })
    ])
  })

  test('marks conflicting event boundaries as partial-contract skips', () => {
    const result = diagnoseComponentLibraryUsageResult({
      matches: [createMatch(
        {
          events: {
            knowledge: 'unknown',
            acceptance: 'unknown',
            entries: new Map(),
            issues: [{ code: 'boundary-conflict', message: 'Closed and open evidence disagree.' }]
          }
        },
        { events: [unsupportedEvent] }
      )]
    })

    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({ ruleCode: 'component-event-unsupported', reason: 'partial-contract' })
    ])
  })

  test('accepts explicitly open event and slot boundaries without required skips', () => {
    const result = diagnoseComponentLibraryUsageResult({
      vueVersion: '3.5.39',
      matches: [createMatch(
        {
          events: knownDimension([], 'open'),
          slots: knownDimension([], 'open')
        },
        {
          events: [unsupportedEvent],
          models: [unsupportedModel],
          slots: [unsupportedSlot]
        }
      )]
    })

    expect(result).toEqual({ diagnostics: [], skippedChecks: [] })
  })

  test('reports unsupported events when event knowledge is known', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          events: knownDimension(),
          fallthrough: { attributes: 'unknown', listeners: 'closed' }
        },
        { events: [unsupportedEvent] }
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-event-unsupported',
        message: 'ExampleInput from example-ui@1.2.3 does not declare event "ghost".'
      })
    ])
    expect(diagnostics[0]?.evidence).toEqual([
      expect.objectContaining({ kind: 'source-event-listener', file: sourceFile }),
      expect.objectContaining({ kind: 'component-contract', file: contractFile })
    ])
  })

  test('reports unverified attributes when prop knowledge is unknown', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        { props: unknownDimension() },
        { props: [unsupportedProp] }
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'component-attribute-unverified', severity: 'info' })
    ])
  })

  test('reports unsupported props when prop knowledge is known', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: knownDimension(),
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        { props: [unsupportedProp] }
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-prop-unsupported',
        message: 'ExampleInput from example-ui@1.2.3 does not declare prop "ghost-prop".'
      })
    ])
  })

  test('reports missing required props from closed contracts', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: knownDimension([
            ['label', { name: 'label', required: true, types: [{ kind: 'string' }] }],
            ['disabled', { name: 'disabled', required: false, types: [{ kind: 'boolean' }] }]
          ]),
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        { props: [] }
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-prop-required-missing',
        severity: 'error',
        message: 'ExampleInput from example-ui@1.2.3 requires prop "label".'
      })
    ])
  })

  test('does not report required props when object v-bind may provide them', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: knownDimension([
            ['value', { name: 'value', required: true, types: [{ kind: 'string' }] }],
            ['label', { name: 'label', required: false, types: [{ kind: 'string' }] }]
          ]),
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        {
          props: [],
          propSpreads: [{ expression: 'item', loc: { line: 2, column: 3 } }]
        }
      )]
    })

    expect(diagnostics.filter((item) => item.code === 'component-prop-required-missing')).toEqual([])
  })

  test('treats v-model as satisfying required model-value props', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      vueVersion: '3.5.39',
      matches: [createMatch(
        {
          props: knownDimension([
            ['modelValue', { name: 'modelValue', required: true, types: [{ kind: 'string' }] }]
          ]),
          events: knownDimension([
            ['update:modelValue', eventContract('update:modelValue', ['value'])]
          ]),
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        {
          models: [{
            argument: undefined,
            expression: 'value',
            modifiers: [],
            loc: { line: 2, column: 3 }
          }]
        }
      )]
    })

    expect(diagnostics.filter((item) => item.code === 'component-prop-required-missing')).toEqual([])
  })

  test('reports static prop values that conflict with declared literal types', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: knownDimension([
            ['size', { name: 'size', required: false, types: [{ kind: 'literal', value: 'sm' }, { kind: 'literal', value: 'md' }] }]
          ]),
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        {
          props: [{
            name: 'size',
            kind: 'static',
            value: 'xl',
            loc: { line: 4, column: 5 }
          }]
        }
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-prop-type-mismatch',
        severity: 'warning',
        message: 'ExampleInput from example-ui@1.2.3 prop "size" expects "sm" | "md", got static "xl".'
      })
    ])
  })

  test('does not claim a type mismatch from partial prop evidence', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: {
            knowledge: 'partial',
            acceptance: 'closed',
            entries: new Map<string, PropContract>([
              ['fixed', { name: 'fixed', types: [{ kind: 'boolean' }] }]
            ]),
            issues: [{ code: 'entry-conflict', message: 'Metadata and declarations disagree.' }]
          },
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        {
          props: [{
            name: 'fixed',
            kind: 'static',
            value: 'right',
            loc: { line: 4, column: 5 }
          }]
        }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('treats lowercase native on attributes as fallthrough instead of typed listener props', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: knownDimension([
            ['oninput', { name: 'oninput', types: [{ kind: 'function' }] }]
          ]),
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        {
          props: [{
            name: 'oninput',
            kind: 'static',
            value: `value = value.replace(/\\s+/g, ' ')`,
            loc: { line: 4, column: 5 }
          }]
        }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('type-checks dynamic bindings only when their complete static value is known', () => {
    const extracted = analyzeSourceText(
      sourceFile,
      '<template><ExampleInput :label="42" :size="\'xl\'" /></template>'
    ).components[0]!
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: knownDimension([
            ['label', { name: 'label', required: false, types: [{ kind: 'string' }] }],
            ['size', { name: 'size', required: false, types: [{ kind: 'literal', value: 'sm' }, { kind: 'literal', value: 'md' }] }]
          ]),
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        extracted
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-prop-type-mismatch',
        message: 'ExampleInput from example-ui@1.2.3 prop "label" expects string, got dynamic number 42.'
      }),
      expect.objectContaining({
        code: 'component-prop-type-mismatch',
        message: 'ExampleInput from example-ui@1.2.3 prop "size" expects "sm" | "md", got dynamic string "xl".'
      })
    ])
  })

  test('accepts complete dynamic object, array and null values by their runtime kinds', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: knownDimension([
            ['config', { name: 'config', types: [{ kind: 'object' }] }],
            ['items', { name: 'items', types: [{ kind: 'array' }] }],
            ['empty', { name: 'empty', types: [{ kind: 'null' }] }]
          ]),
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        analyzeSourceText(
          sourceFile,
          '<template><ExampleInput :config="{ enabled: true }" :items="[1, 2]" :empty="null" /></template>'
        ).components[0]
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('does not type-check unknown expressions or partially evaluated static evidence', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: knownDimension([
            ['count', { name: 'count', types: [{ kind: 'string' }] }],
            ['config', { name: 'config', types: [{ kind: 'string' }] }]
          ]),
          fallthrough: { attributes: 'closed', listeners: 'unknown' }
        },
        {
          props: [{
            name: 'count',
            kind: 'dynamic',
            expression: 'count',
            loc: { line: 4, column: 5 }
          }, {
            name: 'config',
            kind: 'dynamic',
            expression: '{ known: 1, ...runtime }',
            staticValue: { known: 1 },
            staticEvidence: {
              complete: false,
              properties: { known: { complete: true, value: 1 } }
            },
            loc: { line: 5, column: 5 }
          }]
        }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('suppresses loading companion attributes only with the loading directive', () => {
    const withDirective = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        { props: knownDimension(), fallthrough: { attributes: 'closed', listeners: 'unknown' } },
        { props: [{ ...unsupportedProp, name: 'element-loading-text' }], directives: [loadingDirective] }
      )]
    })
    const withoutDirective = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        { props: knownDimension(), fallthrough: { attributes: 'closed', listeners: 'unknown' } },
        { props: [{ ...unsupportedProp, name: 'element-loading-text' }] }
      )]
    })

    expect(withDirective).toEqual([])
    expect(withoutDirective).toEqual([
      expect.objectContaining({ code: 'component-prop-unsupported' })
    ])
  })

  test.each([
    {
      name: 'the prop contract is open',
      props: knownDimension<{ name: string }>([], 'open'),
      fallthrough: { attributes: 'closed', listeners: 'unknown' } as const
    },
    {
      name: 'attribute fallthrough is open',
      props: knownDimension<{ name: string }>(),
      fallthrough: { attributes: 'open', listeners: 'unknown' } as const
    },
  ])('does not report an absent prop when $name', ({ props, fallthrough }) => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        { props, fallthrough },
        { props: [unsupportedProp] }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('reports an unverified attribute when fallthrough is unknown', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch({
        props: knownDimension(),
        fallthrough: { attributes: 'unknown', listeners: 'unknown' }
      }, { props: [unsupportedProp] })]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'component-attribute-unverified' })
    ])
  })

  test('follows $attrs into a child that declares the concrete prop', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch({
        props: knownDimension(),
        fallthrough: {
          attributes: 'unknown',
          listeners: 'unknown',
          attributeTargets: [{ kind: 'component', name: 'InnerDialog', file: '/ui/dialog.mjs' }]
        }
      }, { props: [{ ...unsupportedProp, name: 'title' }] }, [
        childContract('InnerDialog', knownDimension([['title', { name: 'title' }]]))
      ])]
    })

    expect(diagnostics).toEqual([])
  })

  test('does not accept $attrs when the receiving child contract is unresolved', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch({
        props: knownDimension(),
        fallthrough: {
          attributes: 'unknown',
          listeners: 'unknown',
          attributeTargets: [{ kind: 'component', name: 'MissingDialog', file: '/ui/wrapper.mjs' }]
        }
      }, { props: [{ ...unsupportedProp, name: 'title' }] })]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-attribute-unverified',
        severity: 'info',
        confidence: 'low'
      })
    ])
  })

  test('accepts or rejects a native attribute from resolved DOM evidence', () => {
    const target = {
      kind: 'element' as const,
      name: 'a',
      file: '/ui/link.mjs',
      supportedAttributes: ['href', 'target']
    }
    const accepted = diagnoseComponentLibraryUsage({
      matches: [createMatch({
        props: knownDimension(),
        fallthrough: { attributes: 'unknown', listeners: 'unknown', attributeTargets: [target] }
      }, { props: [{ ...unsupportedProp, name: 'target' }] })]
    })
    const unsupported = diagnoseComponentLibraryUsage({
      matches: [createMatch({
        props: knownDimension(),
        fallthrough: { attributes: 'unknown', listeners: 'unknown', attributeTargets: [target] }
      }, { props: [unsupportedProp] })]
    })

    expect(accepted).toEqual([])
    expect(unsupported).toEqual([
      expect.objectContaining({ code: 'component-prop-unsupported', severity: 'warning' })
    ])
  })

  test('accepts a concrete attribute when one target accepts and another is unresolved', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch({
        props: knownDimension(),
        fallthrough: {
          attributes: 'unknown',
          listeners: 'unknown',
          attributeTargets: [
            { kind: 'component', name: 'AcceptingDialog', file: '/ui/wrapper.mjs' },
            { kind: 'component', name: 'MissingDialog', file: '/ui/wrapper.mjs' }
          ]
        }
      }, { props: [{ ...unsupportedProp, name: 'title' }] }, [
        childContract('AcceptingDialog', knownDimension([['title', { name: 'title' }]]))
      ])]
    })

    expect(diagnostics).toEqual([])
  })

  test('rejects an attribute that runtime object-rest excludes from a target', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch({
        props: knownDimension(),
        fallthrough: {
          attributes: 'unknown',
          listeners: 'unknown',
          attributeTargets: [{
            kind: 'element',
            name: 'input',
            file: '/ui/input.mjs',
            supportedAttributes: ['title'],
            excludedAttributes: ['title']
          }]
        }
      }, { props: [{ ...unsupportedProp, name: 'title' }] })]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'component-prop-unsupported' })
    ])
  })

  test('keeps cyclic component forwarding unverified', () => {
    const first = childContract('First', knownDimension(), {
      attributes: 'unknown',
      listeners: 'unknown',
      attributeTargets: [{ kind: 'component', name: 'Second', file: '/ui/first.mjs' }]
    })
    const second = childContract('Second', knownDimension(), {
      attributes: 'unknown',
      listeners: 'unknown',
      attributeTargets: [{ kind: 'component', name: 'First', file: '/ui/second.mjs' }]
    })
    const match = createMatch(first, { props: [unsupportedProp] }, [second])
    match.contracts!.components.set('First', match.contract)

    expect(diagnoseComponentLibraryUsage({ matches: [match] })).toEqual([
      expect.objectContaining({ code: 'component-attribute-unverified' })
    ])
  })

  test('does not report unsupported slots when slot knowledge is unknown', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        { slots: unknownDimension() },
        { slots: [unsupportedSlot] }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('reports unsupported slots when slot knowledge is known', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        { slots: knownDimension() },
        { slots: [unsupportedSlot] }
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-slot-unsupported',
        message: 'ExampleInput from example-ui@1.2.3 does not declare slot "suffix".'
      })
    ])
  })

  test('does not check models when prop knowledge is unknown', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      vueVersion: '3.5.39',
      matches: [createMatch(
        {
          props: unknownDimension(),
          events: knownDimension()
        },
        { models: [unsupportedModel] }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('does not check models when update-event knowledge is unknown', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      vueVersion: '3.5.39',
      matches: [createMatch(
        {
          props: knownDimension(),
          events: unknownDimension()
        },
        { models: [unsupportedModel] }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('reports unsupported models when prop and update-event knowledge are known', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      vueVersion: '3.5.39',
      matches: [createMatch(
        {
          props: knownDimension(),
          events: knownDimension(),
          fallthrough: { attributes: 'unknown', listeners: 'closed' }
        },
        { models: [unsupportedModel] }
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-model-unsupported',
        message: 'ExampleInput from example-ui@1.2.3 does not declare v-model:ghost.'
      })
    ])
    expect(diagnostics[0]?.fixes).toEqual([
      expect.objectContaining({
        title: 'Use v-model or a model argument declared by the installed component version.'
      })
    ])
  })

  test('accepts default v-model when update event is declared without model prop', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      vueVersion: '3.5.39',
      matches: [createMatch(
        {
          props: knownDimension([
            ['label', { name: 'label' }],
            ['onUpdate:modelValue', { name: 'onUpdate:modelValue' }]
          ]),
          events: knownDimension([
            ['update:modelValue', eventContract('update:modelValue', ['value'])]
          ], 'unknown')
        },
        { models: [{ expression: 'value', modifiers: [], loc: { line: 3, column: 5 } }] }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('still reports models when the update event is unsupported', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      vueVersion: '3.5.39',
      matches: [createMatch(
        {
          props: knownDimension([['modelValue', { name: 'modelValue' }]]),
          events: knownDimension(),
          fallthrough: { attributes: 'unknown', listeners: 'closed' }
        },
        { models: [{ expression: 'value', modifiers: [], loc: { line: 3, column: 5 } }] }
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-model-unsupported',
        message: 'ExampleInput from example-ui@1.2.3 does not declare v-model.'
      })
    ])
  })

  test('keeps v-model support unresolved when only attribute forwarding is known', () => {
    const result = diagnoseComponentLibraryUsageResult({
      vueVersion: '3.5.39',
      matches: [createMatch(
        {
          props: knownDimension(),
          events: knownDimension(),
          fallthrough: {
            attributes: 'unknown',
            listeners: 'unknown',
            attributeTargets: [{ kind: 'component', name: 'InnerSelect', file: '/ui/wrapper.mjs' }]
          }
        },
        { models: [{ expression: 'value', modifiers: [], loc: { line: 3, column: 5 } }] },
        [childContract('InnerSelect', knownDimension([['modelValue', { name: 'modelValue' }]]))]
      )]
    })

    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({
        ruleCode: 'component-model-unsupported',
        reason: 'missing-capability'
      })
    ])
  })

  test('does not infer payload incompatibility from fewer or renamed handler parameters', () => {
    const event: VueEventUsage = {
      name: 'visible-change',
      modifiers: [],
      expression: 'handleVisible',
      handler: {
        kind: 'reference',
        parameters: ['visible'],
        minArity: 1,
        maxArity: 1
      },
      loc: { line: 3, column: 5 }
    }
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          events: knownDimension([[
            'visible-change',
            eventContract('visible-change', ['role', 'visible'])
          ]])
        },
        { events: [event] }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('reports a payload change only when every overload is too short for required handler parameters', () => {
    const event: VueEventUsage = {
      name: 'visible-change',
      modifiers: [],
      expression: 'handleVisible',
      handler: {
        kind: 'reference',
        parameters: ['first', 'second', 'third'],
        minArity: 3,
        maxArity: 3
      },
      loc: { line: 3, column: 5 }
    }
    const contract: EventContract = {
      name: 'visible-change',
      signatures: [
        {
          parameters: [{ name: 'visible', optional: false, rest: false }],
          minArity: 1,
          maxArity: 1
        },
        {
          parameters: [
            { name: 'role', optional: false, rest: false },
            { name: 'visible', optional: true, rest: false }
          ],
          minArity: 1,
          maxArity: 2
        }
      ],
      source: 'emit'
    }
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        { events: knownDimension([['visible-change', contract]]) },
        { events: [event] }
      )]
    })

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-event-payload-changed',
        message: expect.stringContaining('handler requires at least 3 parameters')
      })
    ])
    expect(diagnostics[0]?.evidence).toEqual([
      expect.objectContaining({ kind: 'source-event-listener', file: sourceFile }),
      expect.objectContaining({ kind: 'component-contract', file: contractFile })
    ])
  })

  test('accepts an overload or rest payload that can satisfy the handler minimum arity', () => {
    const event: VueEventUsage = {
      name: 'change',
      modifiers: [],
      handler: {
        kind: 'reference',
        parameters: ['first', 'second'],
        minArity: 2,
        maxArity: 2
      },
      loc: { line: 3, column: 5 }
    }
    const overload: EventContract = {
      name: 'change',
      signatures: [
        { parameters: [], minArity: 0, maxArity: 0 },
        {
          parameters: [
            { name: 'value', optional: false, rest: false },
            { name: 'args', optional: false, rest: true }
          ],
          minArity: 1,
          maxArity: null
        }
      ],
      source: 'emit'
    }

    expect(diagnoseComponentLibraryUsageResult({
      matches: [createMatch(
        { events: knownDimension([['change', overload]]) },
        { events: [event] }
      )]
    })).toEqual({ diagnostics: [], skippedChecks: [] })
  })

  test('returns a required skip when a declared event handler shape is unresolved', () => {
    const result = diagnoseComponentLibraryUsageResult({
      matches: [createMatch(
        {
          events: knownDimension([[
            'change',
            eventContract('change', ['value'])
          ]])
        },
        {
          events: [{
            name: 'change',
            modifiers: [],
            expression: 'dynamicHandlers.change',
            loc: { line: 3, column: 5 }
          }]
        }
      )]
    })

    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({
        ruleCode: 'component-event-payload-changed',
        required: true,
        reason: 'missing-capability'
      })
    ])
  })

  test.each([
    ['no-argument', [], 0],
    ['optional-only', ['value'], 1],
    ['rest-only', ['args'], null]
  ] as const)('keeps %s handlers unresolved without payload-consumption evidence', (_name, parameters, maxArity) => {
    const result = diagnoseComponentLibraryUsageResult({
      matches: [createMatch({
        events: knownDimension([['change', { name: 'change', signatures: [], source: 'emit' }]])
      }, {
        events: [{
          name: 'change',
          modifiers: [],
          handler: { kind: 'reference', parameters: [...parameters], minArity: 0, maxArity },
          loc: { line: 3, column: 5 }
        }]
      })]
    })

    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({ ruleCode: 'component-event-payload-changed', required: true })
    ])
  })

  test('does not treat attribute forwarding targets as listener forwarding evidence', () => {
    const declaredChild: ComponentContract = {
      ...childContract('InnerInput', knownDimension()),
      events: knownDimension([['change', eventContract('change', ['value'])]])
    }
    const unknownListeners = {
      events: knownDimension<EventContract>(),
      fallthrough: {
        attributes: 'unknown' as const,
        listeners: 'unknown' as const,
        attributeTargets: [{
          kind: 'component' as const,
          name: 'InnerInput',
          file: '/ui/wrapper.mjs'
        }]
      }
    }
    const event: VueEventUsage = { name: 'change', modifiers: [], loc: { line: 3, column: 5 } }

    const unresolved = diagnoseComponentLibraryUsageResult({
      matches: [createMatch(unknownListeners, { events: [event] }, [declaredChild])]
    })
    const closed = diagnoseComponentLibraryUsageResult({
      matches: [createMatch({
        ...unknownListeners,
        fallthrough: { ...unknownListeners.fallthrough, listeners: 'closed' }
      }, { events: [event] }, [declaredChild])]
    })

    expect(unresolved.diagnostics).toEqual([])
    expect(unresolved.skippedChecks).toEqual([
      expect.objectContaining({
        ruleCode: 'component-event-unsupported',
        reason: 'missing-capability'
      })
    ])
    expect(closed.diagnostics).toEqual([
      expect.objectContaining({
        code: 'component-event-unsupported'
      })
    ])
    expect(closed.skippedChecks).toEqual([])
  })

  test('does not infer payload incompatibility from an incomplete event dimension', () => {
    const event: VueEventUsage = {
      name: 'change',
      modifiers: [],
      handler: {
        kind: 'reference',
        parameters: ['first', 'second'],
        minArity: 2,
        maxArity: 2
      },
      loc: { line: 3, column: 5 }
    }
    const result = diagnoseComponentLibraryUsageResult({
      matches: [createMatch({
        events: {
          knowledge: 'partial',
          acceptance: 'unknown',
          entries: new Map([['change', eventContract('change', ['value'])]]),
          issues: [{ code: 'event-overload-conflict', message: 'Event overload evidence is incomplete.' }]
        }
      }, { events: [event] })]
    })

    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks).toEqual([
      expect.objectContaining({
        ruleCode: 'component-event-payload-changed',
        reason: 'partial-contract'
      })
    ])
  })

  test('accepts normalized contract names and universal props', () => {
    const diagnostics = diagnoseComponentLibraryUsage({
      matches: [createMatch(
        {
          props: knownDimension([
            ['modelValue', { name: 'modelValue' }]
          ]),
          events: knownDimension([
            ['update:modelValue', eventContract('update:modelValue')]
          ]),
          slots: knownDimension([
            ['actionSuffix', { name: 'actionSuffix' }]
          ])
        },
        {
          props: [
            { name: 'model-value', kind: 'dynamic', loc: { line: 3, column: 5 } },
            { name: 'aria-label', kind: 'static', loc: { line: 3, column: 5 } }
          ],
          events: [{ name: 'update:model-value', modifiers: [], loc: { line: 3, column: 5 } }],
          models: [{ expression: 'value', modifiers: [], loc: { line: 3, column: 5 } }],
          slots: [{ name: 'action-suffix', loc: { line: 4, column: 5 } }]
        }
      )]
    })

    expect(diagnostics).toEqual([])
  })

  test('returns no diagnostics when there are no matches', () => {
    expect(diagnoseComponentLibraryUsage({ matches: [] })).toEqual([])
  })
  test.each([
    { vueVersion: '2.7.16', mapping: { prop: 'value', event: 'input' }, argument: undefined },
    { vueVersion: '2.7.16', mapping: { prop: 'checked', event: 'change' }, argument: undefined },
    { vueVersion: '3.5.39', mapping: { prop: 'modelValue', event: 'update:modelValue' }, argument: undefined },
    { vueVersion: '3.5.39', mapping: { prop: 'selected', event: 'update:selected' }, argument: 'selected' }
  ])('uses the consuming $vueVersion model mapping $mapping', ({ vueVersion, mapping, argument }) => {
    const result = diagnoseComponentLibraryUsageResult({
      vueVersion,
      matches: [createMatch({
        vue2Model: mapping,
        props: knownDimension([[mapping.prop, { name: mapping.prop, required: true }]]),
        events: { ...unknownDimension<EventContract>(), entries: new Map([[mapping.event, {
          name: mapping.event, signatures: [], source: 'emit'
        }]]) }
      }, {
        models: [{ argument, expression: 'value', modifiers: [], loc: { line: 3, column: 5 } }]
      })]
    })
    expect(result).toEqual({ diagnostics: [], skippedChecks: [] })
  })

  test('does not use Vue 3 update events to prove a Vue 2 model', () => {
    const result = diagnoseComponentLibraryUsageResult({
      vueVersion: '2.7.16',
      matches: [createMatch({
        vue2Model: { prop: 'value', event: 'input' },
        events: knownDimension([['update:modelValue', eventContract('update:modelValue')]]),
        fallthrough: { attributes: 'unknown', listeners: 'closed' }
      }, { models: [{ modifiers: [], loc: { line: 3, column: 5 } }] })]
    })
    expect(result.diagnostics.map(item => item.code)).toEqual(['component-model-unsupported'])
    expect(result.skippedChecks).toEqual([])
  })

  test.each([
    { vueVersion: undefined },
    { vueVersion: '2.7.16' },
    { vueVersion: '3.5.39', vueVersions: { [sourceFile]: undefined } },
    { vueVersion: '3.5.39', vueVersions: { [sourceFile]: '2.7.16' } }
  ])('keeps unresolved version or model mapping honest: %j', versionContext => {
    const result = diagnoseComponentLibraryUsageResult({
      ...versionContext,
      matches: [createMatch({
        props: knownDimension([['value', { name: 'value', required: true }]]),
        events: knownDimension([['input', eventContract('input')], ['update:modelValue', eventContract('update:modelValue')]])
      }, { models: [{ modifiers: [], loc: { line: 3, column: 5 } }] })]
    })
    expect(result.diagnostics).toEqual([])
    expect(result.skippedChecks.map(item => [item.ruleCode, item.required])).toEqual([
      ['component-model-unsupported', true],
      ['component-prop-required-missing', true]
    ])
  })
})

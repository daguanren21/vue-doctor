import { isDoctorRuleEnabled } from '@daguanren21/vue-doctor-core'
import { parseVueSource } from '@daguanren21/vue-doctor-source'
import { describe, expect, test } from 'vitest'
import { diagnoseVueSource, isVueRuleAvailable, type DiagnoseVueSourceOptions } from './index.js'
import { getVueRuleDefinition, getVueRulesForFailedSourceBlock } from './rules.js'

const file = '/project/src/App.vue'
const scriptCodes = ['vue-computed-async-getter', 'vue-computed-source-mutation']
const templateCodes = ['vue-event-passive-prevent', 'vue-memo-invalid-dependencies', 'vue-transition-group-mode']
const featureCodes = [...scriptCodes, ...templateCodes]
type VersionOptions = Pick<DiagnoseVueSourceOptions, 'vueVersion' | 'assumeLatestVueVersion' | 'autoImports'>

function diagnose(source: string, options: VersionOptions = {}) {
  const parsed = parseVueSource(source, file)
  expect(parsed.blocks.filter((block) => block.status === 'failed')).toEqual([])
  return diagnoseVueSource({ file, parsed, source, ...options })
}

function scriptDiagnostics(script: string, code: string, options: VersionOptions = {}) {
  return diagnose(`<script setup>${script}</script>`, options).filter((diagnostic) => diagnostic.code === code)
}

const badScript = `import { computed, ref } from 'vue'
const count = ref(0)
computed(async () => count.value)
computed(() => count.value++)`
const badTemplate = `<div @touchmove.passive.prevent="onMove" v-memo="true" />
<TransitionGroup mode="out-in" />`
const allBad = `<script setup>${badScript}</script><template>${badTemplate}</template>`

describe('computed getter contracts', () => {
  test.each([
    'computed(async () => 1)',
    'computed(async function () { return 1 })',
    'computed({ async get() { return 1 }, set(value) {} })',
    'computed({ get: async (previous) => previous, set: value => {} })',
    'computed({ get: () => 0, get: async () => 1 })',
    'computed({ ...options, get: async () => 1 })',
    'computed({ [key]: () => 0, get: async () => 1 })',
    'computed({ get: async () => 1, 0: value })',
    "computed({ ['get']: async () => 1, ['set']: value => {} })"
  ])('reports the effective inline async getter: %s', (expression) => {
    expect(scriptDiagnostics(`import { computed } from 'vue'; ${expression}`, 'vue-computed-async-getter'))
      .toEqual([expect.objectContaining({ severity: 'warning' })])
  })

  test.each([
    'computed(previous => previous)',
    'computed(() => async () => 1)',
    'computed(() => Promise.resolve(1))',
    'computed(asyncGetter)',
    'computed({ get: asyncGetter })',
    'computed({ get: () => 1, async set(value) {} })',
    'computed({ get: async () => 1, get: () => 0 })',
    'computed({ get: async () => 1, get: getter })',
    'computed({ get: async () => 1, ...options })',
    'computed({ get: async () => 1, [key]: () => 0 })',
    'computed({ get get() { return async () => 1 } })'
  ])('does not infer async behavior through unknown or deferred getters: %s', (expression) => {
    expect(scriptDiagnostics(`import { computed } from 'vue'; ${expression}`, 'vue-computed-async-getter')).toEqual([])
  })

  test.each([
    'computed(function* () { yield count.value++ })',
    'computed({ *get() { yield count.value++ } })',
    'computed(async function* () { yield count.value++ })',
    'computed({ async *get() { yield count.value++ } })'
  ])('does not execute generator getter bodies when a computed value is read: %s', (expression) => {
    const diagnostics = diagnose(`<script setup>
import { computed, ref } from 'vue';
const count = ref(0);
${expression}
</script>`)
    expect(diagnostics.filter(diagnostic => scriptCodes.includes(diagnostic.code))).toEqual([])
  })

  test.each([
    ["import { computed as derive, ref as state } from 'vue'", 'derive', 'state'],
    ["import * as Vue from 'vue'", 'Vue.computed', 'Vue.ref'],
    ["import Vue from 'vue'", 'Vue.computed', 'Vue.ref']
  ])('uses Vue import provenance: %s', (imports, computed, ref) => {
    const diagnostics = diagnose(`<script setup>
${imports}
const count = ${ref}(0)
${computed}(async () => count.value++)
</script>`)
    for (const code of scriptCodes) {
      expect(diagnostics.filter((diagnostic) => diagnostic.code === code)).toHaveLength(1)
    }
  })

  test('uses only explicitly proven auto imports', () => {
    const source = '<script setup>const count = state(0); derive(async () => count.value++)</script>'
    const options = { autoImports: [{ local: 'derive', imported: 'computed' }, { local: 'state', imported: 'ref' }] }
    const diagnostics = diagnose(source, options)
    for (const code of scriptCodes) {
      expect(diagnostics.filter((diagnostic) => diagnostic.code === code)).toHaveLength(1)
    }
    expect(diagnose(source).filter((diagnostic) => scriptCodes.includes(diagnostic.code))).toEqual([])
    expect(diagnose(`<script setup>
function run(derive, state) { const count = state(0); derive(async () => count.value++) }
</script>`, options).filter((diagnostic) => scriptCodes.includes(diagnostic.code))).toEqual([])
  })

  test.each([
    "import { computed, ref } from 'another-library'; const count = ref(0); computed(async () => count.value++)",
    'function computed(getter) { return getter }; const count = { value: 0 }; computed(async () => count.value++)',
    "import { computed, ref } from 'vue'; const count = ref(0); function run(computed) { computed(async () => count.value++) }",
    "import * as Vue from 'vue'; const count = Vue.ref(0); function run(Vue) { Vue.computed(async () => count.value++) }"
  ])('excludes local, foreign and shadowed computed calls: %s', (script) => {
    expect(diagnose(`<script setup>${script}</script>`).filter((diagnostic) => scriptCodes.includes(diagnostic.code))).toEqual([])
  })

  test.each([
    ["const count = ref(0)", 'count.value = 1'],
    ["let count = ref(0)", 'count.value++'],
    ["const count = shallowRef(0)", "count['value'] += 1"],
    ["const state = ref({ nested: { value: 0 } })", 'delete state.value.nested.value'],
    ["const state = shallowRef({ nested: { value: 0 } })", 'state.value.nested.value++'],
    ["const state = reactive({ nested: { value: 0 } })", 'state.nested.value = 2'],
    ["const state = shallowReactive({ value: 0 })", 'state.value++']
  ])('reports direct external reactive writes: %s / %s', (declaration, mutation) => {
    const script = `import { computed, ref, shallowRef, reactive, shallowReactive } from 'vue'
${declaration}
computed(() => { ${mutation}; return 1 })`
    expect(scriptDiagnostics(script, 'vue-computed-source-mutation')).toEqual([
      expect.objectContaining({ severity: 'warning' })
    ])
  })

  test('reports destructuring source writes once per assignment without promoting local targets', () => {
    expect(scriptDiagnostics(`import { computed, ref } from 'vue'
const count = ref(0)
computed(() => {
  const local = ref(0)
  ;[local.value, count.value] = values
  ;({ next: count.value } = replacement)
  return local.value
})`, 'vue-computed-source-mutation')).toHaveLength(2)
  })

  test.each([
    'computed(() => count.value++)',
    'computed({ get() { count.value++; return count.value }, set(value) {} })',
    'computed({ get: () => count.value++, set: value => {} })',
    'computed({ ...options, get: () => count.value++ })',
    'computed({ get: () => 0, get: () => count.value++ })'
  ])('uses the same effective getter for source mutation: %s', (expression) => {
    expect(scriptDiagnostics(`import { computed, ref } from 'vue'; const count = ref(0); ${expression}`, 'vue-computed-source-mutation')).toHaveLength(1)
  })

  test.each([
    'computed({ get: () => count.value, set: value => { count.value = value } })',
    'computed(() => () => count.value++)',
    'computed(() => { function later() { count.value++ }; return later })',
    'computed(() => { const later = () => count.value++; return later })',
    'computed(() => ({ run() { count.value++ } }))',
    'computed(() => class { value = count.value++ })',
    'computed(() => { const count = ref(0); count.value++; return count.value })',
    'computed(() => { const state = reactive({ value: 0 }); state.value++; return state.value })',
    'computed(count => count.value++)',
    'computed(() => { { const count = { value: 0 }; count.value++ }; return 1 })',
    'computed(() => { let result = count.value; result++; return result })',
    'computed({ get: () => count.value++, get: () => 0 })',
    'computed({ get: () => count.value++, ...options })',
    'computed({ get: () => count.value++, [key]: getter })',
    'computed(getter)',
    'computed(() => count[value]++)',
    'computed(() => { const alias = count; alias.value++; return 1 })'
  ])('excludes setters, local state, shadows, deferred work and unknown getters: %s', (expression) => {
    const script = `import { computed, ref, reactive } from 'vue'; const count = ref(0); ${expression}`
    expect(scriptDiagnostics(script, 'vue-computed-source-mutation')).toEqual([])
  })

  test('tracks lexical source identity across getter parameter and block shadows', () => {
    expect(scriptDiagnostics(`import { computed, ref } from 'vue'
const count = ref(0)
computed(() => { { const count = ref(0); count.value++ }; return count.value++ })
computed(count => count.value++)`, 'vue-computed-source-mutation')).toHaveLength(1)
  })

  test.each([
    "import { computed } from 'vue'; import { ref } from 'another-library'; const count = ref(0); computed(() => count.value++)",
    "import { computed } from 'vue'; const count = { value: 0 }; computed(() => count.value++)",
    "import { computed, ref } from 'vue'; function run(ref) { const count = ref(0); computed(() => count.value++) }"
  ])('excludes unproven source bindings: %s', (script) => {
    expect(scriptDiagnostics(script, 'vue-computed-source-mutation')).toEqual([])
  })

  test.each([
    'count = { value: 0 }',
    'count++',
    '[count] = replacements',
    '({ count } = replacements)',
    '({ value: count = fallback } = replacements)',
    '[...count] = replacements',
    'for (count of replacements) {}',
    'for (count in replacements) {}',
    'function replace() { count = { value: 0 } }'
  ])('does not retain ref identity after a possible reassignment: %s', (reassignment) => {
    const script = `import { computed, ref } from 'vue'
let count = ref(0);
${reassignment}
computed(() => count.value++)`
    expect(scriptDiagnostics(script, 'vue-computed-source-mutation')).toEqual([])
  })

  test('invalidates binding identity even when a write appears after computed or before its declaration', () => {
    expect(scriptDiagnostics(`import { computed, ref, reactive } from 'vue'
function replace() { state = {} }
let state = reactive({ count: 0 })
let count = ref(0)
computed(() => { state.count++; return count.value++ })
count = { value: 0 }`, 'vue-computed-source-mutation')).toEqual([])
  })

  test('invalidates a second initializer of the same var binding without confusing a shadow', () => {
    expect(scriptDiagnostics(`import { computed, ref } from 'vue'
var count = ref(0)
var count = { value: 0 }
computed(() => count.value++)`, 'vue-computed-source-mutation')).toEqual([])
    expect(scriptDiagnostics(`import { computed, ref } from 'vue'
var count = ref(0)
for (var count of replacements) {}
computed(() => count.value++)`, 'vue-computed-source-mutation')).toEqual([])
    expect(scriptDiagnostics(`import { computed, ref } from 'vue'
const count = ref(0)
function change(count) { count = { value: 0 } }
computed(() => count.value++)`, 'vue-computed-source-mutation')).toHaveLength(1)
  })

  test.each([
    ['const items = ref([3, 1, 2])', 'items.value.sort()'],
    ['const items = shallowRef([3, 1, 2])', "items['value']['reverse']()"],
    ['const items = reactive([3, 1, 2])', 'items.reverse()']
  ])('reports direct known source-array mutation: %s', (declaration, expression) => {
    expect(scriptDiagnostics(`import { computed, ref, shallowRef, reactive } from 'vue'
${declaration}
computed(() => ${expression})`, 'vue-computed-source-mutation')).toHaveLength(1)
  })

  test.each([
    '[...items.value].sort()',
    'items.value.slice().reverse()',
    'items.value.filter(Boolean).sort()',
    'Array.from(items.value).reverse()',
    'items.value.toSorted()',
    'items.value[method]()'
  ])('does not confuse array copies or unknown methods with source mutation: %s', (expression) => {
    expect(scriptDiagnostics(`import { computed, ref } from 'vue'
const items = ref([3, 1, 2]); computed(() => ${expression})`, 'vue-computed-source-mutation')).toEqual([])
  })

  test.each([
    ['const items = ref({ sort() {} })', 'items.value.sort()'],
    ['const items = reactive({ reverse() {} })', 'items.reverse()'],
    ['const items = ref(loadItems())', 'items.value.sort()'],
    ['const items = reactive({ nested: [1, 2] })', 'items.nested.reverse()'],
    ['const source = ref([1, 2]); const items = source', 'items.value.reverse()']
  ])('requires proven array shape and direct source identity: %s', (declaration, expression) => {
    expect(scriptDiagnostics(`import { computed, ref, reactive } from 'vue'
${declaration}; computed(() => ${expression})`, 'vue-computed-source-mutation')).toEqual([])
  })

  test.each([
    "items.value = { sort() {} }",
    "items['value'] = unknown",
    'delete items.value',
    '[items.value] = replacements',
    '({ next: items.value } = replacements)',
    'items.value.sort = customSort',
    "items.value['reverse'] = customReverse",
    'items.value[key] = customMethod'
  ])('invalidates initialized array proof after replacement or method overrides: %s', (write) => {
    expect(scriptDiagnostics(`import { computed, ref } from 'vue'
const items = ref([1, 2]); ${write}; computed(() => items.value.sort())`, 'vue-computed-source-mutation')).toEqual([])
  })

  test('invalidates reactive array reassignments and method overrides, not element writes', () => {
    expect(scriptDiagnostics(`import { computed, reactive } from 'vue'
let items = reactive([1, 2]); items = { reverse() {} }; computed(() => items.reverse())`, 'vue-computed-source-mutation')).toEqual([])
    expect(scriptDiagnostics(`import { computed, reactive } from 'vue'
const items = reactive([1, 2]); items.reverse = custom; computed(() => items.reverse())`, 'vue-computed-source-mutation')).toEqual([])
    expect(scriptDiagnostics(`import { computed, ref, reactive } from 'vue'
const items = ref([1, 2]); items.value[0] = 3
const other = reactive([1, 2]); other[0] = 4
computed(() => items.value.reverse()); computed(() => other.sort())`, 'vue-computed-source-mutation')).toHaveLength(2)
  })

  test.each([
    'items[key].sort = () => []',
    '(items as any).value = { sort: () => [] }',
    '(items.value as any).sort = () => []',
    '(items!).value = { sort: () => [] }',
    'items.value!.sort = () => []',
    '(items satisfies { value: number[] }).value.sort = () => []'
  ])('drops array proof through unknown or type-wrapped direct receivers: %s', write => {
    const diagnostics = diagnose(`<script setup lang="ts">
import { computed, ref } from 'vue';
const items = ref([1, 2]);
const key = 'value';
${write};
computed(() => items.value.sort())
</script>`)
    expect(diagnostics.filter(diagnostic => diagnostic.code === 'vue-computed-source-mutation')).toEqual([])
  })

  test('keeps proven writes and array calls through type-only wrappers', () => {
    const diagnostics = diagnose(`<script setup lang="ts">
import { computed, ref, reactive } from 'vue';
const count = ref(0);
const state = reactive({ count: 0 });
const items = ref([2, 1]);
computed(() => (count as { value: number }).value++);
computed(() => count!.value++);
computed(() => (state satisfies { count: number }).count++);
computed(() => (items.value as number[]).sort());
computed((async () => count.value) as () => Promise<number>)
</script>`)
    expect(diagnostics.filter(diagnostic => diagnostic.code === 'vue-computed-source-mutation')).toHaveLength(4)
    expect(diagnostics.filter(diagnostic => diagnostic.code === 'vue-computed-async-getter')).toHaveLength(1)
  })

  test('keeps locally created arrays and deferred sorting outside the mutation contract', () => {
    expect(scriptDiagnostics(`import { computed, ref, reactive } from 'vue'
const items = ref([1, 2])
computed(() => { const local = ref([1, 2]); return local.value.reverse() })
computed(() => { const local = reactive([1, 2]); return local.sort() })
computed(() => () => items.value.reverse())`, 'vue-computed-source-mutation')).toEqual([])
  })

  test('supports plain scripts and legal previous-value parameters', () => {
    const diagnostics = diagnose(`<script>
import { computed, ref } from 'vue'
const count = ref(0)
computed(previous => previous ?? count.value)
computed(async previous => previous)
computed(previous => { count.value++; return previous })
</script>`, { vueVersion: '3.4.38' })
    for (const code of scriptCodes) {
      expect(diagnostics.filter((diagnostic) => diagnostic.code === code)).toHaveLength(1)
    }
  })

  test('keeps typed getter parameters and assignment targets in the same lexical contract', () => {
    const diagnostics = diagnose(`<script setup lang="ts">
import { computed, ref } from 'vue'
const count = ref<number>(0)
let replaced = ref<number>(0)
;(replaced as unknown) = replacement
computed(async (previous: number | undefined) => previous)
computed((previous: number | undefined) => { count.value++; return previous })
computed(() => replaced.value++)
</script>`, { vueVersion: '3.4.38' })
    for (const code of scriptCodes) {
      expect(diagnostics.filter((diagnostic) => diagnostic.code === code)).toHaveLength(1)
    }
  })
})

describe('native template contracts', () => {
  test.each([
    '<div @touchmove.passive.prevent="onMove" />',
    '<input @wheel.prevent.passive="onWheel" />',
    '<svg><path @click.passive.prevent="onClick" /></svg>',
    '<svg><linearGradient @click.prevent.passive="onClick" /></svg>',
    '<div @[event].passive.prevent="onEvent" />',
    '<div @touchmove.passive.prevent />',
    '<div v-on:touchmove.prevent.passive="onMove" />'
  ])('reports conflicting native DOM event modifiers: %s', (template) => {
    expect(diagnose(`<template>${template}</template>`).filter((diagnostic) => diagnostic.code === 'vue-event-passive-prevent'))
      .toEqual([expect.objectContaining({ severity: 'warning' })])
  })

  test.each([
    '<div @touchmove.prevent="onMove" />',
    '<div @touchmove.passive="onMove" />',
    '<MyButton @click.passive.prevent="onClick" />',
    '<my-button @click.passive.prevent="onClick" />',
    '<widget @click.passive.prevent="onClick" />',
    '<Div @click.passive.prevent="onClick" />',
    '<component :is="view" @click.passive.prevent="onClick" />',
    '<div is="vue:MyButton" @click.passive.prevent="onClick" />',
    '<div :is="view" @click.passive.prevent="onClick" />',
    '<div @vue:mounted.passive.prevent="onMounted" />',
    '<div v-on.passive.prevent="listeners" />'
  ])('excludes components, vnode hooks and nonconflicting listeners: %s', (template) => {
    expect(diagnose(`<template>${template}</template>`).filter((diagnostic) => diagnostic.code === 'vue-event-passive-prevent')).toEqual([])
  })

  test.each(['true', 'false', '0', "'text'", 'null', '/pattern/', '{ selected }'])('reports proven nonarray v-memo dependencies: %s', (expression) => {
    expect(diagnose(`<template><div v-memo="${expression}" /></template>`).filter((diagnostic) => diagnostic.code === 'vue-memo-invalid-dependencies'))
      .toEqual([expect.objectContaining({ severity: 'error' })])
  })

  test.each(['[]', '[selected]', '[...dependencies]', 'dependencies', 'makeDependencies()', 'enabled ? first : second', 'undefined', '() => []'])('does not infer unknown dependency shapes or missing dependencies: %s', (expression) => {
    expect(diagnose(`<template><div v-memo="${expression}" /></template>`).filter((diagnostic) => diagnostic.code === 'vue-memo-invalid-dependencies')).toEqual([])
  })

  test.each([
    '<TransitionGroup mode="out-in" />',
    '<transition-group mode="in-out" />',
    '<TransitionGroup :mode="\'out-in\'" />',
    '<TransitionGroup v-bind:mode="\'in-out\'" />',
    '<TransitionGroup :tag="wrapper" mode="out-in" />'
  ])('reports mode only on a static TransitionGroup identity: %s', (template) => {
    expect(diagnose(`<template>${template}</template>`).filter((diagnostic) => diagnostic.code === 'vue-transition-group-mode'))
      .toEqual([expect.objectContaining({ severity: 'warning' })])
  })

  test.each([
    '<Transition mode="out-in"><div /></Transition>',
    '<transition mode="out-in"><div /></transition>',
    '<transitiongroup mode="out-in" />',
    '<MyTransitionGroup mode="out-in" />',
    '<component :is="TransitionGroup" mode="out-in" />',
    '<TransitionGroup is="AnotherGroup" mode="out-in" />',
    '<TransitionGroup :is="AnotherGroup" mode="out-in" />',
    '<TransitionGroup mode />',
    '<TransitionGroup mode="" />',
    '<TransitionGroup :mode="\'\'" />',
    '<TransitionGroup :mode="undefined" />',
    '<TransitionGroup :mode="null" />',
    '<TransitionGroup :mode="mode" />',
    '<TransitionGroup :mode="getMode()" />',
    '<TransitionGroup :mode="false" />',
    '<TransitionGroup :[prop]="\'out-in\'" />',
    '<TransitionGroup v-bind="props" />'
  ])('excludes unknown or empty mode and other component identities: %s', (template) => {
    expect(diagnose(`<template>${template}</template>`).filter((diagnostic) => diagnostic.code === 'vue-transition-group-mode')).toEqual([])
  })
})

describe('Vue skills rule integration contracts', () => {
  test.each(featureCodes)('keeps %s opt-in with the correct parser requirements', (code) => {
    const definition = getVueRuleDefinition(code)!
    expect(isDoctorRuleEnabled(definition, {})).toBe(false)
    expect(isDoctorRuleEnabled(definition, { [code]: 'warning' })).toBe(true)
    expect(isDoctorRuleEnabled(definition, { [code]: 'off' })).toBe(false)
    expect(isVueRuleAvailable(code, '2.7.16')).toBe(false)
    expect(isVueRuleAvailable(code, undefined, { assumeLatest: false })).toBe(false)
  })

  test('gates memo at Vue 3.2 without suppressing the other Vue 3 rules', () => {
    const before = diagnose(allBad, { vueVersion: '3.1.5' }).map((diagnostic) => diagnostic.code)
    const after = diagnose(allBad, { vueVersion: '3.2.0' }).map((diagnostic) => diagnostic.code)
    expect(before).not.toContain('vue-memo-invalid-dependencies')
    for (const code of featureCodes) {
      if (code !== 'vue-memo-invalid-dependencies') expect(before).toContain(code)
      expect(after).toContain(code)
    }
  })

  test.each<VersionOptions>([
    { vueVersion: '2.7.16' },
    { assumeLatestVueVersion: false },
    { vueVersion: 'unknown', assumeLatestVueVersion: false }
  ])('does not emit Vue 3 rules without applicable version evidence: %j', (options) => {
    expect(diagnose(allBad, options).filter((diagnostic) => featureCodes.includes(diagnostic.code))).toEqual([])
  })

  test('reports one-based SFC locations for getters, mutations and directive attributes', () => {
    const source = `<script setup>
import { computed, ref } from 'vue'
const count = ref(0)
computed(async () => count.value)
computed(() => count.value++)
</script>
<template>
  <div @touchmove.passive.prevent="onMove" />
  <div v-memo="true" />
  <TransitionGroup mode="out-in" />
</template>`
    const diagnostics = diagnose(source)
    for (const [code, marker] of [
      ['vue-computed-async-getter', 'async () =>'],
      ['vue-computed-source-mutation', 'count.value++'],
      ['vue-event-passive-prevent', '@touchmove'],
      ['vue-memo-invalid-dependencies', 'v-memo'],
      ['vue-transition-group-mode', 'mode=']
    ]) {
      const offset = source.indexOf(marker!)
      const prefix = source.slice(0, offset)
      const line = prefix.split('\n').length
      const column = offset - prefix.lastIndexOf('\n')
      const matches = diagnostics.filter((diagnostic) => diagnostic.code === code)
      expect(matches).toHaveLength(1)
      expect(matches[0]?.evidence[0]).toMatchObject({ file, line, column })
    }
  })

  test.each(['script', 'script-setup'] as const)('preserves template diagnostics and failed %s rule evidence', (kind) => {
    const source = `<script${kind === 'script-setup' ? ' setup' : ''}>${badScript}; const = broken</script><template>${badTemplate}</template>`
    const parsed = parseVueSource(source, file)
    expect(parsed.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind, status: 'failed' }),
      expect.objectContaining({ kind: 'template', status: 'available' })
    ]))
    const codes = diagnoseVueSource({ file, source, parsed }).map((diagnostic) => diagnostic.code)
    const skipped = getVueRulesForFailedSourceBlock(kind).map((rule) => rule.code)
    for (const code of scriptCodes) {
      expect(codes).not.toContain(code)
      expect(skipped).toContain(code)
    }
    for (const code of templateCodes) expect(codes).toContain(code)
  })

  test('preserves script diagnostics and failed template rule evidence', () => {
    const source = `<script setup>${badScript}</script><template>${badTemplate}<span :value="broken(" /></template>`
    const parsed = parseVueSource(source, file)
    expect(parsed.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'template', status: 'failed' }),
      expect.objectContaining({ kind: 'script-setup', status: 'available' })
    ]))
    const codes = diagnoseVueSource({ file, source, parsed }).map((diagnostic) => diagnostic.code)
    const skipped = getVueRulesForFailedSourceBlock('template').map((rule) => rule.code)
    for (const code of templateCodes) {
      expect(codes).not.toContain(code)
      expect(skipped).toContain(code)
    }
    for (const code of scriptCodes) expect(codes).toContain(code)
  })
})

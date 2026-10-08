import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from 'vitest'
import { readSfcInteractions } from './runtime-interactions.js'

function interactions(source: string) {
  return readSfcInteractions(parse(source).descriptor)
}

describe('published SFC interaction evidence', () => {
  test('extracts positive event names without inventing signatures or borrowing another instance', async () => {
    const result = await interactions(`<script>
export default {
  name: 'ExampleInput',
  emits: ['declared'],
  components: { Child: { methods: { save() { this.$emit('child-only') } } } },
  methods: {
    change(value) {
      this.$emit('input', value)
      queueMicrotask(() => this.$emit('change', value))
      function detached() { this.$emit('detached') }
      const nested = { go() { this.$emit('nested') } }
      this.$emit(value)
      other.$emit('other')
      const text = "this.$emit('string')"
    }
  },
  computed: { selected: { set(value) { this.$emit('select', value) } } }
}
</script><template><button @click="$emit('click', $event)" /></template>`)
    expect([...result.events.keys()].sort()).toEqual(['change', 'click', 'declared', 'input', 'select'])
    expect(result.events.get('input')).toEqual({ name: 'input', source: 'emit', signatures: [] })
    expect(result.vue2Model).toEqual({ prop: 'value', event: 'input' })
  })

  test.each([
    ['{ model: { prop: "checked", event: "change" } }', { prop: 'checked', event: 'change' }],
    ['{ model: { event: "commit" } }', { prop: 'value', event: 'commit' }],
    ['{ model: external }', null],
    ['{ model: { event: name } }', null],
    ['{ ...external }', null],
    ['{ mixins: [external] }', null],
    ['{ extends: external }', null]
  ])('resolves model options conservatively: %s', async (options, expected) => {
    expect((await interactions(`<script>export default ${options}</script><template><div /></template>`)).vue2Model).toEqual(expected)
  })

  test.each([
    ['{ emit }', 'emit'],
    ['{ emit: dispatch }', 'dispatch'],
    ['context', 'context.emit'],
    ['context', 'context["emit"]']
  ])('reads the actual setup emitter through callbacks: %s', async (parameter, emitter) => {
    const result = await interactions(`<script>export default {
      setup(props, ${parameter}) {
        function handle(value) { ${emitter}('click', value) }
        queueMicrotask(() => ${emitter}('change'))
        return { handle }
      }
    }</script>`)
    expect([...result.events.keys()].sort()).toEqual(['change', 'click'])
    expect(result.events.get('click')?.signatures).toEqual([])
  })

  test('does not borrow shadowed setup emitters from functions, blocks, catches or loops', async () => {
    const result = await interactions(`<script>export default {
      setup(props, { emit }) {
        function own() { emit('own') }
        function other(emit) { emit('parameter') }
        { const emit = unrelated; emit('block') }
        try {} catch (emit) { emit('catch') }
        for (const emit of callbacks) emit('loop')
        const named = function emit() { emit('named') }
        return { own }
      }
    }</script>`)
    expect([...result.events.keys()]).toEqual(['own'])
  })

  test.each([
    'emit = unrelated; emit("reassigned")',
    '({ emit } = unrelated); emit("destructured")',
    'if (condition) { var emit = unrelated }; emit("hoisted")',
    'capture(emit); emit("escaped")'
  ])('keeps a mutable or escaped setup emitter unresolved: %s', async body => {
    const result = await interactions(`<script>export default { setup(props, { emit }) { ${body} } }</script>`)
    expect([...result.events.keys()]).toEqual([])
  })

  test('keeps context property writes unresolved and excludes shadowed contexts', async () => {
    const shadowed = await interactions(`<script>export default { setup(props, ctx) {
      function own() { ctx.emit('own') }
      function other(ctx) { ctx.emit('other') }
      return { own }
    } }</script>`)
    const mutated = await interactions(`<script>export default { setup(props, ctx) {
      ctx.emit = unrelated; ctx.emit('not-proven')
    } }</script>`)
    expect([...shadowed.events.keys()]).toEqual(['own'])
    expect([...mutated.events.keys()]).toEqual([])
  })

  test('uses only the effective setup option after static overrides', async () => {
    const result = await interactions(`<script>export default {
      setup(props, { emit }) { emit('overridden') },
      ...unknown,
      setup(props, { emit }) { emit('effective') }
    }</script>`)
    const unknown = await interactions(`<script>export default {
      setup(props, { emit }) { emit('not-proven') },
      ...external
    }</script>`)
    const computed = await interactions(`<script>export default {
      setup(props, { emit }) { emit('not-proven') },
      [key]: external
    }</script>`)
    expect([...result.events.keys()]).toEqual(['effective'])
    expect([...unknown.events.keys()]).toEqual([])
    expect([...computed.events.keys()]).toEqual([])
  })

  test('does not borrow a hoisted setup emitter behind an unrelated $emit parameter', async () => {
    const result = await interactions(`<script>export default { setup(props, { emit }) {
      function nested($emit) {
        if (condition) { var emit = unrelated }
        emit('not-the-setup-emitter')
      }
      return { nested }
    } }</script>`)
    expect([...result.events.keys()]).toEqual([])
  })

  test('keeps nested class instances out of component event evidence', async () => {
    const result = await interactions(`<script>export default { methods: { create() {
      class Other {
        field = () => this.$emit('field')
        #private() { this.$emit('private') }
        static { this.$emit('static') }
      }
      queueMicrotask(() => this.$emit('own'))
    } } }</script>`)
    expect([...result.events.keys()]).toEqual(['own'])
  })

  test.each([
    'const Alias = Base; Alias.methods.save = unrelated',
    'const Alias = Base; const Second = Alias; capture(Second)',
    'const { methods } = Base; methods.save = unrelated',
    'const holder = { base: Base }; holder.base.model.event = "new"',
    'capture({ base: Base })',
    'capture([Base])',
    'capture(() => Base)',
    'function getter() { return Base }; capture(getter)'
  ])('invalidates inherited contracts through mutable aliases: %s', async mutation => {
    const result = await interactions(`<script>
      const Base = { model: { event: 'old' }, methods: { save() { this.$emit('old') } } }
      ${mutation}
      export default { mixins: [Base], emits: ['own'] }
    </script>`)
    expect([...result.events.keys()]).toEqual(['own'])
    expect(result.vue2Model).toBeNull()
  })

  test('retains stable local option aliases', async () => {
    const result = await interactions(`<script>
      const Base = { model: { event: 'select' }, methods: { save() { this.$emit('select') } } }
      const Alias = Base
      export default { mixins: [Alias] }
    </script>`)
    expect([...result.events.keys()]).toEqual(['select'])
    expect(result.vue2Model).toEqual({ prop: 'value', event: 'select' })
  })

  test.each([
    `watch: { value() { this.$emit('stale') }, value() { this.$emit('own') } }`,
    `watch: { value() { this.$emit('stale') }, ...unknown, next() { this.$emit('own') } }`,
    `watch: { value: { handler() { this.$emit('stale') }, handler() { this.$emit('own') } } }`,
    `computed: { value: { get() { this.$emit('stale') }, ...unknown, set() { this.$emit('own') } } }`
  ])('reads only effective callback properties: %s', async options => {
    const result = await interactions(`<script>export default { ${options} }</script>`)
    expect([...result.events.keys()]).toEqual(['own'])
  })

  test('does not read Options setup replaced by a script-setup block', async () => {
    const result = await interactions(`<script>
      const Base = { setup(props, { emit }) { emit('inherited') } }
      export default { mixins: [Base], setup(props, { emit }) { emit('obsolete') },
        created() { this.$emit('created') } }
    </script><script setup>const emit = defineEmits(['current'])</script>`)
    expect(new Set(result.events.keys())).toEqual(new Set(['created', 'current']))
  })

  test('reads the generated emits declaration while retaining live method calls', async () => {
    const result = await interactions(`<script>export default {
      emits: ['obsolete'], methods: { save() { this.$emit('live') } }
    }</script><script setup>defineEmits(['current'])</script>`)
    expect([...result.events.keys()].sort()).toEqual(['current', 'live'])
  })

  test('does not infer framework-dependent inherited setup execution', async () => {
    const result = await interactions(`<script>export default {
      mixins: [{ setup(props, { emit }) { emit('vue2-only') } }],
      methods: { save() { this.$emit('own') } }
    }</script>`)
    expect([...result.events.keys()]).toEqual(['own'])
  })

  test.each([
    `<Wrap v-slot="{ $emit }"><button @click="$emit('shadowed')" /></Wrap>`,
    `<button v-for="$emit in callbacks" @click="$emit('shadowed')" />`,
    `<button v-for="(item, $emit) in callbacks" @click="$emit('shadowed')" />`,
    `<button @click="() => { const $emit = () => {}; $emit('shadowed') }" />`,
    `<button @click="({ $emit }) => $emit('shadowed')" />`
  ])('does not borrow template scope emitters: %s', async template => {
    const result = await interactions(`<template><main>${template}<button @click="$emit('own')" /></main></template>`)
    expect([...result.events.keys()]).toEqual(['own'])
  })

  test('separates slot child bindings from component listeners and script-setup bindings', async () => {
    const slot = await interactions(`<template>
      <Wrap v-slot="{ $emit }" @click="$emit('own')"><button @click="$emit('shadowed')" /></Wrap>
    </template>`)
    const setup = await interactions(`<script setup>const $emit = () => {}</script>
      <template><button @click="$emit('shadowed')" /></template>`)
    expect([...slot.events.keys()]).toEqual(['own'])
    expect([...setup.events.keys()]).toEqual([])
  })

  test('reads declared setup events without treating nested calls or shadowed template names as emitters', async () => {
    const result = await interactions(`<script setup>
const emit = defineEmits(['change', 'update:modelValue'])
function helper() { defineEmits(['not-a-macro']) }
</script><template><button @click="($emit) => $emit('shadowed')" /></template>`)
    expect([...result.events.keys()]).toEqual(['change', 'update:modelValue'])
  })
})

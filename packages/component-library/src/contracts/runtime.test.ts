import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComponentLibraryEvidence } from '../types.js'
import { afterEach, describe, expect, test } from 'vitest'
import { readRuntimeFallthrough } from './runtime.js'
import { extractComponentLibraryContractsWithReaders } from './merge.js'
import type { ComponentContract } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string>): Promise<ComponentLibraryEvidence> {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-runtime-'))
  roots.push(root)
  await Promise.all(Object.entries(files).map(async ([relativePath, contents]) => {
    const path = join(root, relativePath)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents, 'utf8')
  }))
  return {
    package: {
      dependencyName: 'fixture-ui',
      canonicalName: 'fixture-ui',
      installedVersion: '1.0.0',
      packageJsonPath: join(root, 'package.json'),
      packageRoot: root,
      importRoots: ['fixture-ui'],
      source: 'installed'
    },
    artifacts: {
      declarationEntries: [],
      runtimeEntries: [{
        path: join(root, 'index.mjs'),
        relativePath: 'index.mjs',
        source: 'exports',
        entry: '.'
      }],
      issues: []
    }
  }
}

async function publicContracts(evidence: ComponentLibraryEvidence, declaration?: ComponentContract) {
  return extractComponentLibraryContractsWithReaders(evidence, {
    readMetadata: async () => [],
    readDeclarations: async () => ({
      components: new Map(declaration ? [[declaration.name, declaration]] : []), sources: [], problems: []
    }),
    readRuntime: readRuntimeFallthrough
  })
}

describe('runtime attribute fallthrough', () => {
  test('extracts child forwarding, native roots, and closed inheritance', async () => {
    const evidence = await fixture({
      'index.mjs': `
export { default as ExampleWrapper } from './wrapper.vue.mjs'
export { default as ExampleLink } from './link.vue.mjs'
export { default as ClosedPanel } from './closed.vue.mjs'
`,
      'wrapper.vue.mjs': `
import { defineComponent, createBlock, mergeProps, unref } from 'vue'
import { InnerDialog } from './dialog.mjs'
export default defineComponent({
  name: 'ExampleWrapper',
  setup() {
    return (_ctx) => createBlock(unref(InnerDialog), mergeProps(_ctx.$attrs, { class: 'wrapper' }))
  }
})
`,
      'dialog.mjs': `
export const InnerDialog = { name: 'InnerDialog', props: { title: String } }
`,
      'link.vue.mjs': `
import { defineComponent, createElementBlock } from 'vue'
export default defineComponent({
  name: 'ExampleLink',
  setup() {
    return () => createElementBlock('a', { href: '/' })
  }
})
`,
      'closed.vue.mjs': `
import { defineComponent, createElementBlock } from 'vue'
export default defineComponent({
  name: 'ClosedPanel',
  inheritAttrs: false,
  setup() {
    return () => createElementBlock('section')
  }
})
`,
      'unresolved-props.vue.mjs': `
import { defineComponent, createElementBlock } from 'vue'
import { inputProps } from './input-props.mjs'
export default defineComponent({
  name: 'UnresolvedInput',
  inheritAttrs: false,
  props: inputProps,
  setup() {
    return () => createElementBlock('input')
  }
})
`
    })

    const result = await readRuntimeFallthrough(evidence)

    expect(result.components.get('ExampleWrapper')).toMatchObject({
      attributes: 'unknown',
      attributeTargets: [{ kind: 'component', name: 'InnerDialog' }]
    })
    expect(result.components.get('ExampleLink')).toMatchObject({
      attributes: 'unknown',
      attributeTargets: [{ kind: 'element', name: 'a' }]
    })
    expect(result.components.get('ExampleLink')?.attributeTargets?.[0]).toMatchObject({
      supportedAttributes: expect.arrayContaining(['target', 'href'])
    })
    expect(result.components.get('ClosedPanel')).toMatchObject({
      attributes: 'closed',
      attributeTargets: []
    })
    expect(result.components.get('UnresolvedInput')).toMatchObject({
      attributes: 'unknown',
      attributeTargets: []
    })
  })

  test('keeps a fragment root closed when no explicit $attrs target exists', async () => {
    const evidence = await fixture({
      'index.mjs': `
import { defineComponent, Fragment, createElementBlock, openBlock } from 'vue'
export default defineComponent({
  name: 'FragmentPanel',
  setup() {
    return () => (openBlock(), createElementBlock(Fragment, null, []))
  }
})
`
    })

    const result = await readRuntimeFallthrough(evidence)

    expect(result.components.get('FragmentPanel')).toMatchObject({
      attributes: 'closed',
      attributeTargets: []
    })
  })

  test('prefers published SFC templates for explicit forwarding targets', async () => {
    const evidence = await fixture({
      'index.mjs': 'export {}\n',
      'SourceWrapper.vue': `
<script setup lang="ts">
defineOptions({ name: 'SourceWrapper' })
</script>
<template>
  <InnerDialog v-bind="$attrs" />
</template>
`
    })

    const result = await readRuntimeFallthrough(evidence)

    expect(result.components.get('SourceWrapper')).toMatchObject({
      attributes: 'unknown',
      attributeTargets: [{ kind: 'component', name: 'InnerDialog' }]
    })
  })

  test('extracts published SFC slot outlets under the declared component name', async () => {
    const evidence = await fixture({
      'index.mjs': 'export {}\n',
      'table.vue': `
<script>
/* ${'x'.repeat(900)} */
const table = { name: 'ElTable' }
export default table
</script>
<template>
  <div>
    <slot />
    <slot name="empty" />
    <slot name="append" />
  </div>
</template>
`,
      'DynamicSlots.vue': `
<script setup>const current = 'header'</script>
<template><slot :name="current" /></template>
`,
      'SpreadSlots.vue': `
<script setup>const current = 'header'</script>
<template><slot v-bind="{ name: current }" /></template>
`
    })

    const result = await readRuntimeFallthrough(evidence)

    expect([...result.slots.get('ElTable')!.keys()]).toEqual(['append', 'default', 'empty'])
    expect(result.dynamicSlots.has('DynamicSlots')).toBe(true)
    expect(result.slots.get('DynamicSlots')?.has('default')).not.toBe(true)
    expect(result.dynamicSlots.has('SpreadSlots')).toBe(true)
    expect(result.slots.get('SpreadSlots')?.has('default')).not.toBe(true)
  })

  test('follows attrs-derived values through compiled runtime transforms', async () => {
    const evidence = await fixture({
      'index.mjs': `
export { DerivedInput } from './derived-input.mjs'
export { ContextButton } from './context-button.mjs'
export { SpreadSection } from './spread-section.mjs'
export { ReadOnlyAttrs } from './read-only-attrs.mjs'
`,
      'derived-input.mjs': `
import { computed, createElementBlock, defineComponent, mergeProps, unref, useAttrs } from 'vue'

export const DerivedInput = defineComponent({
  name: 'DerivedInput',
  inheritAttrs: false,
  setup() {
    const attrs = useAttrs()
    const forwarded = computed(() => {
      const { class: ignoredClass, ...rest } = attrs
      return rest
    })
    return () => createElementBlock('input', mergeProps(unref(forwarded), { type: 'text' }))
  }
})
`,
      'context-button.mjs': `
import { createElementBlock, defineComponent } from 'vue'
export const ContextButton = defineComponent({
  name: 'ContextButton',
  inheritAttrs: false,
  setup(_props, { attrs }) {
    const forwarded = attrs
    return () => createElementBlock('button', forwarded)
  }
})
`,
      'spread-section.mjs': `
import { createElementBlock, defineComponent, useAttrs } from 'vue'
export const SpreadSection = defineComponent({
  name: 'SpreadSection',
  inheritAttrs: false,
  setup() {
    const attrs = useAttrs()
    const forwarded = { ...attrs, role: 'region' }
    return () => createElementBlock('section', forwarded)
  }
})
`,
      'read-only-attrs.mjs': `
import { createElementBlock, defineComponent, useAttrs } from 'vue'
export const ReadOnlyAttrs = defineComponent({
  name: 'ReadOnlyAttrs',
  inheritAttrs: false,
  setup() {
    const attrs = useAttrs()
    console.log(attrs)
    return () => createElementBlock('div')
  }
})
`
    })

    const result = await readRuntimeFallthrough(evidence)

    expect(result.components.get('DerivedInput')).toMatchObject({
      attributes: 'unknown',
      attributeTargets: [{
        kind: 'element',
        name: 'input',
        excludedAttributes: ['class']
      }]
    })
    expect(result.components.get('ContextButton')).toMatchObject({
      attributes: 'unknown',
      attributeTargets: [{ kind: 'element', name: 'button' }]
    })
    expect(result.components.get('SpreadSection')).toMatchObject({
      attributes: 'unknown',
      attributeTargets: [{ kind: 'element', name: 'section' }]
    })
    expect(result.components.get('ReadOnlyAttrs')).toMatchObject({
      attributes: 'closed',
      attributeTargets: []
    })
  })

  test('extracts statically published SFC props without opening unresolved boundaries', async () => {
    const evidence = await fixture({
      'index.mjs': 'export {}\n',
      'OptionsObject.vue': `
<script>
import { externalProps } from './external-props.mjs'
export default { props: { label: String, ...externalProps } }
</script>
<template><div /></template>
`,
      'OptionsArray.vue': `
<script>export default { props: ['size', 'tone'] }</script>
<template><div /></template>
`,
      'SetupRuntime.vue': `
<script setup>defineProps({ visible: Boolean })</script>
<template><div /></template>
`,
      'SetupArray.vue': `
<script setup>defineProps(['active'])</script>
<template><div /></template>
`,
      'SetupType.vue': `
<script setup lang="ts">defineProps<{ modelValue: string; optional?: number }>()</script>
<template><div /></template>
`
    })

    const result = await readRuntimeFallthrough(evidence)

    expect([...result.props.get('OptionsObject')!.keys()]).toEqual(['label'])
    expect(result.props.get('OptionsObject')?.get('label')).toEqual({ name: 'label' })
    expect([...result.props.get('OptionsArray')!.keys()]).toEqual(['size', 'tone'])
    expect([...result.props.get('SetupRuntime')!.keys()]).toEqual(['visible'])
    expect([...result.props.get('SetupArray')!.keys()]).toEqual(['active'])
    expect([...result.props.get('SetupType')!.keys()]).toEqual(['modelValue', 'optional'])
  })

  test('extracts Options API props from compiled script AST when bindings are empty', async () => {
    const evidence = await fixture({
      'index.mjs': 'export {}\n',
      'VueCropper.vue': `
<script>
export default {
  props: {
    img: { type: [String, Blob, null, File], default: '' },
    outputSize: { type: Number, default: 1 },
    canScale: Boolean
  }
}
</script>
<template><div /></template>
`
    })

    const result = await readRuntimeFallthrough(evidence)

    expect(new Set(result.props.get('VueCropper')!.keys())).toEqual(new Set(['canScale', 'img', 'outputSize']))
  })

  test('extracts required flags and runtime prop types from SFC props options', async () => {
    const evidence = await fixture({
      'index.mjs': 'export {}\n',
      'RequiredObject.vue': `
<script>
export default {
  props: {
    label: { type: String, required: true },
    count: { type: Number, default: 0 },
    tags: { type: [String, Array] },
    disabled: Boolean
  }
}
</script>
<template><div /></template>
`,
      'SetupRequired.vue': `
<script setup>
defineProps({
  title: { type: String, required: true },
  open: Boolean
})
</script>
<template><div /></template>
`,
      'SetupTypeRequired.vue': `
<script setup lang="ts">
defineProps<{ modelValue: string; optional?: number; active: boolean }>()
</script>
<template><div /></template>
`
    })

    const result = await readRuntimeFallthrough(evidence)

    expect(result.props.get('RequiredObject')?.get('label')).toEqual({
      name: 'label',
      required: true,
      types: [{ kind: 'string' }]
    })
    expect(result.props.get('RequiredObject')?.get('count')).toEqual({
      name: 'count',
      required: false,
      types: [{ kind: 'number' }]
    })
    expect(result.props.get('RequiredObject')?.get('tags')).toEqual({
      name: 'tags',
      required: false,
      types: [{ kind: 'string' }, { kind: 'array' }]
    })
    expect(result.props.get('RequiredObject')?.get('disabled')).toEqual({
      name: 'disabled',
      required: false,
      types: [{ kind: 'boolean' }]
    })
    expect(result.props.get('SetupRequired')?.get('title')).toEqual({
      name: 'title',
      required: true,
      types: [{ kind: 'string' }]
    })
    expect(result.props.get('SetupTypeRequired')?.get('modelValue')).toEqual({
      name: 'modelValue',
      required: true,
      types: [{ kind: 'string' }]
    })
    expect(result.props.get('SetupTypeRequired')?.get('optional')).toEqual({
      name: 'optional',
      required: false,
      types: [{ kind: 'number' }]
    })
    expect(result.props.get('SetupTypeRequired')?.get('active')).toEqual({
      name: 'active',
      required: true,
      types: [{ kind: 'boolean' }]
    })
  })

  test('opens only structurally proven external option surfaces', async () => {
    const evidence = await fixture({
      'index.mjs': `
export { ProvenEngine } from './proven-engine.mjs'
export { ReadOnlyEngine } from './read-only-engine.mjs'
export { CreateOnlyEngine } from './create-only-engine.mjs'
export { LocalHelperEngine } from './local-helper-engine.mjs'
`,
      'proven-engine.mjs': `
import { defineComponent, createElementBlock, useAttrs } from 'vue'
import { createEngine } from 'external-engine'
export const ProvenEngine = defineComponent({
  name: 'ProvenEngine',
  inheritAttrs: false,
  setup() {
    const attrs = useAttrs()
    const options = { ...attrs }
    const engine = createEngine(options)
    engine.reconfigure({ ...attrs })
    return () => createElementBlock('div')
  }
})
`,
      'read-only-engine.mjs': `
import { defineComponent, createElementBlock, useAttrs } from 'vue'
export const ReadOnlyEngine = defineComponent({
  name: 'ReadOnlyEngine',
  inheritAttrs: false,
  setup() {
    const attrs = useAttrs()
    console.log(attrs)
    return () => createElementBlock('div')
  }
})
`,
      'create-only-engine.mjs': `
import { defineComponent, createElementBlock, useAttrs } from 'vue'
import { createEngine } from 'external-engine'
export const CreateOnlyEngine = defineComponent({
  name: 'CreateOnlyEngine',
  inheritAttrs: false,
  setup() {
    const attrs = useAttrs()
    createEngine({ ...attrs })
    return () => createElementBlock('div')
  }
})
`,
      'local-helper-engine.mjs': `
import { defineComponent, createElementBlock, useAttrs } from 'vue'
function createEngine(options) { return { update(next) {} } }
export const LocalHelperEngine = defineComponent({
  name: 'LocalHelperEngine',
  inheritAttrs: false,
  setup() {
    const attrs = useAttrs()
    const engine = createEngine({ ...attrs })
    engine.update({ ...attrs })
    return () => createElementBlock('div')
  }
})
`
    })

    const result = await readRuntimeFallthrough(evidence)

    expect(result.components.get('ProvenEngine')?.attributes).toBe('open')
    expect(result.components.get('ReadOnlyEngine')?.attributes).toBe('closed')
    expect(result.components.get('CreateOnlyEngine')?.attributes).not.toBe('open')
    expect(result.components.get('LocalHelperEngine')?.attributes).not.toBe('open')
  })
  test('resolves package-local model inheritance with precedence, provenance, and cycle guards', async () => {
    const evidence = await fixture({
      'index.mjs': 'export {}',
      'base.ts': 'export default { model: { prop: "selected", event: "select" } }',
      'plain.ts': 'export default { methods: { noop() {} } }',
      'factory.ts': 'export default function(ref) { return { methods: { focus() { return this.$refs[ref] } } } }',
      'dynamic-factory.ts': 'export default function(event) { return { model: { event } } }',
      'shadowed-factory.ts': 'import base from "./base"; export default function(base) { return { extends: base } }',
      'Factory.vue': '<script>import factory from "./factory"; export default { name: "Factory", mixins: [factory("control")] }</script><template><div /></template>',
      'DynamicFactory.vue': '<script>import factory from "./dynamic-factory"; export default { name: "DynamicFactory", mixins: [factory("commit")] }</script><template><div /></template>',
      'ShadowedFactory.vue': '<script>import factory from "./shadowed-factory"; export default { name: "ShadowedFactory", mixins: [factory("control")] }</script><template><div /></template>',
      'cycle-a.ts': 'import base from "./cycle-b"; export default { extends: base }',
      'cycle-b.ts': 'import base from "./cycle-a"; export default { extends: base }',
      'Inherited.vue': '<script>import base from "./base"; export default { name: "Inherited", mixins: [base], methods: { select(value) { this.$emit("select", value) } } }</script><template><div /></template>',
      'DefaultModel.vue': '<script>import plain from "./plain"; export default { name: "DefaultModel", mixins: [plain] }</script><template><div /></template>',
      'Override.vue': '<script>import base from "./base"; export default { name: "Override", extends: base, model: { event: "commit" } }</script><template><div /></template>',
      'Cycle.vue': '<script>import base from "./cycle-a"; export default { name: "Cycle", mixins: [base] }</script><template><div /></template>',
      'Unknown.vue': '<script>import base from "../outside"; export default { name: "Unknown", mixins: [base] }</script><template><div /></template>'
    })
    const result = await readRuntimeFallthrough(evidence)
    expect(result.vue2Models.get('Inherited')).toEqual({ prop: 'selected', event: 'select' })
    expect(result.vue2Models.get('DefaultModel')).toEqual({ prop: 'value', event: 'input' })
    expect(result.vue2Models.get('Factory')).toEqual({ prop: 'value', event: 'input' })
    expect(result.vue2Models.get('DynamicFactory')).toBeNull()
    expect(result.vue2Models.get('ShadowedFactory')).toBeNull()
    expect(result.vue2Models.get('Override')).toEqual({ prop: 'value', event: 'commit' })
    expect(result.vue2Models.get('Cycle')).toBeNull()
    expect(result.vue2Models.get('Unknown')).toBeNull()
    expect(result.events.get('Inherited')?.get('select')).toEqual({ name: 'select', source: 'emit', signatures: [] })
    expect(result.componentSources.get('Inherited')?.map(source => source.relativePath).sort()).toEqual(['Inherited.vue', 'base.ts'])
  })

  test('reads published JSX and TypeScript options with inherited events, overrides, and provenance', async () => {
    const evidence = await fixture({
      'index.mjs': 'export {}',
      'Pager.jsx': `export default {
        name: 'ExamplePager',
        methods: { change(value) { this.$emit('current-change', value) } },
        render(h) { return <div /> }
      }`,
      'Base.vue': `<script>export default {
        model: { prop: 'selected', event: 'select' },
        methods: {
          select(value) { this.$emit('select', value) },
          replace() { this.$emit('old') }
        },
        created() { this.$emit('base-created') }
      }</script><template><div /></template>`,
      'Picker.ts': `import { defineComponent as component } from 'vue'
        import Base from './Base.vue'
        export default component({
          name: 'ExamplePicker', mixins: [Base],
          methods: { replace() { this.$emit('new') } },
          created() { this.$emit('child-created') }
        })`,
      'Fake.ts': `import { defineComponent } from 'not-vue'
        export default defineComponent({ name: 'Fake', methods: { save() { this.$emit('fake') } } })`,
      'Unknown.ts': `import Base from 'outside'
        export default { name: 'Unknown', mixins: [Base], methods: { save() { this.$emit('own') } } }`,
      'Ignored.d.ts': `export default { name: 'Ignored', emits: ['not-runtime'] }`
    })
    const result = await readRuntimeFallthrough(evidence)
    expect([...result.events.get('ExamplePager')!.keys()]).toEqual(['current-change'])
    expect([...result.events.get('ExamplePicker')!.keys()].sort()).toEqual(['base-created', 'child-created', 'new', 'select'])
    expect(result.vue2Models.get('ExamplePicker')).toEqual({ prop: 'selected', event: 'select' })
    expect(result.componentSources.get('ExamplePicker')?.map(source => source.relativePath).sort()).toEqual(['Base.vue', 'Picker.ts'])
    expect(result.events.get('Fake')).toBeUndefined()
    expect(result.events.get('Ignored')).toBeUndefined()
    expect([...result.events.get('Unknown')!.keys()]).toEqual(['own'])
    expect(result.vue2Models.get('Unknown')).toBeNull()
  })

  test('drops inherited event proof across unknown overrides without losing explicit child methods', async () => {
    const evidence = await fixture({
      'index.mjs': 'export {}',
      'base.js': `export default { methods: { save() { this.$emit('inherited') } } }`,
      'Child.vue': `<script>import Base from './base'
        export default { name: 'Child', mixins: [Base, external],
          model: { event: 'own' }, methods: { save() { this.$emit('own') } }
        }</script><template><div /></template>`,
      'UnknownMethods.vue': `<script>import Base from './base'
        export default { name: 'UnknownMethods', extends: Base, methods: external }
        </script><template><div /></template>`
    })
    const result = await readRuntimeFallthrough(evidence)
    expect([...result.events.get('Child')!.keys()]).toEqual(['own'])
    expect(result.vue2Models.get('Child')).toEqual({ prop: 'value', event: 'own' })
    expect(result.events.get('UnknownMethods')).toBeUndefined()
  })

  test.each([
    'Base.methods.save = replacement',
    'mutate(Base)'
  ])('does not trust inherited options after a mutation or escape: %s', async mutation => {
    const evidence = await fixture({
      'index.mjs': 'export {}',
      'base.js': `export default { model: { event: 'old' }, methods: { save() { this.$emit('old') } } }`,
      'Child.ts': `import Base from './base'
        ${mutation}
        export default { name: 'Child', mixins: [Base], methods: { own() { this.$emit('own') } } }`
    })
    const result = await readRuntimeFallthrough(evidence)
    expect([...result.events.get('Child')!.keys()]).toEqual(['own'])
    expect(result.vue2Models.get('Child')).toBeNull()
  })

  test('inherits effective SFC declarations rather than options replaced by script setup', async () => {
    const evidence = await fixture({
      'index.mjs': 'export {}',
      'Base.vue': `<script>export default {
        emits: ['obsolete'], setup(props, { emit }) { emit('obsolete-setup') },
        methods: { save() { this.$emit('live') } }
      }</script><script setup>defineEmits(['current'])</script>`,
      'Child.ts': `import Base from './Base.vue'; export default { name: 'Child', extends: Base }`
    })
    const result = await readRuntimeFallthrough(evidence)
    expect([...result.events.get('Child')!.keys()].sort()).toEqual(['current', 'live'])
  })

  test('does not execute published props while collecting interaction evidence', async () => {
    const key = '__vueDoctorRuntimePropsExecuted'
    const globals = globalThis as unknown as Record<string, unknown>
    delete globals[key]
    const evidence = await fixture({
      'index.mjs': 'export {}',
      'Safe.vue': `<script>
export default {
  name: 'Safe',
  props: { value: { type: String, default: (globalThis.${key} = true) } },
  methods: { commit(value) { this.$emit('input', value) } }
}
</script><template><div /></template>`
    })
    try {
      const result = await readRuntimeFallthrough(evidence)
      expect(globals[key]).toBeUndefined()
      expect(result.props.get('Safe')?.get('value')).toMatchObject({ name: 'value', types: [{ kind: 'string' }] })
      expect(result.events.get('Safe')?.has('input')).toBe(true)
    } finally {
      delete globals[key]
    }
  })
  test('seeds only proven public SFC identities, retaining aliases and inherited positive evidence', async () => {
    const evidence = await fixture({
      'index.mjs': `export { default, default as PublicPicker } from './Picker.vue'`,
      'Picker.vue': `<script>
        import base from './base'
        export default { name: 'InternalPicker', mixins: [base], props: { own: Boolean } }
        </script><template><div><slot name="label" /><button @click="$emit('commit')" /></div></template>`,
      'base.ts': `export default {
        props: { selected: { type: String, required: true } },
        model: { prop: 'selected', event: 'commit' },
        methods: { change() { this.$emit('change') } }
      }`,
      'demo/Private.vue': `<script>export default { name: 'Private' }</script><template><div /></template>`,
      'demo/Impostor.vue': `<script>export default {
        name: 'InternalPicker', props: { injected: String }, emits: ['injected']
      }</script><template><slot name="injected" /></template>`
    })
    const result = await publicContracts(evidence)
    const component = result.components.get('PublicPicker')!
    expect(component).toBe(result.components.get('default'))
    expect(component).toBe(result.components.get('InternalPicker'))
    expect(result.components.has('Private')).toBe(false)
    expect([...component.props.entries.keys()].sort()).toEqual(['own', 'selected'])
    expect(component.props.entries.get('selected')).toMatchObject({ required: true, types: [{ kind: 'string' }] })
    expect([...component.events.entries.keys()].sort()).toEqual(['change', 'commit'])
    expect(component.events.entries.get('commit')?.signatures).toEqual([])
    expect([...component.slots.entries.keys()]).toEqual(['label'])
    expect(component.vue2Model).toEqual({ prop: 'selected', event: 'commit' })
    for (const dimension of [component.props, component.events, component.slots]) {
      expect(dimension.knowledge).toBe('partial')
      expect(dimension.acceptance).toBe('unknown')
    }
    expect(component.sources.some(source => source.relativePath === 'base.ts')).toBe(true)
  })

  test('connects named JS/TS option exports and imported static props without assuming a default', async () => {
    const evidence = await fixture({
      'index.mjs': `export { Editor as RichEditor } from './editor'; export { Button } from './button'`,
      'editor.ts': `import { editorProps } from './props'
        export var Editor = {
          props: editorProps, model: { prop: 'content', event: 'change' },
          methods: { change() { this.$emit('change') } },
          render(h) {
            const ignored = function () { return this.$slots.unrelated }
            return h('section', [this.$slots.default, this.$scopedSlots.toolbar()])
          }
        }`,
      'props.ts': `export var editorProps = { content: String, disabled: Boolean }`,
      'button.js': `import { defineComponent } from 'vue'
        export const Button = defineComponent({ name: 'InternalButton', props: ['label'], render() {} })`
    })
    const result = await publicContracts(evidence)
    const editor = result.components.get('RichEditor')!
    expect([...editor.props.entries.keys()].sort()).toEqual(['content', 'disabled'])
    expect([...editor.slots.entries.keys()].sort()).toEqual(['default', 'toolbar'])
    expect(editor.events.entries.get('change')).toEqual({ name: 'change', source: 'emit', signatures: [] })
    expect(editor.vue2Model).toEqual({ prop: 'content', event: 'change' })
    expect(result.components.get('Button')).toBe(result.components.get('InternalButton'))
    expect(result.components.has('default')).toBe(false)
    expect(editor.sources.some(source => source.relativePath === 'props.ts')).toBe(true)
  })

  test('does not promote arbitrary defaults, escaped options, private files or ambiguous star exports', async () => {
    const evidence = await fixture({
      'index.mjs': `export default { name: 'Plugin', install() {} }
        export { Escaped } from './escaped'
        export * from './first'
        export * from './second'`,
      'escaped.js': `export const Escaped = { props: ['unsafe'], render() {} }; mutate(Escaped)`,
      'first.js': `export const Ambiguous = { props: ['first'], render() {} }`,
      'second.js': `export const Ambiguous = createSomething()`,
      'private.vue': `<script>export default { name: 'Private', props: ['hidden'] }</script><template><div /></template>`
    })
    expect((await publicContracts(evidence)).components.size).toBe(0)
  })

  test('keeps dynamic inheritance unknown while preserving effective own literal declarations', async () => {
    const evidence = await fixture({
      'index.mjs': `export { default as Dynamic } from './Dynamic.vue'`,
      'Dynamic.vue': `<script>
        import base from './base'
        export default {
          mixins: [base, unknownMixin],
          props: { ...externalProps, own: { type: String, required: true } },
          methods: { save() { this.$emit('own') } }
        }
        </script><template><slot name="own" /></template>`,
      'base.js': `export default {
        props: { inherited: { type: Number, required: true } },
        model: { prop: 'inherited', event: 'old' },
        methods: { save() { this.$emit('old') } }
      }`
    })
    const component = (await publicContracts(evidence)).components.get('Dynamic')!
    expect([...component.props.entries.keys()]).toEqual(['own'])
    expect([...component.events.entries.keys()]).toEqual(['own'])
    expect(component.vue2Model).toBeNull()
    expect(component.props.acceptance).toBe('unknown')
  })

  test('accepts Vue2 functional templates without borrowing stateful fallthrough and retains real parse errors', async () => {
    const evidence = await fixture({
      'index.mjs': `export { default as Functional } from './Functional.vue'`,
      'Functional.vue': `<template functional><button><slot name="label" /></button></template>`,
      'Malformed.vue': `<template functional><div></template>`
    })
    const result = await publicContracts(evidence)
    const component = result.components.get('Functional')!
    expect(component.slots.entries.has('label')).toBe(true)
    expect(component.fallthrough).toMatchObject({ attributes: 'unknown', listeners: 'unknown' })
    expect(component.fallthrough.attributeTargets ?? []).toEqual([])
    expect(component.vue2Model).toBeNull()
    expect(result.problems.some(problem => problem.path?.endsWith('/Functional.vue'))).toBe(false)
    expect(result.problems.some(problem => problem.path?.endsWith('/Malformed.vue'))).toBe(true)
  })

  test.each([
    `module.exports = { name: 'CommonButton', props: ['label'], render() {} }`,
    `const Button = { name: 'CommonButton', props: ['label'], render() {} }; exports.Button = Button`
  ])('reads explicit static CommonJS component exports: %s', async source => {
    const result = await publicContracts(await fixture({ 'index.mjs': source }))
    expect(result.components.get('CommonButton')?.props.entries.has('label')).toBe(true)
  })

  test.each([
    `const Button = { props: ['unsafe'], render() {} }; exports.Button = Button; mutate(Button)`,
    `const module = {}; module.exports = { props: ['unsafe'], render() {} }`,
    `exports.Button = { props: ['unsafe'], render() {} }; mutate(exports)`
  ])('rejects escaped or shadowed CommonJS exports: %s', async source => {
    expect((await publicContracts(await fixture({ 'index.mjs': source }))).components.size).toBe(0)
  })

  test.each([false, true])('uses only the mapped actual webpack public entry (default-only wrapper: %s)', async defaultOnly => {
    const bootstrap = `(function(modules) {
      function load(id) {
        var current = { exports: {} }
        modules[id].call(current.exports, current, current.exports, load)
        return current.exports
      }
      return load(load.s = 0)
    })([function(module, exports, require) {
exports.default = component
    }])`
    const generated = `module.exports = ${bootstrap}${defaultOnly ? '["default"]' : ''};\n//# sourceMappingURL=index.mjs.map`
    const line = generated.split('\n').findIndex(line => line.startsWith('exports.default'))
    const original = `export { default } from './Public.vue'; export { default as Named } from './Public.vue'`
    const evidence = await fixture({
      'index.mjs': generated,
      'index.mjs.map': JSON.stringify({
        version: 3, file: 'index.mjs', sources: ['webpack:///./src/index.js', 'webpack:///./demo/Private.vue'],
        sourcesContent: [original, '<template><div /></template>'], names: [], mappings: `${';'.repeat(line)}AAAA`
      }),
      'src/index.js': original,
      'src/Public.vue': `<script>export default { name: 'Public', props: ['value'] }</script><template><slot /></template>`,
      'demo/Private.vue': '<template><div /></template>'
    })
    const result = await publicContracts(evidence)
    const component = result.components.get('default')!
    expect(component.props.entries.has('value')).toBe(true)
    expect(component.slots.entries.has('default')).toBe(true)
    expect(result.components.has('Named')).toBe(!defaultOnly)
    expect(result.components.has('Private')).toBe(false)
    expect(component.sources.some(source => source.relativePath === 'index.mjs.map')).toBe(true)
  })

  test('does not use a source map listing as proof without a mapped public export', async () => {
    const evidence = await fixture({
      'index.mjs': `module.exports = dynamicFactory();\n//# sourceMappingURL=index.mjs.map`,
      'index.mjs.map': JSON.stringify({
        version: 3, sources: ['webpack:///./src/Public.vue'], sourcesContent: ['<template><div /></template>'],
        names: [], mappings: 'AAAA'
      }),
      'src/Public.vue': `<script>export default { name: 'Public' }</script><template><div /></template>`
    })
    expect((await publicContracts(evidence)).components.size).toBe(0)
  })

  test('recognizes Vue registration without treating arbitrary registries as safe', async () => {
    const evidence = await fixture({
      'index.mjs': `export { default } from './registered'; export { default as Unsafe } from './unsafe'`,
      'registered.js': `const Registered = { name: 'Registered', props: ['safe'], render() {} }
        export default Registered
        if (typeof window !== 'undefined' && window.Vue) window.Vue.component('registered', Registered)`,
      'unsafe.js': `const Unsafe = { props: ['unsafe'], render() {} }
        export default Unsafe; registry.component('unsafe', Unsafe)`
    })
    const result = await publicContracts(evidence)
    expect(result.components.get('Registered')?.props.entries.has('safe')).toBe(true)
    expect(result.components.has('Unsafe')).toBe(false)
  })

  test('preserves independent complete declarations and rejects private name collisions while adding public aliases', async () => {
    const evidence = await fixture({
      'index.mjs': `export { default as Select } from './Select.vue'`,
      'Select.vue': `<script>export default { name: 'InternalSelect', props: ['value'] }</script><template><div /></template>`,
      'demo/Select.vue': `<script>export default {
        name: 'InternalSelect', props: ['private'], emits: ['private']
      }</script><template><slot name="private" /></template>`
    })
    const declared: ComponentContract = {
      name: 'InternalSelect', aliases: [],
      props: { knowledge: 'known', acceptance: 'closed', entries: new Map([['value', { name: 'value' }]]), issues: [] },
      events: { knowledge: 'known', acceptance: 'closed', entries: new Map(), issues: [] },
      slots: { knowledge: 'known', acceptance: 'closed', entries: new Map(), issues: [] },
      fallthrough: { attributes: 'unknown', listeners: 'unknown' }, sources: []
    }
    const result = await publicContracts(evidence, declared)
    const component = result.components.get('Select')!
    expect(component).toBe(result.components.get('InternalSelect'))
    expect([...component.props.entries.keys()]).toEqual(['value'])
    expect(component.props.knowledge).toBe('known')
    expect(component.props.acceptance).toBe('closed')
    expect(component.events.entries.size).toBe(0)
    expect(component.events.acceptance).toBe('closed')
    expect(component.slots.entries.size).toBe(0)
    expect(component.slots.acceptance).toBe('closed')
  })

  test.each([
    `function register(window) { window.Vue.component('unsafe', Unsafe) }; register(fakeWindow)`,
    `window.Vue.component = foreignRegistry; window.Vue.component('unsafe', Unsafe)`
  ])('does not trust shadowed or replaced Vue registrations: %s', async registration => {
    const evidence = await fixture({
      'index.mjs': `const Unsafe = { props: ['unsafe'], render() {} }; export default Unsafe; ${registration}`
    })
    expect((await publicContracts(evidence)).components.size).toBe(0)
  })

  test('does not collapse different public components merely because their runtime names coincide', async () => {
    const result = await publicContracts(await fixture({
      'index.mjs': `export const First = { name: 'Shared', props: ['first'], render() {} }
        export const Second = { name: 'Shared', props: ['second'], render() {} }`
    }))
    expect([...result.components.get('First')!.props.entries.keys()]).toEqual(['first'])
    expect([...result.components.get('Second')!.props.entries.keys()]).toEqual(['second'])
    expect(result.components.get('First')).not.toBe(result.components.get('Second'))
    expect(result.components.has('Shared')).toBe(false)
    expect(result.components.has('default')).toBe(false)
  })

  test('keeps contradictory public default entry identities ambiguous', async () => {
    const evidence = await fixture({
      'index.mjs': `export default { name: 'First', props: ['first'], render() {} }`,
      'other.mjs': `export default { name: 'Second', props: ['second'], render() {} }`
    })
    evidence.artifacts.runtimeEntries.push({
      path: join(evidence.package.packageRoot!, 'other.mjs'), relativePath: 'other.mjs', source: 'exports', entry: '.'
    })
    expect((await publicContracts(evidence)).components.size).toBe(0)
  })
})

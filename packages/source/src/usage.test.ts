import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { analyzeSourceText, scanVueSourceUsage } from './index.js'

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-source-'))
  await mkdir(join(root, 'src/components'), { recursive: true })
  await mkdir(join(root, 'node_modules/example-ui'), { recursive: true })
  await writeFile(
    join(root, 'src/App.vue'),
    `<script setup lang="ts">
import ExampleCard from 'example-card'
import { ExampleButton as PrimaryButton } from 'example-ui'
import TimePicker from './components/TimePicker.vue'

const componentProps = {
  verticalAlign: {
    type: String as () => 'center' | 'top',
    default: 'center'
  }
}

function handleVisible(visible) {}
const handlePanel = (role: string, visible: boolean) => {}
</script>
<template>
  <section>
    <ExampleCard />
    <PrimaryButton @click="submit" />
    <TimePicker @pick="handleVisible" />
    <ElDatePickerV2
      type="daterange"
      :model-value="range"
      v-model:visible.modifier="visible"
      @visible-change="handleVisible"
      @panel-change="handlePanel"
      @range-visible-change="(role, visible) => handlePanel(role, visible)"
      @single-visible-change="visible => handleVisible(visible)"
    />
    <example-button disabled @click="submit">
      <template #default>Submit</template>
      <template #prefix="{ icon }">{{ icon }}</template>
      <template v-slot:suffix>done</template>
    </example-button>
  </section>
</template>
`,
    'utf8'
  )
  await writeFile(
    join(root, 'src/main.ts'),
    `import { createApp } from 'vue'
import ExampleUi from 'example-ui'
import NotInstalled from 'not-installed'
import App from './App.vue'

createApp(App).use(ExampleUi).mount('#app')
void NotInstalled
`,
    'utf8'
  )
  await writeFile(
    join(root, 'src/components/Wrapper.vue'),
    `<template>
  <Component :is="current" @change="handleChange" />
</template>
`,
    'utf8'
  )
  await writeFile(
    join(root, 'src/components/Options.vue'),
    `<template>
  <ElDatePickerV2 @visible-change="handleVisible" />
</template>
<script>
export default {
  methods: {
    handleVisible(role, visible) {}
  }
}
</script>
`,
    'utf8'
  )
  await writeFile(join(root, 'node_modules/example-ui/Ignored.vue'), '<template><Ignored /></template>\n', 'utf8')
  await writeFile(
    join(root, 'node_modules/example-ui/ignored.ts'),
    "import IgnoredPlugin from 'ignored-plugin'\napp.use(IgnoredPlugin)\n",
    'utf8'
  )
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(
    join(root, 'dist/ignored.ts'),
    "import IgnoredBuildPlugin from 'ignored-build-plugin'\napp.use(IgnoredBuildPlugin)\n",
    'utf8'
  )
  await mkdir(join(root, '.worktrees/feature/src'), { recursive: true })
  await writeFile(
    join(root, '.worktrees/feature/src/IgnoredWorktree.vue'),
    '<template><IgnoredWorktree /></template>\n',
    'utf8'
  )
  return root
}

describe('Vue source usage scanner', () => {
  test('retains event modifiers and proves payload-independent inline and declared handlers', () => {
    const result = analyzeSourceText('/project/App.vue', `<script setup>
function ignore(value) { close() }
function consume(value) { save(value) }
function implicit() { save(arguments[0]) }
</script>
<template>
  <ExampleInput @click.native.stop="close()" @change.once="ignore" />
  <ExampleInput @change="open = false" />
  <ExampleInput @change="() => close()" />
  <ExampleInput @change="consume" />
  <ExampleInput @change="save($event)" />
  <ExampleInput @change="(...args) => save(...args)" />
  <ExampleInput @change="implicit" />
  <ExampleInput @change="handlers[current]" />
  <ExampleInput v-for="ignore in handlers" @change="ignore" />
</template>`)

    expect(result.components[0]?.events).toEqual([
      expect.objectContaining({ name: 'click', modifiers: ['native', 'stop'], handler: expect.objectContaining({ payloadUsage: 'ignored' }) }),
      expect.objectContaining({ name: 'change', modifiers: ['once'], handler: expect.objectContaining({ payloadUsage: 'ignored' }) })
    ])
    expect(result.components.slice(1, 3).map((usage) => usage.events[0]?.handler?.payloadUsage)).toEqual(['ignored', 'ignored'])
    for (const usage of result.components.slice(3)) {
      expect(usage.events[0]?.handler?.payloadUsage).not.toBe('ignored')
    }
  })

  test('does not reuse stale, shadowed, or unexposed handler declarations', () => {
    const setup = analyzeSourceText('/project/App.vue', `<script setup>
function reassigned() { close() }
reassigned = consume
const escaped = () => close()
register(escaped)
const safe = () => close()
function shadowed(value) { const close = value => save(value); close(1) }
function captured(value) { function inner(other = value) { save(other) }; inner() }
function keyed(value) { const { [value]: other } = state; save(other) }
</script>
<template>
  <ExampleInput @change="reassigned" />
  <ExampleInput @change="escaped" />
  <ExampleInput @change="safe" />
  <ExampleInput @change="shadowed" />
  <ExampleInput @change="captured" />
  <ExampleInput @change="keyed" />
  <ExampleInput v-for="safe in handlers" @change="safe" />
  <ExampleInput><template #default="{ safe }"><ExampleInput @change="safe" /></template></ExampleInput>
</template>`)
    const events = setup.components.flatMap((usage) => usage.events)
    expect(events.map((event) => event.handler?.payloadUsage)).toEqual([
      undefined, undefined, 'ignored', 'ignored', 'unknown', 'unknown', undefined, undefined
    ])
    const options = analyzeSourceText('/project/Options.vue', `<script>
function unexposed() { close() }
export default { methods: { safe() { this.close() }, ...runtimeMethods } }
</script><template><ExampleInput @change="unexposed" @close="safe" /></template>`)
    expect(options.components[0]?.events.every((event) => event.handler === undefined)).toBe(true)
  })

  test('resolves listener-valued expressions inside the parser statement wrapper', () => {
    const result = analyzeSourceText('/project/App.vue', `<script setup>
function consume(value) { save(value) }
</script><template>
  <ExampleInput
    @default="(value = readDefault()) => close()"
    @wrapped="((value) => consume(value))"
    @reference="(consume)"
    @dynamic="(handlers[current])"
  />
</template>`)
    const events = result.components[0]?.events ?? []
    expect(events).toHaveLength(4)
    expect(events[0]?.handler).toMatchObject({ minArity: 0, payloadUsage: 'unknown' })
    expect(events[1]?.handler).toMatchObject({ minArity: 1, payloadUsage: 'unknown' })
    expect(events[2]?.handler).toMatchObject({ kind: 'reference', payloadUsage: 'unknown' })
    expect(events[3]?.handler).toBeUndefined()
  })

  test.each([
    'mutate(finish)',
    'const alias = finish; mutate(alias)',
    'const callbacks = { finish }; mutate(callbacks)',
    'const expose = () => finish; mutate(expose)',
    'const expose = () => ({ finish }); mutate(expose)',
    'function expose() { return finish }',
    'function expose() { return { finish } }',
    'function expose() { return consume(finish) }',
    'function expose() { return finish.call(null) }',
    'finish.apply = consume',
    'const alias = finish; alias.apply = consume'
  ])('does not trust escaped setup function objects: %s', (mutation) => {
    const result = analyzeSourceText('/project/App.vue', `<script setup>
function finish() {}
${mutation}
</script><template><ExampleInput @change="finish" /></template>`)
    expect(result.components).toHaveLength(1)
    expect(result.components[0]?.events[0]?.handler).toBeUndefined()
  })

  test('preserves an unescaped function declaration called through its ordinary binding', () => {
    const result = analyzeSourceText('/project/App.vue', `<script setup>
function finish() { close() }
finish()
const invoke = () => finish()
function forwardResult() { return finish() }
</script><template><ExampleInput @change="finish" /></template>`)
    expect(result.components[0]?.events[0]?.handler).toMatchObject({ payloadUsage: 'ignored' })
  })

  test.each([
    'data() { return { done: value => consume(value) } }',
    'setup() { return { done: value => consume(value) } }',
    'data() { return runtimeState }',
    'setup() { return { ...runtimeState } }',
    'data() { if (ready) return { done: consume }; return {} }',
    'created() { mutate(this) }',
    'created() { const vm = this; mutate(vm) }',
    'created() { this.installHandlers() }',
    'mixins: [runtimeMixin]',
    'extends: runtimeBase',
    "props: ['done']",
    "inject: ['done']",
    'computed: { done() { return consume } }'
  ])('keeps Options method identity unresolved with %s', (options) => {
    const result = analyzeSourceText('/project/Options.vue', `<script>
export default { methods: { done() {} }, ${options} }
</script><template><ExampleInput @change="done" /></template>`)
    expect(result.components).toHaveLength(1)
    expect(result.components[0]?.events[0]?.handler).toBeUndefined()
  })

  test('preserves stable Options methods beside unrelated data and setup bindings', () => {
    const result = analyzeSourceText('/project/Options.vue', `<script>
export default {
  props: ['label'],
  inject: { service: 'service' },
  data() { return { opened: true } },
  setup() { const count = ref(0); return { count } },
  created() { this.opened = true },
  methods: {
    done() { this.close() },
    close() { this.opened = false },
    replaced() {},
    replaced: externalHandler
  }
}
</script><template><ExampleInput @change="done" @close="close" @replace="replaced" /></template>`)
    expect(result.components[0]?.events.map((event) => event.handler?.payloadUsage)).toEqual([
      'ignored', 'ignored', undefined
    ])
  })

  test('extracts component tags, props, events, and v-model contracts from SFC templates', async () => {
    const root = await createProject()

    const result = await scanVueSourceUsage({ root })

    const datePicker = result.components.find((component) => component.tag === 'ElDatePickerV2')
    expect(datePicker).toMatchObject({
      file: join(root, 'src/App.vue'),
      tag: 'ElDatePickerV2',
      componentName: 'ElDatePickerV2'
    })
    expect(datePicker?.props).toEqual([
      expect.objectContaining({ name: 'type', kind: 'static', value: 'daterange' }),
      expect.objectContaining({ name: 'model-value', kind: 'dynamic', expression: 'range' })
    ])
    expect(datePicker?.events).toEqual([
      expect.objectContaining({
        name: 'visible-change',
        expression: 'handleVisible',
        handler: expect.objectContaining({ kind: 'reference', minArity: 1, maxArity: 1, parameters: ['visible'] })
      }),
      expect.objectContaining({
        name: 'panel-change',
        expression: 'handlePanel',
        handler: expect.objectContaining({ kind: 'reference', minArity: 2, maxArity: 2, parameters: ['role', 'visible'] })
      }),
      expect.objectContaining({
        name: 'range-visible-change',
        handler: expect.objectContaining({ kind: 'inline', minArity: 2, maxArity: 2, parameters: ['role', 'visible'] })
      }),
      expect.objectContaining({
        name: 'single-visible-change',
        handler: expect.objectContaining({ kind: 'inline', minArity: 1, maxArity: 1, parameters: ['visible'] })
      })
    ])
    expect(datePicker?.models).toEqual([
      expect.objectContaining({
        argument: 'visible',
        expression: 'visible',
        modifiers: ['modifier']
      })
    ])

    const button = result.components.find((component) => component.tag === 'example-button')
    expect(button?.componentName).toBe('ExampleButton')
    expect(button?.props).toEqual([expect.objectContaining({ name: 'disabled', kind: 'boolean' })])
    expect(button?.events).toEqual([expect.objectContaining({ name: 'click', expression: 'submit' })])
    expect(button?.slots).toEqual([
      expect.objectContaining({ name: 'default' }),
      expect.objectContaining({ name: 'prefix', expression: '{ icon }' }),
      expect.objectContaining({ name: 'suffix' })
    ])

    const card = result.components.find((component) => component.tag === 'ExampleCard')
    expect(card?.origin).toEqual({
      kind: 'direct-import',
      importSource: 'example-card',
      package: {
        specifier: 'example-card',
        packageName: 'example-card'
      },
      importedName: 'default'
    })

    const primaryButton = result.components.find((component) => component.tag === 'PrimaryButton')
    expect(primaryButton?.origin).toEqual({
      kind: 'direct-import',
      importSource: 'example-ui',
      package: {
        specifier: 'example-ui',
        packageName: 'example-ui'
      },
      importedName: 'ExampleButton'
    })

    const timePicker = result.components.find((component) => component.tag === 'TimePicker')
    expect(timePicker?.origin).toEqual({ kind: 'local-import', importSource: './components/TimePicker.vue', importedName: 'default' })
  })

  test('records object v-bind spreads separately from named props', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-source-prop-spread-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(
      join(root, 'src/App.vue'),
      `<template>
  <ElOption v-for="item in items" :key="item.value" v-bind="item" label="x" />
  <ElOption :value="1" />
</template>
`,
      'utf8'
    )

    const result = await scanVueSourceUsage({ root })
    const withSpread = result.components.find((component) => component.propSpreads.length > 0)
    const namedOnly = result.components.find((component) => component.propSpreads.length === 0)

    expect(withSpread?.props).toEqual([
      expect.objectContaining({ name: 'key', kind: 'dynamic', expression: 'item.value' }),
      expect.objectContaining({ name: 'label', kind: 'static', value: 'x' })
    ])
    expect(withSpread?.propSpreads).toEqual([
      expect.objectContaining({ expression: 'item' })
    ])
    expect(namedOnly?.props).toEqual([
      expect.objectContaining({ name: 'value', kind: 'dynamic', expression: '1' })
    ])
    expect(namedOnly?.propSpreads).toEqual([])
  })

  test('extracts neutral directive facts from component nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-source-directive-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(
      join(root, 'src/App.vue'),
      '<template>\n  <LoadingPanel v-loading.fullscreen="busy" element-loading-text="Wait" />\n</template>\n',
      'utf8'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.components[0]?.directives).toEqual([
      expect.objectContaining({ name: 'loading', modifiers: ['fullscreen'], expression: 'busy' })
    ])
  })

  test('parses TypeScript assertions and typed callbacks in template expressions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-source-template-ts-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(
      join(root, 'src/App.vue'),
      `<script setup lang="ts">
import ExamplePanel from 'example-ui'
const items: string[] = []
function handleChange(value: string) { void value }
</script>
<template>
  <ExamplePanel
    :items="items as string[]"
    @change="(value: string) => handleChange(value)"
  />
</template>
`,
      'utf8'
    )

    const result = await scanVueSourceUsage({ root })
    const panel = result.components.find((component) => component.tag === 'ExamplePanel')

    expect(result.fileResults[0]?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'template', status: 'available' })
    ]))
    expect(panel?.props).toEqual([
      expect.objectContaining({ name: 'items', expression: 'items as string[]' })
    ])
    expect(panel?.events).toEqual([
      expect.objectContaining({
        name: 'change',
        handler: expect.objectContaining({
          kind: 'inline',
          minArity: 1,
          maxArity: 1,
          parameters: ['value']
        })
      })
    ])
  })

  test('records only imported identifiers passed to plugin use calls', async () => {
    const root = await createProject()

    const result = await scanVueSourceUsage({ root })

    expect(result.globalPlugins).toEqual([{
      file: join(root, 'src/main.ts'),
      package: {
        specifier: 'example-ui',
        packageName: 'example-ui'
      },
      localName: 'ExampleUi'
    }])
  })

  test('skips dependency and build output directories', async () => {
    const root = await createProject()

    const result = await scanVueSourceUsage({ root })

    expect(result.files).toEqual([
      join(root, 'src/App.vue'),
      join(root, 'src/main.ts'),
      join(root, 'src/components/Options.vue'),
      join(root, 'src/components/Wrapper.vue')
    ].sort())
    expect(result.components.map((component) => component.tag)).not.toContain('Ignored')
    expect(result.globalPlugins.map((plugin) => plugin.package.packageName)).not.toContain('ignored-plugin')
    expect(result.globalPlugins.map((plugin) => plugin.package.packageName)).not.toContain('ignored-build-plugin')
  })

  test('limits source usage extraction to a project subpath', async () => {
    const root = await createProject()

    const result = await scanVueSourceUsage({ root, scope: 'src/components' })

    expect(result.files).toEqual([
      join(root, 'src/components/Options.vue'),
      join(root, 'src/components/Wrapper.vue')
    ])
    expect(result.components.map((component) => component.tag)).toEqual([
      'ElDatePickerV2',
      'Component'
    ])
  })

  test('extracts event handler signatures from Vue Options API methods', async () => {
    const root = await createProject()

    const result = await scanVueSourceUsage({ root })

    const optionsUsage = result.components.find((component) => component.file.endsWith('Options.vue'))
    expect(optionsUsage?.events).toEqual([
      expect.objectContaining({
        name: 'visible-change',
        expression: 'handleVisible',
        handler: expect.objectContaining({ kind: 'reference', minArity: 2, maxArity: 2, parameters: ['role', 'visible'] })
      })
    ])
  })

  test('parses script setup tsx blocks without dropping template usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-source-tsx-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(
      join(root, 'src/TsxForm.vue'),
      `<script lang="tsx" setup>
import type { DefineComponent } from 'vue'

const renderCell = (component: DefineComponent) => <component />
</script>
<template>
  <ExampleInput @change="handleChange" />
</template>
`,
      'utf8'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.components).toEqual([
      expect.objectContaining({
        tag: 'ExampleInput',
        events: [expect.objectContaining({ name: 'change', expression: 'handleChange' })]
      })
    ])
  })

  test('records malformed files and continues scanning valid files', async () => {
    const root = await createProject()
    await writeFile(
      join(root, 'src/Broken.vue'),
      '<script setup lang="ts">const =</script>\n<template><BrokenComponent /></template>\n',
      'utf8'
    )
    await writeFile(
      join(root, 'src/broken.ts'),
      'const = missingName\n',
      'utf8'
    )

    const result = await scanVueSourceUsage({ root })

    expect(result.fileResults.find((entry) => entry.file === join(root, 'src/Broken.vue'))?.blocks)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'script-setup', status: 'failed' })]))
    expect(result.fileResults.find((entry) => entry.file === join(root, 'src/broken.ts'))?.blocks)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'script', status: 'failed' })]))
    expect(result.components.some((component) => component.tag === 'ElDatePickerV2')).toBe(true)
    expect(result.components.some((component) => component.file === join(root, 'src/Broken.vue'))).toBe(true)
    expect(result.globalPlugins).toEqual([
      expect.objectContaining({ package: expect.objectContaining({ packageName: 'example-ui' }), localName: 'ExampleUi' })
    ])
  })

  test('models required, optional, default, rest, and unresolved handler arity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-source-arity-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(
      join(root, 'src/App.vue'),
      `<script setup lang="ts">
function fixed(value: string, index?: number) {}
const defaults = (value: string, index = 0) => {}
const rest = (value: string, ...remaining: unknown[]) => {}
</script>
<template>
  <FixtureInput @fixed="fixed" @defaults="defaults" @rest="rest" @unknown="externalHandler" />
</template>
`,
      'utf8'
    )

    const result = await scanVueSourceUsage({ root })
    const events = result.components[0]?.events ?? []

    expect(events.find((event) => event.name === 'fixed')?.handler).toMatchObject({
      kind: 'reference', parameters: ['value', 'index'], minArity: 1, maxArity: 2
    })
    expect(events.find((event) => event.name === 'defaults')?.handler).toMatchObject({
      kind: 'reference', parameters: ['value', 'index'], minArity: 1, maxArity: 2
    })
    expect(events.find((event) => event.name === 'rest')?.handler).toMatchObject({
      kind: 'reference', parameters: ['value', 'remaining'], minArity: 1, maxArity: null
    })
    expect(events.find((event) => event.name === 'unknown')?.handler).toBeUndefined()
  })
})

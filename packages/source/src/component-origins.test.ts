import { describe, expect, test } from 'vitest'
import { analyzeSourceText } from './index.js'

function components(source: string) {
  const analyzed = analyzeSourceText('/project/Example.vue', source)
  expect(analyzed.fileResult.blocks.filter((block) => block.status === 'failed')).toEqual([])
  return analyzed.components
}

describe('template import exposure', () => {
  test.each(['Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense'])(
    'proves a script-setup named alias of %s', (importedName) => {
      const usages = components(`<script setup>
import { ${importedName} as FrameworkComponent } from 'vue'
</script><template><FrameworkComponent /></template>`)
      expect(usages[0]?.origin).toEqual({
        kind: 'direct-import', importSource: 'vue', importedName,
        package: { packageName: 'vue', specifier: 'vue' }, templateBinding: 'script-setup'
      })
    }
  )

  test('resolves kebab aliases and both upper- and lower-case namespace imports', () => {
    const usages = components(`<script setup>
import { TransitionGroup as motionGroup } from 'vue'
import * as Runtime from 'vue'
import * as vue from 'vue-alias'
</script><template><motion-group /><Runtime.TransitionGroup /><vue.KeepAlive /></template>`)
    expect(usages.map((usage) => [usage.tag, usage.origin?.importedName, usage.origin?.templateBinding])).toEqual([
      ['motion-group', 'TransitionGroup', 'script-setup'],
      ['Runtime.TransitionGroup', 'TransitionGroup', 'script-setup'],
      ['vue.KeepAlive', 'KeepAlive', 'script-setup']
    ])
    expect(usages[2]?.origin?.package?.packageName).toBe('vue-alias')
  })

  test('does not turn an Options namespace registration into setup member exposure', () => {
    const usages = components(`<script>
import * as Runtime from 'vue'
export default { components: { Runtime, Group: Runtime.TransitionGroup } }
</script><template><Runtime.TransitionGroup /><Group /></template>`)
    expect(usages[0]?.origin).toBeUndefined()
    expect(usages[1]?.origin).toMatchObject({
      kind: 'direct-import', importedName: 'TransitionGroup',
      importSource: 'vue', templateBinding: 'components-option'
    })
  })

  test('distinguishes an ordinary import from the same import exposed by script setup', () => {
    const script = `<script>import { TransitionGroup as Group } from 'vue'; export default {}</script>`
    const template = '<template><Group /></template>'
    expect(components(script + template)[0]?.origin?.templateBinding).toBeUndefined()
    expect(components(`${script}<script setup>const value = 1</script>${template}`)[0]?.origin?.templateBinding)
      .toBe('script-setup')
  })

  test.each([
    `import { TransitionGroup as Motion } from 'vue'; export default { components: { Group: Motion } }`,
    `import { defineComponent as define, TransitionGroup as Motion } from 'vue'; export default define({ components: { Group: Motion } })`,
    `import * as Vue from 'vue'; export default Vue.defineComponent({ components: { Group: Vue.TransitionGroup } })`
  ])('proves the actual default-export components option: %s', (script) => {
    const origin = components(`<script>${script}</script><template><Group /></template>`)[0]?.origin
    expect(origin).toMatchObject({
      kind: 'direct-import', importedName: 'TransitionGroup', importSource: 'vue', templateBinding: 'components-option'
    })
  })

  test.each([
    `const unrelated = { components: { Group: Motion } }; export default {}`,
    `function unrelated(Motion) { return { components: { Group: Motion } } }; export default {}`,
    `function defineComponent(value) { return value }; export default defineComponent({ components: { Group: Motion } })`,
    `export default { components: { Group: Motion, ...unknown } }`,
    `export default { components: { Group: Motion, [unknown]: Other } }`,
    `export default { components: { Group: Motion, Group: Other } }`,
    `export default { components: { Group: Motion }, ...unknown }`,
    `export default { components: { Group: Motion }, components: unknown }`,
    `export default { components: { Group: Motion }, ['components']: unknown }`,
    `const options = { components: { Group: Motion } }; options.components = unknown; export default options`
  ])('does not manufacture exposure from an unproven registration: %s', (script) => {
    const origin = components(`<script>
import { TransitionGroup as Motion } from 'vue'
${script}
</script><template><Group /></template>`)[0]?.origin
    expect(origin?.templateBinding).toBeUndefined()
  })

  test('does not trust a foreign defineComponent wrapper', () => {
    const origin = components(`<script>
import { TransitionGroup } from 'vue'
import { defineComponent } from 'other-framework'
export default defineComponent({ components: { Group: TransitionGroup } })
</script><template><Group /></template>`)[0]?.origin
    expect(origin?.templateBinding).toBeUndefined()
  })

  test.each([
    `import * as Runtime from 'vue'; const TransitionGroup = 'other'; export default { components: { Group: Runtime[TransitionGroup] } }`,
    `import { Widgets } from 'vue'; export default { components: { Group: Widgets.TransitionGroup } }`
  ])('keeps potential member origins without treating them as proven exports: %s', (script) => {
    const origin = components(`<script>${script}</script><template><Group /></template>`)[0]?.origin
    expect(origin).toMatchObject({ kind: 'direct-import', importedName: 'TransitionGroup' })
    expect(origin?.templateBinding).toBeUndefined()
  })

  test('retains the lexical import when an unrelated components object reuses its name', () => {
    const origin = components(`<script setup>
import { TransitionGroup as Group } from 'vue'
import { Other } from 'foreign-ui'
const unrelated = { components: { Group: Other } }
</script><template><Group /></template>`)[0]?.origin
    expect(origin).toMatchObject({ importedName: 'TransitionGroup', importSource: 'vue', templateBinding: 'script-setup' })
  })

  test('does not turn a type-only import into runtime exposure', () => {
    const usages = components(`<script setup lang="ts">
import type { TransitionGroup as Group } from 'vue'
import { type KeepAlive as Alive } from 'vue'
</script><template><Group /><Alive /></template>`)
    expect(usages.map((usage) => usage.origin)).toEqual([undefined, undefined])
  })

  test('does not attach imported origins to template-scope shadows', () => {
    const usages = components(`<script setup>
import { TransitionGroup as Group } from 'vue'
import * as Vue from 'vue'
</script><template>
  <Group />
  <template v-for="Group in groups"><Group /></template>
  <List v-slot="{ Group, Vue }"><Group /><Vue.TransitionGroup /></List>
  <Vue.TransitionGroup />
</template>`)
    expect(usages.filter((usage) => usage.tag === 'Group' || usage.tag === 'Vue.TransitionGroup')
      .map((usage) => usage.origin?.templateBinding)).toEqual(['script-setup', undefined, undefined, undefined, 'script-setup'])
  })

  test('does not reuse normal-script import proof for a setup-local override', () => {
    const usage = components(`<script>
import { TransitionGroup as Group } from 'vue'
export default { components: { Group } }
</script><script setup>const Group = unknown</script><template><Group /></template>`)[0]
    expect(usage?.origin).toBeUndefined()
  })

  test('preserves foreign and missing-export provenance rather than relabeling them Vue-owned', () => {
    const usages = components(`<script setup>
import { TransitionGroup as ForeignGroup } from 'foreign-ui'
import { Missing as MissingGroup } from 'vue'
</script><template><ForeignGroup /><MissingGroup /></template>`)
    expect(usages.map((usage) => [usage.origin?.package?.packageName, usage.origin?.importedName])).toEqual([
      ['foreign-ui', 'TransitionGroup'], ['vue', 'Missing']
    ])
  })

  test('retains local lazy component origins', () => {
    const usage = components(`<script setup>
const LocalGroup = () => import('./Group.vue')
</script><template><LocalGroup /></template>`)[0]
    expect(usage?.origin).toEqual({ kind: 'local-import' })
  })
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { shouldFailDoctorRun, type DoctorConfig, type DoctorRulePack, type DoctorRulePackContext } from '@daguanren21/vue-doctor-core'
import { runDoctor } from './index.js'

const roots: string[] = []
const gateConfig: DoctorConfig = { failOn: 'never', failOnIncompleteCoverage: true, gitAttribution: false, eslint: { mode: 'off' } }

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type FixturePackage = { version: string; canonicalName?: string; components?: string[] }

async function createProject(
  source: string,
  options: { vueVersion?: string | null; packages?: Record<string, FixturePackage> } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-framework-coverage-'))
  roots.push(root)
  const vueVersion = options.vueVersion === undefined ? '3.5.44' : options.vueVersion
  const packages: Record<string, FixturePackage> = {
    ...(vueVersion ? { vue: { version: vueVersion } } : {}),
    ...options.packages
  }
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    dependencies: Object.fromEntries(Object.entries(packages).map(([name, pkg]) => [
      name, pkg.canonicalName ? `npm:${pkg.canonicalName}@${pkg.version}` : pkg.version
    ]))
  }))
  for (const [name, pkg] of Object.entries(packages)) {
    const packageRoot = join(root, 'node_modules', name)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: pkg.canonicalName ?? name,
      version: pkg.version,
      ...(pkg.components ? { 'web-types': './web-types.json' } : {})
    }))
    if (pkg.components) {
      await writeFile(join(packageRoot, 'web-types.json'), JSON.stringify({
        contributions: { html: { elements: pkg.components.map((component) => ({
          name: component, attributes: [], events: [], slots: []
        })) } }
      }))
    }
  }
  await writeFile(join(root, 'src/Example.vue'), source)
  return root
}

async function runProject(root: string, config: DoctorConfig = {}) {
  let observed: DoctorRulePackContext['components'] = []
  const observer: DoctorRulePack = {
    name: 'capture',
    rules: [{ code: 'capture/components', title: 'Capture components', description: 'Observe the real runner component/ownership pairs.' }],
    run(context) {
      observed = context.components
      expect(context.components.map((component) => component.usage)).toEqual(context.source.components)
      return { diagnostics: [], skippedChecks: [], checks: [{ ruleCode: 'capture/components', status: 'checked' }] }
    }
  }
  const report = await runDoctor({ root, config: { ...gateConfig, ...config, rulePacks: [observer] } })
  const gateFails = shouldFailDoctorRun({ diagnostics: report.diagnostics, coverageStatus: report.coverage.status, config: gateConfig })
  return { report, observed, gateFails }
}

describe('Vue framework component coverage', () => {
  test.each([
    'Transition', 'transition', 'TransitionGroup', 'transition-group', 'KeepAlive', 'keep-alive',
    'Teleport', 'teleport', 'Suspense', 'suspense'
  ])('does not require an application entry for the reserved tag %s', async (tag) => {
    const root = await createProject(`<template><${tag} to="body"><div key="one" /></${tag}></template>`)
    const { report, gateFails } = await runProject(root)
    expect(report.coverage.status).toBe('complete')
    expect(report.coverage.source.failedFiles).toEqual([])
    expect(report.coverage.source.contextIssues ?? []).toEqual([])
    expect(report.coverage.componentLibraries).toEqual([])
    expect(gateFails).toBe(false)
  })

  test.each(['Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense'])(
    'does not discover Vue as a library for the exposed import %s', async (name) => {
      const root = await createProject(`<script setup>import { ${name} as FrameworkComponent } from 'vue'</script>
<template><FrameworkComponent><div key="one" /></FrameworkComponent></template>`)
      const { report, observed, gateFails } = await runProject(root)
      expect(report.coverage.status).toBe('complete')
      expect(report.coverage.componentLibraries).toEqual([])
      expect(observed.map((component) => component.usage.tag)).toEqual(['FrameworkComponent'])
      expect(observed[0]?.usage.origin).toMatchObject({ importedName: name, templateBinding: 'script-setup' })
      expect(observed[0]?.ownership).toEqual({ status: 'unmatched', candidates: [] })
      expect(gateFails).toBe(false)
    }
  )

  test.each([
    `<script setup>import { TransitionGroup } from 'vue'</script><template><TransitionGroup><div key="one" /></TransitionGroup></template>`,
    `<script setup>import { TransitionGroup as motionGroup } from 'vue'</script><template><motion-group /></template>`,
    `<script setup>import * as Runtime from 'vue'</script><template><Runtime.TransitionGroup /></template>`,
    `<script setup>import * as runtime from 'vue'</script><template><runtime.TransitionGroup /></template>`,
    `<script>import { TransitionGroup as Motion } from 'vue'; export default { components: { Group: Motion } }</script><template><Group /></template>`,
    `<script>import { defineComponent as define, TransitionGroup as Motion } from 'vue'; export default define({ components: { Group: Motion } })</script><template><Group /></template>`,
    `<script>import * as Runtime from 'vue'; export default Runtime.defineComponent({ components: { Group: Runtime.TransitionGroup } })</script><template><Group /></template>`,
    `<script>import * as Runtime from 'vue'; export default { components: { Group: Runtime.TransitionGroup } }</script><template><Group /></template>`,
    `<script>import { TransitionGroup as Group } from 'vue'; export default {}</script><script setup>const value = 1</script><template><Group /></template>`
  ])('keeps a proven exposed builtin complete: %s', async (source) => {
    const { report, observed, gateFails } = await runProject(await createProject(source))
    expect(report.coverage.status).toBe('complete')
    expect(report.coverage.componentLibraries).toEqual([])
    expect(observed).toHaveLength(1)
    expect(gateFails).toBe(false)
  })

  test.each(['Teleport', 'teleport', 'Transition', 'TransitionGroup'])('classifies a static vue: redirect to the builtin %s', async target => {
    const { report, gateFails } = await runProject(await createProject(
      `<template><TransitionGroup is="vue:${target}" to="body"><div key="one" /></TransitionGroup></template>`
    ))
    expect(report.coverage.status).toBe('complete')
    expect(report.coverage.componentLibraries).toEqual([])
    expect(report.coverage.source.contextIssues ?? []).toEqual([])
    expect(gateFails).toBe(false)
  })

  test('verifies an installed npm alias against its canonical Vue identity', async () => {
    const root = await createProject(`<script setup>
import { TransitionGroup as Group } from 'vue-runtime'
</script><template><Group /></template>`, {
      packages: { 'vue-runtime': { version: '3.5.44', canonicalName: 'vue' } }
    })
    const { report, observed, gateFails } = await runProject(root)
    expect(report.inventory.packages['vue-runtime']?.importRoots).toEqual(['vue-runtime', 'vue'])
    expect(observed[0]?.usage.origin?.package?.packageName).toBe('vue-runtime')
    expect(report.coverage.componentLibraries).toEqual([])
    expect(report.coverage.status).toBe('complete')
    expect(gateFails).toBe(false)
  })

  test('keeps an alias-only inventory unknown rather than choosing a primary Vue runtime', async () => {
    const root = await createProject(`<script setup>
import { TransitionGroup as Group } from 'vue-runtime'
</script><template><Group /></template>`, {
      vueVersion: null,
      packages: { 'vue-runtime': { version: '3.5.44', canonicalName: 'vue' } }
    })
    const { report, gateFails } = await runProject(root)
    expect(report.project.vueFramework).toBe('unknown')
    expect(report.coverage.status).toBe('blocked')
    expect(report.coverage.componentLibraries).toContainEqual(expect.objectContaining({
      package: expect.objectContaining({ dependencyName: 'vue-runtime' }), detectedUsageCount: 1
    }))
    expect(gateFails).toBe(true)
  })

  test('uses compiler-reserved precedence even when a same-spelling foreign import exists', async () => {
    const root = await createProject(`<script setup>
import { TransitionGroup } from 'foreign-ui'
</script><template><TransitionGroup><div key="one" /></TransitionGroup></template>`, {
      packages: { 'foreign-ui': { version: '1.0.0', components: ['TransitionGroup'] } }
    })
    const { report, observed, gateFails } = await runProject(root, { ui: { libraries: ['foreign-ui'] } })
    expect(observed[0]?.usage.origin?.package?.packageName).toBe('foreign-ui')
    expect(observed[0]?.ownership).toEqual({ status: 'unmatched', candidates: [] })
    expect(report.coverage.componentLibraries).toEqual([])
    expect(report.coverage.status).toBe('complete')
    expect(gateFails).toBe(false)
  })

  test.each([
    '<template><UnknownGlobal /></template>',
    '<template><Transition-group /></template>',
    '<template><Transitiongroup /></template>',
    `<script setup>import { TransitionGroup as Group } from 'vue'</script><template><template v-for="Group in groups"><Group /></template></template>`,
    `<script setup>import * as Runtime from 'vue'</script><template><List v-slot="{ Runtime }"><Runtime.TransitionGroup /></List></template>`,
    `<script setup lang="ts">import type { TransitionGroup as Group } from 'vue'</script><template><Group /></template>`,
    `<script>import { TransitionGroup as Group } from 'vue'; export default { components: { Group } }</script><script setup>const Group = unknown</script><template><Group /></template>`,
    `<script>import * as Runtime from 'vue'; export default { components: { Runtime } }</script><template><Runtime.TransitionGroup /></template>`,
    '<template><TransitionGroup is="vue:UnknownGlobal" /></template>',
    '<template><TransitionGroup is="vue:transitiongroup" /></template>',
    '<template><TransitionGroup is="vue:" /></template>'
  ])('keeps unresolved template ownership partial: %s', async (source) => {
    const { report, gateFails } = await runProject(await createProject(source))
    expect(report.coverage.status).toBe('partial')
    expect(report.coverage.source.contextIssues).toContainEqual(expect.objectContaining({ code: 'application-ownership-unavailable' }))
    expect(gateFails).toBe(true)
  })

  test.each([
    `import { TransitionGroup as Group } from 'vue'; export default {}`,
    `import { TransitionGroup as Motion } from 'vue'; const unrelated = { components: { Group: Motion } }; export default {}`,
    `import { TransitionGroup as Motion } from 'vue'; function nested(Motion) { return { components: { Group: Motion } } }; export default {}`,
    `import { TransitionGroup as Motion } from 'vue'; export default { components: { Group: Motion, ...unknown } }`,
    `import { TransitionGroup as Motion } from 'vue'; export default { components: { Group: Motion }, ...unknown }`,
    `import { TransitionGroup as Motion } from 'vue'; export default { components: { Group: Motion, Group: Other } }`,
    `import { TransitionGroup as Motion } from 'vue'; export default { components: { Group: Motion }, components: unknown }`,
    `import * as Runtime from 'vue'; const TransitionGroup = 'other'; export default { components: { Group: Runtime[TransitionGroup] } }`,
    `import { Widgets } from 'vue'; export default { components: { Group: Widgets.TransitionGroup } }`
  ])('does not promote an unexposed or overridden import: %s', async (script) => {
    const { report, observed, gateFails } = await runProject(await createProject(`<script>${script}</script><template><Group /></template>`))
    expect(observed[0]?.usage.origin?.templateBinding).toBeUndefined()
    expect(report.coverage.status).not.toBe('complete')
    expect(gateFails).toBe(true)
  })

  const invalidImports: Array<{ importSource: string; name: string; packages: Record<string, FixturePackage> }> = [
    { importSource: 'foreign-ui', name: 'TransitionGroup', packages: { 'foreign-ui': { version: '1.0.0' } } },
    { importSource: 'vue', name: 'MissingExport', packages: {} },
    { importSource: 'vue/not-a-public-entry', name: 'TransitionGroup', packages: {} },
    { importSource: 'vue-runtime', name: 'TransitionGroup', packages: { 'vue-runtime': { canonicalName: 'foreign-framework', version: '3.5.44' } } },
    { importSource: 'vue-runtime', name: 'TransitionGroup', packages: { 'vue-runtime': { canonicalName: 'vue', version: '2.7.16' } } },
    { importSource: 'vue-runtime', name: 'TransitionGroup', packages: { 'vue-runtime': { canonicalName: 'vue', version: 'unknown' } } }
  ]
  test.each(invalidImports)('retains real library or invalid-export boundaries for $importSource/$name', async ({ importSource, name, packages }) => {
    const root = await createProject(`<script setup>import { ${name} as Group } from '${importSource}'</script><template><Group /></template>`, { packages })
    const { report, gateFails } = await runProject(root)
    expect(report.coverage.status).toBe('blocked')
    expect(report.coverage.componentLibraries).toContainEqual(expect.objectContaining({
      problems: expect.arrayContaining([expect.objectContaining({ code: 'component-library-contracts-unavailable' })])
    }))
    expect(gateFails).toBe(true)
  })

  test.each([null, 'unknown', '2.7.16', '4.0.0'])('keeps bare builtins conservative for Vue %s', async (vueVersion) => {
    const { report, gateFails } = await runProject(await createProject('<template><TransitionGroup /></template>', { vueVersion }))
    expect(report.coverage.status).toBe('partial')
    expect(report.coverage.source.contextIssues).toContainEqual(expect.objectContaining({ code: 'application-ownership-unavailable' }))
    expect(gateFails).toBe(true)
  })

  test.each(['unknown', '2.7.16', '4.0.0'])('does not exempt imported aliases for Vue %s', async (vueVersion) => {
    const root = await createProject(`<script setup>
import { TransitionGroup as Group } from 'vue'
</script><template><Group /></template>`, { vueVersion })
    const { report, gateFails } = await runProject(root)
    expect(report.coverage.status).toBe('blocked')
    expect(report.coverage.componentLibraries).toContainEqual(expect.objectContaining({
      package: expect.objectContaining({ canonicalName: 'vue' }),
      detectedUsageCount: 1
    }))
    expect(gateFails).toBe(true)
  })

  test('does not trust the dependency spelling vue when its installed canonical identity is foreign', async () => {
    const root = await createProject('<template><TransitionGroup /></template>', {
      packages: { vue: { canonicalName: 'foreign-framework', version: '3.5.44' } }
    })
    const { report, gateFails } = await runProject(root)
    expect(report.coverage.status).toBe('partial')
    expect(gateFails).toBe(true)
  })

  test('preserves component facts, ownership order, and ordinary library matching in mixed templates', async () => {
    const root = await createProject(`<script setup>
import { TransitionGroup as Motion } from 'vue'
import { Widget } from 'fixture-ui'
</script><template><TransitionGroup><Widget @missing="handle" /></TransitionGroup><UnknownGlobal /><Motion /></template>`, {
      packages: { 'fixture-ui': { version: '1.0.0', components: ['Widget', 'TransitionGroup'] } }
    })
    await writeFile(join(root, 'node_modules/fixture-ui/web-types.json'), JSON.stringify({
      contributions: { html: { elements: [
        { name: 'Widget', attributes: [{ name: 'label', type: 'string', required: true }], events: [], slots: [] },
        { name: 'TransitionGroup', attributes: [], events: [], slots: [] }
      ] } }
    }))
    const { report, observed, gateFails } = await runProject(root, { ui: { libraries: ['fixture-ui'] } })
    expect(observed.map(({ usage, ownership }) => [usage.tag, ownership.status, ownership.package?.canonicalName])).toEqual([
      ['TransitionGroup', 'unmatched', undefined], ['Widget', 'matched', 'fixture-ui'],
      ['UnknownGlobal', 'unmatched', undefined], ['Motion', 'unmatched', undefined]
    ])
    expect(report.coverage.componentLibraries).toHaveLength(1)
    expect(report.coverage.componentLibraries[0]).toMatchObject({ detectedUsageCount: 1, matchedUsageCount: 1 })
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'component-prop-required-missing' }))
    expect(report.skippedChecks).toContainEqual(expect.objectContaining({
      ruleCode: 'component-event-unsupported', required: true, reason: 'missing-capability'
    }))
    expect(report.coverage.source.contextIssues).toContainEqual(expect.objectContaining({
      code: 'application-ownership-unavailable', file: join(root, 'src/Example.vue')
    }))
    expect(report.coverage.status).toBe('partial')
    expect(gateFails).toBe(true)
  })

  test('never uses the root Vue version to exempt a nested Vue 2 package', async () => {
    const root = await createProject('<template><TransitionGroup /></template>')
    const legacy = join(root, 'legacy')
    await mkdir(join(legacy, 'node_modules/vue'), { recursive: true })
    await writeFile(join(legacy, 'package.json'), JSON.stringify({ dependencies: { vue: '2.7.16' } }))
    await writeFile(join(legacy, 'node_modules/vue/package.json'), JSON.stringify({ name: 'vue', version: '2.7.16' }))
    const legacyFile = join(legacy, 'Legacy.vue')
    await writeFile(legacyFile, '<template><TransitionGroup /></template>')
    const { report, gateFails } = await runProject(root)
    expect(report.coverage.source.contextIssues).toEqual([
      expect.objectContaining({ code: 'application-ownership-unavailable', file: legacyFile })
    ])
    expect(report.coverage.status).toBe('partial')
    expect(gateFails).toBe(true)
  })

  test('does not hide a failed script block behind an otherwise reserved builtin', async () => {
    const root = await createProject('<script setup>const = broken</script><template><TransitionGroup /></template>')
    const { report, gateFails } = await runProject(root)
    expect(report.coverage.status).toBe('partial')
    expect(report.coverage.source.failedFiles).toContainEqual(expect.objectContaining({ block: 'script-setup' }))
    expect(gateFails).toBe(true)
  })
})

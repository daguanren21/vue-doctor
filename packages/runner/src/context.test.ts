import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { discoverTargetFiles } from '@vue-doctor/source'
import { buildProjectContext, contextualizeSourceUsage } from './context.js'

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function installPackage(root: string, name: string, version: string) {
  const packageRoot = join(root, 'node_modules', ...name.split('/'))
  await mkdir(packageRoot, { recursive: true })
  await writeJson(join(packageRoot, 'package.json'), { name, version })
}

describe('project context', () => {
  test('keeps App-only and full scans on the same verified application registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-app-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), {
      dependencies: { vue: '^3.5.0', 'fixture-ui': '^1.0.0' }
    })
    await installPackage(root, 'vue', '3.5.4')
    await installPackage(root, 'fixture-ui', '1.2.0')
    await writeFile(join(root, 'src/main.ts'), `
import { createApp } from 'vue'
import App from './App.vue'
import FixtureUi from 'fixture-ui'
createApp(App).use(FixtureUi).mount('#app')
`)
    const appFile = join(root, 'src/App.vue')
    await writeFile(appFile, '<template><FixtureButton /></template>')

    const partialTargets = await discoverTargetFiles({ root, files: [appFile] })
    const fullTargets = await discoverTargetFiles({ root })
    const partial = await buildProjectContext({ root, targetFiles: partialTargets })
    const full = await buildProjectContext({ root, targetFiles: fullTargets })

    expect(partial.applicationIds[appFile]).toBe(full.applicationIds[appFile])
    expect(partial.projectContext.applications).toEqual([
      expect.objectContaining({
        rootComponentFiles: [appFile],
        plugins: [expect.objectContaining({ localName: 'FixtureUi' })]
      })
    ])
    expect(partial.globalPlugins).toEqual([
      expect.objectContaining({ applicationId: partial.applicationIds[appFile] })
    ])
    expect(partial.projectContext.issues).toEqual([])
  })

  test('associates two applications with their own components and plugins without crossing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-multi-'))
    await writeJson(join(root, 'package.json'), {
      dependencies: { vue: '^3.5.0', 'first-ui': '1.0.0', 'second-ui': '2.0.0' }
    })
    await installPackage(root, 'vue', '3.5.4')
    await installPackage(root, 'first-ui', '1.0.0')
    await installPackage(root, 'second-ui', '2.0.0')
    const firstApp = join(root, 'apps/first/App.vue')
    const secondApp = join(root, 'apps/second/App.vue')
    await mkdir(join(root, 'apps/first'), { recursive: true })
    await mkdir(join(root, 'apps/second'), { recursive: true })
    await writeFile(firstApp, '<template><FirstButton /></template>')
    await writeFile(secondApp, '<template><SecondButton /></template>')
    await writeFile(join(root, 'apps/first/main.ts'), `
import { createApp } from 'vue'
import App from './App.vue'
import FirstUi from 'first-ui'
createApp(App).use(FirstUi).mount('#first')
`)
    await writeFile(join(root, 'apps/second/main.ts'), `
import { createApp } from 'vue'
import App from './App.vue'
import SecondUi from 'second-ui'
createApp(App).use(SecondUi).mount('#second')
`)

    const targetFiles = await discoverTargetFiles({ root, files: [firstApp, secondApp] })
    const result = await buildProjectContext({ root, targetFiles })

    expect(result.applicationIds[firstApp]).not.toBe(result.applicationIds[secondApp])
    expect(result.projectContext.applications.map((application) => ({
      root: application.rootComponentFiles[0],
      plugins: application.plugins.map((plugin) => plugin.package.packageName)
    }))).toEqual([
      { root: firstApp, plugins: ['first-ui'] },
      { root: secondApp, plugins: ['second-ui'] }
    ])
    expect(result.projectContext.issues).toEqual([])
  })

  test('uses each target package nearest manifest and preserves distinct Vue versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-workspace-'))
    await writeJson(join(root, 'package.json'), { private: true, workspaces: ['packages/*'], dependencies: { vue: '3.4.0' } })
    await installPackage(root, 'vue', '3.4.0')
    const rootApp = join(root, 'src/App.vue')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(rootApp, '<template><main /></template>')
    await writeFile(join(root, 'src/main.ts'), `import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#root')\n`)
    const legacyRoot = join(root, 'packages/legacy')
    const modernRoot = join(root, 'packages/modern')
    const legacyApp = join(legacyRoot, 'src/App.vue')
    const modernApp = join(modernRoot, 'src/App.vue')
    for (const [packageRoot, version, appFile] of [
      [legacyRoot, '2.7.16', legacyApp],
      [modernRoot, '3.5.4', modernApp]
    ] as const) {
      await mkdir(join(packageRoot, 'src'), { recursive: true })
      await writeJson(join(packageRoot, 'package.json'), { dependencies: { vue: version } })
      await installPackage(packageRoot, 'vue', version)
      await writeFile(appFile, '<template><main /></template>')
      await writeFile(join(packageRoot, 'src/main.ts'), version.startsWith('2')
        ? `import Vue from 'vue'\nimport App from './App.vue'\nnew Vue({ render: h => h(App) }).$mount('#app')\n`
        : `import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n`)
    }

    const targetFiles = await discoverTargetFiles({ root, files: [rootApp, legacyApp, modernApp] })
    const result = await buildProjectContext({ root, targetFiles })

    expect(result.vueVersions).toEqual({
      [rootApp]: '3.4.0',
      [legacyApp]: '2.7.16',
      [modernApp]: '3.5.4'
    })
    expect(result.projectContext.packages.map((item) => ({
      root: item.root,
      vue: item.inventory.vue?.installedVersion,
      targets: item.targetFiles
    }))).toEqual([
      { root, vue: '3.4.0', targets: [rootApp] },
      { root: legacyRoot, vue: '2.7.16', targets: [legacyApp] },
      { root: modernRoot, vue: '3.5.4', targets: [modernApp] }
    ])
    expect(result.applicationIds[rootApp]).toBeDefined()
    expect(result.applicationIds[legacyApp]).toBeDefined()
    expect(result.applicationIds[modernApp]).toBeDefined()
    expect(result.applicationIds[legacyApp]).not.toBe(result.applicationIds[modernApp])
    expect(result.projectContext.applications).toHaveLength(3)
    expect(new Set(result.projectContext.applications.map((application) => application.id)).size).toBe(3)
  })

  test('keeps unresolved aliases and missing application ownership auditable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-partial-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '^3.5.0' } })
    await installPackage(root, 'vue', '3.5.4')
    await writeFile(join(root, 'src/main.ts'), `import { createApp } from 'vue'\nimport App from '@/App.vue'\ncreateApp(App).mount('#app')\n`)
    const appFile = join(root, 'src/App.vue')
    await writeFile(appFile, '<template><main /></template>')

    const targetFiles = await discoverTargetFiles({ root, files: [appFile] })
    const result = await buildProjectContext({ root, targetFiles })

    expect(Object.hasOwn(result.applicationIds, appFile)).toBe(true)
    expect(result.applicationIds[appFile]).toBeUndefined()
    contextualizeSourceUsage(result, {
      root,
      files: [appFile],
      components: [{
        file: appFile,
        tag: 'FixtureButton',
        componentName: 'FixtureButton',
        loc: { line: 1, column: 10 },
        props: [], propSpreads: [], events: [], models: [], slots: [], directives: []
      }],
      globalPlugins: [],
      fileResults: []
    })
    expect(result.projectContext.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'entry-import-unresolved', file: join(root, 'src/main.ts') }),
      expect.objectContaining({ code: 'application-ownership-unavailable', file: appFile })
    ]))
  })

  test('uses inherited JSONC aliases for Vue 2 roots, router traversal and reachable constructor registrations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-vue2-alias-'))
    await mkdir(join(root, 'src/router'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '2.7.16', 'fixture-ui': '1.0.0' } })
    await installPackage(root, 'vue', '2.7.16')
    await writeJson(join(root, 'tsconfig.json'), { extends: './tsconfig.app.json' })
    await writeFile(join(root, 'tsconfig.app.json'), `{
      // Explicit project evidence, not an inferred src convention.
      "compilerOptions": { "paths": { "@/*": ["./src/*"] } },
    }`)
    const appFile = join(root, 'src/App.vue')
    const pageFile = join(root, 'src/Page.vue')
    await writeFile(appFile, '<template><router-view /></template>')
    await writeFile(pageFile, '<template><FixtureButton /></template>')
    await writeFile(join(root, 'src/router/index.ts'), `import '@/install'\nexport const routes = [{ component: () => import('@/Page.vue') }]`)
    await writeFile(join(root, 'src/install.ts'), `import Vue from 'vue'\nimport Ui from 'fixture-ui'\nimport '@/router'\nVue.use(Ui)`)
    await writeFile(join(root, 'src/main.ts'), `import Vue from 'vue'\nimport App from '@/App.vue'\nimport '@/router'\nnew Vue({ render: h => h(App) }).$mount('#app')`)
    const result = await buildProjectContext({ root, targetFiles: await discoverTargetFiles({ root, files: [appFile, pageFile] }) })
    expect(result.projectContext.applications).toEqual([expect.objectContaining({
      rootComponentFiles: [appFile],
      plugins: [expect.objectContaining({ localName: 'Ui' })]
    })])
    expect(result.applicationIds[appFile]).toBeDefined()
    expect(result.applicationIds[pageFile]).toBe(result.applicationIds[appFile])
    expect(result.projectContext.issues).toEqual([])
  })

  test('retains ambiguous Vue 2 ownership and does not create roots for registration-only modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-vue2-shared-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '2.7.16' } })
    await installPackage(root, 'vue', '2.7.16')
    const shared = join(root, 'src/Shared.vue')
    await writeFile(shared, '<template><FixtureButton /></template>')
    await writeFile(join(root, 'src/install.ts'), `import Vue from 'vue'\nimport Ui from 'fixture-ui'\nVue.use(Ui)`)
    await writeFile(join(root, 'src/main.ts'), `import Vue from 'vue'\nimport App from './Shared.vue'\nimport './install'\nnew Vue({ render: h => h(App) })\nnew Vue({ render: h => h(App) })`)
    const result = await buildProjectContext({ root, targetFiles: await discoverTargetFiles({ root, files: [shared] }) })
    expect(result.projectContext.applications).toHaveLength(2)
    expect(result.projectContext.applications.every((app) => app.plugins.length === 1)).toBe(true)
    expect(result.applicationIds[shared]).toBeUndefined()
  })

  test('does not traverse alias targets outside the package, nested packages or escaping symlinks', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vue-doctor-context-alias-safety-'))
    const root = join(workspace, 'app')
    await mkdir(join(root, 'src/nested'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '2.7.16' } })
    await installPackage(root, 'vue', '2.7.16')
    await writeJson(join(root, 'src/nested/package.json'), { name: 'nested-package' })
    await writeFile(join(root, 'src/nested/module.ts'), 'export default {}')
    await writeFile(join(workspace, 'outside.ts'), 'export default {}')
    await symlink(join(workspace, 'outside.ts'), join(root, 'src/escape.ts'))
    await writeJson(join(root, 'tsconfig.json'), { compilerOptions: { baseUrl: '.', paths: {
      '#outside': ['../outside.ts'], '#nested': ['src/nested/module.ts'], '#escape': ['src/escape.ts']
    } } })
    const appFile = join(root, 'src/App.vue')
    await writeFile(appFile, '<template><main /></template>')
    await writeFile(join(root, 'src/main.ts'), `import Vue from 'vue'\nimport App from './App.vue'\nimport '#outside'\nimport '#nested'\nimport '#escape'\nnew Vue({ render: h => h(App) })`)
    const result = await buildProjectContext({ root, targetFiles: await discoverTargetFiles({ root, files: [appFile] }) })
    expect(result.projectContext.files).toEqual([appFile, join(root, 'src/main.ts')])
    expect(result.projectContext.issues.filter((issue) => issue.code === 'entry-import-unresolved')).toHaveLength(3)
  })

  test('keeps cyclic alias configuration unresolved instead of guessing src', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-alias-cycle-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '2.7.16' } })
    await installPackage(root, 'vue', '2.7.16')
    await writeJson(join(root, 'tsconfig.json'), { extends: './other.json' })
    await writeJson(join(root, 'other.json'), { extends: './tsconfig.json' })
    const appFile = join(root, 'src/App.vue')
    await writeFile(appFile, '<template><main /></template>')
    await writeFile(join(root, 'src/main.ts'), `import Vue from 'vue'\nimport App from '@/App.vue'\nnew Vue({ render: h => h(App) })`)
    const result = await buildProjectContext({ root, targetFiles: await discoverTargetFiles({ root, files: [appFile] }) })
    expect(result.applicationIds[appFile]).toBeUndefined()
    expect(result.projectContext.issues).toContainEqual(expect.objectContaining({ message: expect.stringContaining('inheritance cycle') }))
  })

  test('does not inherit lazy or type-only constructor installs, or leak Vue 2 plugins into Vue 3', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-eager-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '2.7.16' } })
    await installPackage(root, 'vue', '2.7.16')
    const legacy = join(root, 'src/Legacy.vue')
    const modern = join(root, 'src/Modern.vue')
    await writeFile(legacy, '<template><LegacyButton /></template>')
    await writeFile(modern, '<template><ModernButton /></template>')
    for (const name of ['eager', 'lazy', 'types']) {
      await writeFile(join(root, `src/${name}.ts`), `import Vue from 'vue'\nimport Ui from '${name}-ui'\nVue.use(Ui)\nexport type Config = {}`)
    }
    await writeFile(join(root, 'src/main.ts'), `
import Vue, { createApp } from 'vue'
import Legacy from './Legacy.vue'
import Modern from './Modern.vue'
import type { Config } from './types'
import './eager'
const later = () => import('./lazy')
new Vue({ render: h => h(Legacy) })
createApp(Modern)
`)
    const result = await buildProjectContext({ root, targetFiles: await discoverTargetFiles({ root, files: [legacy, modern] }) })
    expect(result.projectContext.applications.find((app) => app.framework === 'vue2.7')?.plugins.map((plugin) => plugin.package.packageName)).toEqual(['eager-ui'])
    expect(result.projectContext.applications.find((app) => app.framework === 'vue3')?.plugins).toEqual([])
  })

  test('expands literal glob routes without widening targets or eagerly installing lazy plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-glob-'))
    await mkdir(join(root, 'src/views/nested'), { recursive: true })
    await mkdir(join(root, 'src/plugins'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '2.7.16' } })
    await installPackage(root, 'vue', '2.7.16')
    await writeJson(join(root, 'tsconfig.json'), { compilerOptions: { paths: { '@/*': ['./src/*'] } } })
    const page = join(root, 'src/views/nested/Page.vue')
    const excluded = join(root, 'src/views/Excluded.vue')
    const app = join(root, 'src/App.vue')
    await writeFile(app, '<template><main /></template>')
    await writeFile(page, '<template><LibraryButton /></template>')
    await writeFile(excluded, '<template><LibraryButton /></template>')
    await writeFile(join(root, 'src/plugins/lazy.ts'), 'import Vue from "vue"; import Ui from "lazy-ui"; Vue.use(Ui)')
    await writeFile(join(root, 'src/eager.ts'), 'import Vue from "vue"; import Ui from "eager-ui"; Vue.use(Ui)')
    await writeFile(join(root, 'src/main.ts'), `
import Vue from 'vue'
import App from './App.vue'
const pages = import.meta.glob(['@/views/**/*.vue', '!@/views/Excluded.vue'])
const plugins = import.meta.glob('./plugins/*.ts')
const eager = import.meta.glob('/src/eager.ts', { eager: true, import: 'default' })
new Vue({ render: h => h(App) })
`)
    const targets = await discoverTargetFiles({ root, files: [page, excluded] })
    const result = await buildProjectContext({ root, targetFiles: targets })
    expect(result.applicationIds[page]).toBe(result.projectContext.applications[0]?.id)
    expect(result.applicationIds[excluded]).toBeUndefined()
    expect(result.projectContext.applications[0]?.plugins.map(plugin => plugin.package.packageName)).toEqual(['eager-ui'])
    expect(targets.files).toEqual([excluded, page])
    expect(result.projectContext.issues).toEqual([])
  })

  test.each([
    ['keys-only', `Object.keys(import.meta.glob('./plugins/*.ts', { eager: true }))`, []],
    ['extglob', `import.meta.glob('./plugins/+(install).ts', { eager: true })`, []],
    ['eager', `import.meta.glob('./plugins/*.ts', { eager: true })`, ['own-ui']],
    ['alias', `import.meta.glob('@/plugins/*.ts', { eager: true })`, ['own-ui']]
  ])('matches Vite module evidence with literal path metacharacters: %s', async (_, expression, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-[copy]-'))
    const entryDirectory = join(root, 'src/[ab]')
    for (const path of [entryDirectory, join(root, 'src/a')]) await mkdir(join(path, 'plugins'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '2.7.16' } })
    await installPackage(root, 'vue', '2.7.16')
    await writeJson(join(root, 'tsconfig.json'), { compilerOptions: { paths: { '@/*': ['./src/[ab]/*'] } } })
    const app = join(entryDirectory, 'App.vue')
    await writeFile(app, '<template><main /></template>')
    await writeFile(join(entryDirectory, 'plugins/install.ts'), 'import Vue from "vue"; import Ui from "own-ui"; Vue.use(Ui)')
    await writeFile(join(root, 'src/a/plugins/install.ts'), 'import Vue from "vue"; import Ui from "wrong-ui"; Vue.use(Ui)')
    await writeFile(join(root, 'src/main.ts'), `import './[ab]/bootstrap'`)
    await writeFile(join(entryDirectory, 'bootstrap.ts'), `
      import Vue from 'vue'
      import App from './App.vue'
      const modules = ${expression}
      new Vue({ render: h => h(App) })
    `)
    const result = await buildProjectContext({ root, targetFiles: await discoverTargetFiles({ root, files: [app] }) })
    expect(result.projectContext.applications[0]?.plugins.map(plugin => plugin.package.packageName)).toEqual(expected)
    expect(result.projectContext.files).not.toContain(join(root, 'src/a/plugins/install.ts'))
    expect(result.projectContext.issues).toEqual([])
  })

  test.each([
    `['./plugins/**/*.ts', '!./plugins/*/./install.ts']`,
    `'./plugins/*/./install.ts'`,
    `'./plugins/*//install.ts'`,
    `'/src/plugins/*/./install.ts'`
  ])('keeps mode-dependent glob normalization unresolved: %s', async patterns => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-glob-normalization-'))
    await mkdir(join(root, 'src/plugins/a'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '2.7.16' } })
    await installPackage(root, 'vue', '2.7.16')
    const app = join(root, 'src/App.vue')
    await writeFile(app, '<template><main /></template>')
    await writeFile(join(root, 'src/plugins/a/install.ts'), 'import Vue from "vue"; import Ui from "conditional-ui"; Vue.use(Ui)')
    await writeFile(join(root, 'src/main.ts'), `
      import Vue from 'vue'; import App from './App.vue'
      const modules = import.meta.glob(${patterns}, { eager: true })
      new Vue({ render: h => h(App) })
    `)
    const result = await buildProjectContext({ root, targetFiles: await discoverTargetFiles({ root, files: [app] }) })
    expect(result.projectContext.applications[0]?.plugins).toEqual([])
    expect(result.projectContext.issues).toContainEqual(expect.objectContaining({
      code: 'entry-import-unresolved', message: expect.stringContaining('normalization')
    }))
  })

  test('keeps glob ownership inside package and physical boundaries and reports dynamic loaders', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vue-doctor-context-glob-boundary-'))
    const root = join(workspace, 'app')
    await mkdir(join(root, 'src/views/nested'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '2.7.16' } })
    await installPackage(root, 'vue', '2.7.16')
    const outside = join(workspace, 'Outside.vue')
    const escaped = join(root, 'src/views/Escaped.vue')
    const nested = join(root, 'src/views/nested/Page.vue')
    const app = join(root, 'src/App.vue')
    await writeFile(outside, '<template><Outside /></template>')
    await symlink(outside, escaped)
    await writeJson(join(root, 'src/views/nested/package.json'), { name: 'nested-package' })
    await writeFile(nested, '<template><Nested /></template>')
    await writeFile(app, '<template><main /></template>')
    await writeFile(join(root, 'src/main.ts'), `
import Vue from 'vue'
import App from './App.vue'
const pages = import.meta.glob('./views/**/*.vue')
const dynamic = import.meta.glob(pattern)
const unsafe = import.meta.glob('../../*.vue')
const raw = import.meta.glob('./views/*.vue', { query: '?raw', import: 'default' })
new Vue({ render: h => h(App) })
`)
    const result = await buildProjectContext({ root, targetFiles: await discoverTargetFiles({ root, files: [app] }) })
    expect(result.projectContext.files).not.toContain(outside)
    expect(result.projectContext.files).not.toContain(escaped)
    expect(result.projectContext.files).not.toContain(nested)
    expect(result.projectContext.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'entry-import-unresolved', message: expect.stringContaining('literal patterns') }),
      expect.objectContaining({ code: 'entry-import-unresolved', message: expect.stringContaining('outside') })
    ]))
  })

  test('does not require application ownership for utility targets without component usage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-utility-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '^3.5.0' } })
    await installPackage(root, 'vue', '3.5.4')
    const appFile = join(root, 'src/App.vue')
    const utilityFile = join(root, 'src/tool.ts')
    await writeFile(appFile, '<template><main /></template>')
    await writeFile(utilityFile, 'export const value = 1\n')
    await writeFile(join(root, 'src/main.ts'), `import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n`)
    const targetFiles = await discoverTargetFiles({ root, files: [appFile, utilityFile] })
    const result = await buildProjectContext({ root, targetFiles })

    contextualizeSourceUsage(result, {
      root,
      files: [appFile, utilityFile],
      components: [],
      globalPlugins: [],
      fileResults: []
    })

    expect(Object.hasOwn(result.applicationIds, utilityFile)).toBe(true)
    expect(result.applicationIds[utilityFile]).toBeUndefined()
    expect(result.projectContext.issues).toEqual([])
  })

  test('ignores an unrelated nested main candidate that cannot reach a target application', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-candidate-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'tests/fixture'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '^3.5.0' } })
    await installPackage(root, 'vue', '3.5.4')
    const appFile = join(root, 'src/App.vue')
    await writeFile(appFile, '<template><main /></template>')
    await writeFile(join(root, 'src/main.ts'), `import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n`)
    await writeFile(join(root, 'tests/fixture/main.ts'), `import('@/missing/' + name)\nconst = broken\n`)
    await writeFile(join(root, 'tests/fixture/index.html'), '<script type="module" src="./missing-entry.ts"></script>')
    const targetFiles = await discoverTargetFiles({ root, files: [appFile] })
    const result = await buildProjectContext({ root, targetFiles })

    expect(result.applicationIds[appFile]).toBeDefined()
    expect(result.projectContext.issues).toEqual([])
    expect(result.projectContext.files).not.toContain(join(root, 'tests/fixture/main.ts'))
  })

  test('retains unresolved HTML entry evidence when that page is an explicit target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-context-html-target-'))
    await mkdir(join(root, 'pages'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '^3.5.0' } })
    await installPackage(root, 'vue', '3.5.4')
    const html = join(root, 'pages/index.html')
    await writeFile(html, '<script type="module" src="./missing-entry.ts"></script>')
    const targetFiles = await discoverTargetFiles({ root, files: [html], extensions: ['.html'] })
    const result = await buildProjectContext({ root, targetFiles })
    expect(result.projectContext.issues).toContainEqual(expect.objectContaining({ code: 'entry-import-unresolved', file: html }))
  })

  test('rejects a context import whose symlink escapes the consuming package', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vue-doctor-context-escape-'))
    const root = join(workspace, 'app')
    const outside = join(workspace, 'outside.ts')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '^3.5.0' } })
    await installPackage(root, 'vue', '3.5.4')
    await writeFile(outside, 'export const outside = true\n')
    await symlink(outside, join(root, 'src/escaped.ts'))
    const appFile = join(root, 'src/App.vue')
    await writeFile(appFile, '<template><main /></template>')
    await writeFile(join(root, 'src/main.ts'), `
import { createApp } from 'vue'
import App from './App.vue'
import './escaped'
createApp(App).mount('#app')
`)
    const targetFiles = await discoverTargetFiles({ root, files: [appFile] })
    const result = await buildProjectContext({ root, targetFiles })

    expect(result.projectContext.files).not.toContain(join(root, 'src/escaped.ts'))
    expect(result.projectContext.issues).toContainEqual(expect.objectContaining({
      code: 'entry-import-unresolved',
      file: join(root, 'src/main.ts')
    }))
  })

  test('rejects a symlinked application entry that escapes the consuming package', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vue-doctor-context-entry-escape-'))
    const root = join(workspace, 'app')
    const outsideEntry = join(workspace, 'main.ts')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), { dependencies: { vue: '^3.5.0' } })
    await installPackage(root, 'vue', '3.5.4')
    await writeFile(outsideEntry, `import { createApp } from 'vue'\ncreateApp({}).mount('#escape')\n`)
    await symlink(outsideEntry, join(root, 'src/main.ts'))
    const appFile = join(root, 'src/App.vue')
    await writeFile(appFile, '<template><main /></template>')
    const targetFiles = await discoverTargetFiles({ root, files: [appFile] })
    const result = await buildProjectContext({ root, targetFiles })

    expect(result.projectContext.files).not.toContain(join(root, 'src/main.ts'))
    expect(result.projectContext.issues).toContainEqual(expect.objectContaining({
      code: 'entry-discovery-failed',
      file: join(root, 'src/main.ts'),
      message: expect.stringContaining('outside')
    }))
  })
})

import { describe, expect, test } from 'vitest'
import { analyzeProjectModuleContext } from './plugins.js'

describe('Vue application plugin registrations', () => {
  test('preserves a scoped package subpath only for a proven Vue app receiver', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import App from './App.vue'
import FixtureUi from '@fixture/ui/plugin'
import router from './router'
const app = createApp(App)
router.use(FixtureUi)
app.use(FixtureUi)
`)

    expect(result.applications).toEqual([{
      file: '/fixture/main.ts',
      framework: 'vue3',
      appLocalName: 'app',
      rootComponentImport: './App.vue',
      rootComponentLocalName: 'App',
      plugins: [{
        file: '/fixture/main.ts',
        package: { specifier: '@fixture/ui/plugin', packageName: '@fixture/ui', subpath: './plugin' },
        localName: 'FixtureUi'
      }]
    }])
    expect(result.unresolvedImports).toEqual([])
  })

  test('does not attribute router.use or a shadowed app parameter as global Vue registration', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import App from './App.vue'
import FixtureUi from 'fixture-ui'
import router from './router'
const app = createApp(App)
router.use(FixtureUi)
function install(app: typeof router) { app.use(FixtureUi) }
`)

    expect(result.applications).toEqual([expect.objectContaining({ appLocalName: 'app', plugins: [] })])
  })

  test('keeps registrations separated for two application receivers', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp as makeApp } from 'vue'
import First from './First.vue'
import Second from './Second.vue'
import FirstUi from 'first-ui'
import SecondUi from 'second-ui'
const first = makeApp(First)
const second = makeApp(Second)
first.use(FirstUi)
second.use(SecondUi)
`)

    expect(result.applications.map((application) => ({
      app: application.appLocalName,
      root: application.rootComponentImport,
      plugins: application.plugins.map((plugin) => plugin.package.packageName)
    }))).toEqual([
      { app: 'first', root: './First.vue', plugins: ['first-ui'] },
      { app: 'second', root: './Second.vue', plugins: ['second-ui'] }
    ])
  })

  test('supports createSSRApp and chained registrations on named and inline applications', () => {
    const named = analyzeProjectModuleContext('/fixture/ssr.ts', `
import { createSSRApp } from 'vue'
import App from './App.vue'
import FirstUi from 'first-ui'
import SecondUi from 'second-ui'
const app = createSSRApp(App)
app.use(FirstUi).use(SecondUi)
`)
    const inline = analyzeProjectModuleContext('/fixture/inline.ts', `
import { createApp } from 'vue'
import App from './App.vue'
import FixtureUi from 'fixture-ui'
createApp(App).use(FixtureUi).mount('#app')
`)

    expect(named.applications[0]?.plugins.map((plugin) => plugin.package.packageName)).toEqual([
      'first-ui',
      'second-ui'
    ])
    expect(inline.applications).toEqual([expect.objectContaining({
      appLocalName: expect.stringMatching(/^inline-/),
      rootComponentImport: './App.vue',
      plugins: [expect.objectContaining({ localName: 'FixtureUi' })]
    })])
  })

  test('keeps declared identity when the factory chain is a variable initializer or export', () => {
    const result = analyzeProjectModuleContext('/fixture/exported.ts', `
import { createApp } from 'vue'
import App from './App.vue'
import FixtureUi from 'fixture-ui'
export const app = createApp(App).use(FixtureUi)
app.mount('#app')
`)

    expect(result.applications).toEqual([expect.objectContaining({
      appLocalName: 'app',
      rootComponentImport: './App.vue',
      plugins: [expect.objectContaining({ localName: 'FixtureUi' })]
    })])
  })

  test('recognizes Vue 2 default and namespace imports but rejects lookalikes', () => {
    const defaultResult = analyzeProjectModuleContext('/fixture/vue2.ts', `
import Vue from 'vue'
import FixtureUi from 'fixture-ui'
Vue.use(FixtureUi)
`)
    const namespaceResult = analyzeProjectModuleContext('/fixture/vue2-ns.ts', `
import * as VueRuntime from 'vue-compat'
import FixtureUi from 'fixture-ui'
VueRuntime.use(FixtureUi)
`, { vueImportRoots: ['vue-compat'] })
    const lookalike = analyzeProjectModuleContext('/fixture/router.ts', `
import Router from 'router'
import FixtureUi from 'fixture-ui'
Router.use(FixtureUi)
`)

    expect(defaultResult.applications).toEqual([])
    expect(defaultResult.vueConstructorPlugins).toEqual([{
      constructorImport: 'vue', plugins: [expect.objectContaining({ localName: 'FixtureUi' })]
    }])
    expect(namespaceResult.applications).toEqual([])
    expect(namespaceResult.vueConstructorPlugins).toEqual([{
      constructorImport: 'vue-compat', plugins: [expect.objectContaining({ localName: 'FixtureUi' })]
    }])
    expect(lookalike.applications).toEqual([])
  })

  test('recognizes a Vue 2 bootstrap and root component without Vue.use', () => {
    const result = analyzeProjectModuleContext('/fixture/vue2-main.ts', `
import Vue from 'vue'
import App from './App.vue'
new Vue({ render: h => h(App) }).$mount('#app')
`)

    expect(result.applications).toEqual([expect.objectContaining({
      framework: 'vue2.7',
      appLocalName: expect.stringMatching(/^vue2-inline-/),
      rootComponentImport: './App.vue',
      rootComponentLocalName: 'App',
      plugins: []
    })])
  })

  test('selects the Vue 2 render VNode component instead of an earlier imported wrapper', () => {
    const result = analyzeProjectModuleContext('/fixture/vue2-main.ts', `
import Vue from 'vue'
import App from './App.vue'
import decorate from './decorate'
new Vue({ render: h => decorate(h(App)) }).$mount('#app')
`)

    expect(result.applications).toEqual([expect.objectContaining({
      framework: 'vue2.7',
      rootComponentImport: './App.vue',
      rootComponentLocalName: 'App'
    })])
  })

  test('attaches constructor-global plugins before or after inline Vue 2 roots without inventing an application', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import Vue from 'vue'
import App from '@/App.vue'
import Before from 'before-ui'
import After from 'after-ui'
Vue.use(Before)
new Vue({ render: h => h(App) }).$mount('#app')
Vue.use(After)
`)
    expect(result.applications).toEqual([expect.objectContaining({
      framework: 'vue2.7',
      vueConstructorImport: 'vue',
      rootComponentImport: '@/App.vue',
      plugins: [
        expect.objectContaining({ localName: 'Before' }),
        expect.objectContaining({ localName: 'After' })
      ]
    })])
  })

  test('does not share constructor registrations across runtime imports or Vue 3 applications', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import Vue from 'vue'
import OtherVue from 'other-vue'
import { createApp } from 'vue'
import App from './App.vue'
import Ui from 'fixture-ui'
Vue.use(Ui)
new Vue({ render: h => h(App) })
new OtherVue({ render: h => h(App) })
createApp(App)
if (enabled) OtherVue.use(Ui)
`, { vueImportRoots: ['vue', 'other-vue'] })
    expect(result.applications.map((application) => application.plugins.length)).toEqual([1, 0, 0])
    expect(result.vueConstructorPlugins).toHaveLength(1)
  })

  test('excludes erased type imports and exports from application reachability', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import type { Missing } from './missing'
import { type Shape } from './shapes'
export type { Other } from './other'
export { type Another } from './another'
import './effects'
import { type Options, install } from 'runtime-library'
const lazy = () => import('./lazy')
`)
    expect(result.imports).toEqual(['./effects', './lazy', 'runtime-library'])
    expect(result.eagerImports).toEqual(['./effects', 'runtime-library'])
    expect(result.unresolvedImports).toEqual([])
  })

  test('preserves inline application offsets after a large CRLF template and isolates script failures', () => {
    const source = '<template>\r\n' + '<div>{{ value }}</div>\r\n'.repeat(2000)
      + '</template>\r\n<script>\r\nimport Vue from "vue"\r\nimport App from "./App.vue"\r\nnew Vue({ render: h => h(App) })\r\n</script>'
      + '<script setup lang="ts">const broken: = 1</script>'
    const result = analyzeProjectModuleContext('/fixture/Entry.vue', source)
    expect(result.applications).toEqual([expect.objectContaining({
      appLocalName: `vue2-inline-${source.indexOf('new Vue')}`,
      rootComponentImport: './App.vue'
    })])
    expect(result.errors).toEqual([expect.stringMatching(/^script-setup:/)])
  })

  test('captures static template-literal glob candidates and negative patterns', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts',
      'const pages = import.meta.glob([`./views/**/*.vue`, "!./views/private/**"], { eager: true })')
    expect(result.globImports).toEqual([{ patterns: ['./views/**/*.vue', '!./views/private/**'], eager: true }])
    expect(result.unresolvedImports).toEqual([])
  })

  test.each([
    `Object.keys(import.meta.glob('./plugins/*.ts', { eager: true }))`,
    `Object.keys(/* names only */ import.meta.glob('./plugins/*.ts', { eager: true }))`,
    `function names(Object) { return Object.keys(import.meta.glob('./plugins/*.ts')) }`
  ])('does not treat Vite keys-only globs as module loads: %s', source => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', source)
    expect(result.globImports).toBeUndefined()
    expect(result.unresolvedImports).toEqual([])
  })

  test.each([
    `Object.values(import.meta.glob('./plugins/*.ts', { eager: true }))`,
    `Object.keys (import.meta.glob('./plugins/*.ts', { eager: true }))`,
    `Object.keys((import.meta.glob('./plugins/*.ts', { eager: true })))`,
    `Object['keys'](import.meta.glob('./plugins/*.ts', { eager: true }))`
  ])('retains module loads outside Vite keys-only syntax: %s', source => {
    expect(analyzeProjectModuleContext('/fixture/main.ts', source).globImports)
      .toEqual([{ patterns: ['./plugins/*.ts'], eager: true }])
  })

  test('retains dynamic or resource glob loaders as unresolved rather than module edges', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
const dynamic = import.meta.glob(pattern)
const options = import.meta.glob('./views/*.vue', config)
const raw = import.meta.glob('./views/*.vue', { query: '?raw' })
const lookalike = other.glob('./views/*.vue')
`)
    expect(result.globImports).toBeUndefined()
    expect(result.unresolvedImports).toEqual([
      'import.meta.glob requires literal patterns and supported static module options.'
    ])
  })

  test('reports script parse failure as context evidence', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', 'const = broken')
    expect(result.applications).toEqual([])
    expect(result.errors).toHaveLength(1)
  })
})

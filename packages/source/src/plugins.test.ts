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

  test.each([
    'app = other',
    'app += other',
    'app++',
    '[app] = [other]',
    '({ app } = { app: other })',
    'for (app of [other]) {}',
    'for (app in other) {}',
    'for ([app] of [[other]]) {}',
    'for ({ app } of [{ app: other }]) {}',
    'if (enabled) app = other',
    'app.use = other.use',
    'delete app.use',
    'const holder = { app }; holder.app.use = other.use',
    'const aliases = [app]; mutate(aliases)',
    'for (const alias of [app]) { alias.use = other.use }',
    'const { current } = { current: app }; current.use = other.use',
    'const alias = app; alias.use = other.use',
    'const alias = app; mutate(alias)',
    'mutate`${app}`;',
    'app.mutate`text`;',
    'const alias = app; mutate`${alias}`;'
  ])('invalidates live receivers after writes or escapes without erasing prior registrations: %s', (mutation) => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import App from './App.vue'
import Before from 'before-ui'
import After from 'after-ui'
let app = createApp(App)
app.use(Before);
${mutation}
app.use(After)
`)
    expect(result.errors).toEqual([])
    expect(result.applications).toEqual([expect.objectContaining({
      rootComponentImport: './App.vue',
      plugins: [expect.objectContaining({ localName: 'Before' })]
    })])
  })

  test('keeps real receivers after tagged calls that only reference a shadow or unrelated data', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import Ui from 'fixture-ui'
const app = createApp({})
function later(app) { mutate\`\${app}\` }
mutate\`unrelated\`;
app.use(Ui)
`)
    expect(result.errors).toEqual([])
    expect(result.applications[0]?.plugins).toEqual([expect.objectContaining({ localName: 'Ui' })])
  })

  test('tracks alias binding identity across reassignment and unrelated loop shadows', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import App from './App.vue'
import Ui from 'fixture-ui'
let app = createApp(App)
const alias = app
app = other
for (let alias of others) { alias = other }
alias.use(Ui)
app.use(Ui)
`)
    expect(result.errors).toEqual([])
    expect(result.applications[0]?.plugins).toEqual([expect.objectContaining({ localName: 'Ui' })])
  })

  test.each([
    'var app = { use() {} }',
    'var app = undefined',
    'var [app] = [other]',
    'var { replacement: app } = other',
    'if (enabled) { var app = other }',
    'for (var app of [{ use() {} }]) {}',
    'for (var app in other) {}',
    'for (var [app] of [[other]]) {}',
    'for (var { replacement: app } of [other]) {}'
  ])('clears stale receiver identity on initialized var and declaration-loop writes: %s', (write) => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import Before from 'before-ui'
import After from 'after-ui'
var app = createApp({})
app.use(Before)
${write}
app.use(After)
`)
    expect(result.errors).toEqual([])
    expect(result.applications).toEqual([expect.objectContaining({
      appLocalName: 'app',
      plugins: [expect.objectContaining({ localName: 'Before' })]
    })])
  })

  test('replaces an initialized var receiver without changing an alias of its previous app', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import First from './First.vue'
import Second from './Second.vue'
import FirstUi from 'first-ui'
import SecondUi from 'second-ui'
var app = createApp(First)
const first = app
var app = createApp(Second)
first.use(FirstUi)
app.use(SecondUi)
`)
    expect(result.errors).toEqual([])
    expect(result.applications.map(application => ({
      root: application.rootComponentImport,
      plugins: application.plugins.map(plugin => plugin.localName)
    }))).toEqual([
      { root: './First.vue', plugins: ['FirstUi'] },
      { root: './Second.vue', plugins: ['SecondUi'] }
    ])
  })

  test.each([
    'app = other',
    'for (var app of [other]) {}',
    'if (enabled) { var app = other }'
  ])('restores receiver proof only from a fresh initializer after a variable write: %s', (write) => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import First from './First.vue'
import Second from './Second.vue'
import Ui from 'fixture-ui'
var app = createApp(First)
${write}
var app = createApp(Second)
app.use(Ui)
`)
    expect(result.errors).toEqual([])
    expect(result.applications.map(application => ({
      root: application.rootComponentImport,
      plugins: application.plugins.map(plugin => plugin.localName)
    }))).toEqual([
      { root: './First.vue', plugins: [] },
      { root: './Second.vue', plugins: ['Ui'] }
    ])
  })

  test.each([
    'var app',
    'if (enabled) { var app }',
    'var app = app',
    'for (let app of [other]) { app = replacement }',
    'for (const app of [other]) { app.use(Ui) }',
    'for (let app in other) {}',
    'for (const [app] of [[other]]) {}',
    '{ let app = other; app = replacement }',
    '{ const app = other; app.use(Ui) }'
  ])('preserves receiver proof across uninitialized var declarations and lexical shadows: %s', (statement) => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import Ui from 'fixture-ui'
var app = createApp({})
${statement}
app.use(Ui)
`)
    expect(result.errors).toEqual([])
    expect(result.applications[0]?.plugins).toEqual([expect.objectContaining({ localName: 'Ui' })])
  })

  test('does not borrow receiver proof from a later initializer or deferred writes', () => {
    const beforeInitialization = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import Ui from 'fixture-ui'
app.use(Ui)
const app = createApp({})
`)
    const deferredWrite = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import Ui from 'fixture-ui'
const replace = () => { app = other }
let app = createApp({})
replace()
app.use(Ui)
`)
    expect(beforeInitialization.applications[0]?.plugins).toEqual([])
    expect(deferredWrite.applications[0]?.plugins).toEqual([])
  })

  test.each([
    ".mount('#app')",
    '.unknown()',
    ".component('Root')",
    ".directive('focus')",
    ".component('Root', undefined)",
    ".component('Root', null)",
    ".directive('focus', false)",
    '.runWithContext(() => ({ use() {} }))',
    '.onUnmount(() => {})',
    '.unmount()'
  ])('retains bootstrap roots but rejects non-app-returning chain receivers: %s', (chain) => {
    for (const expression of [
      `const instance = createApp(App).use(Before)${chain}; instance.use(After)`,
      `createApp(App).use(Before)${chain}.use(After)`
    ]) {
      const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createApp } from 'vue'
import App from './App.vue'
import Before from 'before-ui'
import After from 'after-ui'
${expression}
`)
      expect(result.errors).toEqual([])
      expect(result.applications).toEqual([expect.objectContaining({
        rootComponentImport: './App.vue',
        plugins: [expect.objectContaining({ localName: 'Before' })]
      })])
    }
  })

  test.each([
    '.use(Before)',
    '.mixin({})',
    ".provide('key', {})",
    ".component('Root', App)",
    ".component('Root', {})",
    ".directive('focus', { mounted() {} })"
  ])('preserves proven app-returning chains and their aliases: %s', (chain) => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import * as VueRuntime from 'vue-runtime'
import App from './App.vue'
import Before from 'before-ui'
import After from 'after-ui'
const app = VueRuntime.createApp(App)${chain}
const alias = app
alias.use(After)
`, { vueImportRoots: ['vue-runtime'] })
    expect(result.errors).toEqual([])
    expect(result.applications).toHaveLength(1)
    expect(result.applications[0]?.plugins.map(plugin => plugin.localName))
      .toEqual(chain === '.use(Before)' ? ['Before', 'After'] : ['After'])
  })

  test('keeps an app live after mount while rejecting the returned component instance', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import { createSSRApp } from 'vue'
import App from './App.vue'
import Ui from 'fixture-ui'
const app = createSSRApp(App)
const instance = app.mount('#app')
instance.use(Ui)
app.use(Ui)
`)
    expect(result.applications[0]?.plugins).toEqual([expect.objectContaining({ localName: 'Ui' })])
  })

  test('does not treat a Vue 2 root instance as the imported plugin constructor', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import Vue from 'vue'
import App from './App.vue'
import Before from 'before-ui'
import After from 'after-ui'
Vue.use(Before)
const instance = new Vue({ render: h => h(App) }).$mount('#app')
instance.use(After)
`)
    expect(result.applications).toEqual([expect.objectContaining({
      framework: 'vue2.7',
      rootComponentImport: './App.vue',
      plugins: [expect.objectContaining({ localName: 'Before' })]
    })])
  })

  test('keeps Vue 2 constructor chains distinct from Vue 3-only app methods', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import Vue from 'vue'
import Before from 'before-ui'
import After from 'after-ui'
Vue.mixin({}).use(Before)
Vue.provide('key', {}).use(After)
`)
    expect(result.vueConstructorPlugins).toEqual([{
      constructorImport: 'vue',
      plugins: [expect.objectContaining({ localName: 'Before' })]
    }])
  })

  test.each([
    "component('Child', {})",
    "component('Child')",
    "directive('focus', {})",
    "directive('focus')",
    "filter('identity', value => value)",
    "filter('identity')",
    'extend({})',
    'extend()',
    "set({}, 'value', {})",
    "delete({}, 'value')",
    'nextTick(() => {})',
    'nextTick()',
    'observable({})',
    "compile('<div />')"
  ])('preserves the Vue 2 base constructor but rejects static method result identity: %s', (call) => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import Vue from 'vue'
import App from './App.vue'
import ChildUi from 'child-ui'
import BaseUi from 'base-ui'
const Child = Vue.${call}
Child.use(ChildUi)
Vue.use(BaseUi)
new Vue({ render: h => h(App) })
`)
    expect(result.errors).toEqual([])
    expect(result.vueConstructorPlugins).toEqual([{
      constructorImport: 'vue',
      plugins: [expect.objectContaining({ localName: 'BaseUi' })]
    }])
    expect(result.applications).toEqual([expect.objectContaining({
      framework: 'vue2.7',
      rootComponentImport: './App.vue',
      plugins: [expect.objectContaining({ localName: 'BaseUi' })]
    })])
  })

  test.each([
    "Vue.component('Child', {}).use(ChildUi)",
    'Vue.extend({}).use(ChildUi)',
    "const Child = Vue.component('Child', {}); const alias = Child; alias.use(ChildUi)",
    "const Base = Vue; Base.filter('identity', value => value); Base.extend({})",
    "Vue['filter']('identity', value => value)"
  ])('separates Vue 2 subclass registrations from later base bootstrap evidence: %s', (statement) => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import Vue from 'vue'
import App from './App.vue'
import ChildUi from 'child-ui'
import BaseUi from 'base-ui'
${statement}
Vue.use(BaseUi)
new Vue({ render: h => h(App) })
`)
    expect(result.errors).toEqual([])
    expect(result.applications).toEqual([expect.objectContaining({
      rootComponentImport: './App.vue',
      plugins: [expect.objectContaining({ localName: 'BaseUi' })]
    })])
  })

  test('retains Vue 2 use and mixin return identity through constructor aliases', () => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import Vue from 'vue'
import Before from 'before-ui'
import After from 'after-ui'
const Base = Vue.use(Before).mixin({})
Base.use(After)
new Vue({})
`)
    expect(result.errors).toEqual([])
    expect(result.applications[0]?.plugins.map(plugin => plugin.localName)).toEqual(['Before', 'After'])
  })

  test.each([
    "Vue.set(Vue, 'use', replacement)",
    "Vue.delete(Vue, 'use')",
    'Vue.observable(Vue)',
    'Vue.unknown()'
  ])('does not preserve a Vue 2 constructor explicitly exposed to mutation: %s', (statement) => {
    const result = analyzeProjectModuleContext('/fixture/main.ts', `
import Vue from 'vue'
import Ui from 'fixture-ui'
${statement}
Vue.use(Ui)
new Vue({})
`)
    expect(result.errors).toEqual([])
    expect(result.vueConstructorPlugins).toEqual([])
    expect(result.applications).toEqual([])
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

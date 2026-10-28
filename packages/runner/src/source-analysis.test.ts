import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { scanDoctorSource } from './source-analysis.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createTemporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function createSourceFixture() {
  const root = await createTemporaryDirectory('vue-doctor-source-cache-')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    dependencies: { vue: '3.5.39' }
  }))
  await writeFile(join(root, 'src/App.vue'), `<script setup>
const open = true
</script><template><div /></template>`, 'utf8')
  return root
}

async function createDetailedCacheFixture() {
  const root = await createSourceFixture()
  await writeFile(join(root, 'src/App.vue'), `<script setup>
import { createApp, useId } from 'vue'
import ExampleUi, { ExampleButton } from 'example-ui'
const settings = { label: 'Ready', flags: [true, null, 1] }
let open = true
function onChange(value, ...rest) { consume(value, rest) }
createApp({}).use(ExampleUi)
const id = useId()
</script>
<template>
  <ExampleButton :settings="settings" @change.once="onChange" v-model.trim="open" v-demo:foo.bar="settings">
    <template #default><button type="button">Ready</button></template>
  </ExampleButton>
</template>`)
  return {
    root,
    vueVersion: '3.4.0',
    cacheDirectory: await createTemporaryDirectory('vue-doctor-detailed-cache-'),
    analysisProfiles: [{ includeNativeElements: true, resolveConstants: true }],
    parallel: false
  }
}

async function sourceCacheEntry(cacheDirectory: string) {
  const namespaces = await readdir(cacheDirectory)
  expect(namespaces).toHaveLength(1)
  const directory = join(cacheDirectory, namespaces[0]!)
  const entries = await readdir(directory)
  expect(entries).toHaveLength(1)
  return join(directory, entries[0]!)
}

function corruptField(cached: object, path: readonly (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value
  let parent = cached
  for (const key of path.slice(0, -1)) parent = Reflect.get(parent, key)
  Reflect.set(parent, path[path.length - 1]!, value)
  return cached
}

describe('Doctor source analysis', () => {
  test('reuses unchanged file analysis and invalidates changed content', async () => {
    const root = await createSourceFixture()
    const cacheDirectory = await createTemporaryDirectory('vue-doctor-source-cache-data-')

    const first = await scanDoctorSource({
      root,
      vueVersion: '3.5.39',
      cacheDirectory,
      parallel: false
    })
    const second = await scanDoctorSource({
      root,
      vueVersion: '3.5.39',
      cacheDirectory,
      parallel: false
    })
    await writeFile(join(root, 'src/App.vue'), '<template><button /></template>', 'utf8')
    const changed = await scanDoctorSource({
      root,
      vueVersion: '3.5.39',
      cacheDirectory,
      parallel: false
    })

    expect(first).toMatchObject({ cacheHits: 0, cacheMisses: 1, parallel: false })
    expect(second).toMatchObject({ cacheHits: 1, cacheMisses: 0, parallel: false })
    expect(second.source).toEqual(first.source)
    expect(changed).toMatchObject({ cacheHits: 0, cacheMisses: 1, parallel: false })
    expect(changed.source).not.toEqual(first.source)
  })

  test('keeps an explicit empty scope complete and reports invalid scopes separately', async () => {
    const root = await createSourceFixture()

    const empty = await scanDoctorSource({ root, scope: [], parallel: false })
    const missing = await scanDoctorSource({ root, scope: 'missing', parallel: false })

    expect(empty.source).toMatchObject({ files: [], discoveryIssues: [] })
    expect(missing.source.files).toEqual([])
    expect(missing.source.discoveryIssues).toEqual([
      expect.objectContaining({ kind: 'scope-not-found', path: join(root, 'missing') })
    ])
  })

  test('analyzes each target with its consuming Vue version and isolates versioned cache entries', async () => {
    const root = await createSourceFixture()
    const firstFile = join(root, 'src/App.vue')
    const secondFile = join(root, 'src/Other.vue')
    const cacheDirectory = await createTemporaryDirectory('vue-doctor-source-versions-')
    const text = '<script setup>import { useId } from "vue"; const id = useId()</script><template><div /></template>'
    await writeFile(firstFile, text)
    await writeFile(secondFile, text)
    const versions = { [firstFile]: '3.4.0', [secondFile]: '3.5.39' }

    const first = await scanDoctorSource({ root, vueVersion: '3.5.39', vueVersions: versions, cacheDirectory, parallel: false })
    const warm = await scanDoctorSource({ root, vueVersion: '3.5.39', vueVersions: versions, cacheDirectory, parallel: false })
    expect(first.diagnostics.filter(item => item.code === 'vue-api-version-unsupported').map(item => item.file)).toEqual([firstFile])
    expect(warm.diagnostics).toEqual(first.diagnostics)
    expect(warm).toMatchObject({ cacheHits: 2, cacheMisses: 0 })

    const upgraded = await scanDoctorSource({ root, vueVersion: '3.5.39', vueVersions: {
      [firstFile]: '3.5.39', [secondFile]: '3.5.39'
    }, cacheDirectory, parallel: false })
    expect(upgraded.diagnostics.filter(item => item.code === 'vue-api-version-unsupported')).toEqual([])
    expect(upgraded).toMatchObject({ cacheHits: 1, cacheMisses: 1 })
  })

  test('reuses complete component, plugin, profile, document and diagnostic facts from JSON cache', async () => {
    const options = await createDetailedCacheFixture()
    const first = await scanDoctorSource(options)
    const warm = await scanDoctorSource(options)

    expect(first.source.components[0]).toMatchObject({ componentName: 'ExampleButton' })
    expect(first.source.globalPlugins).toHaveLength(1)
    expect(first.sourceFacts[0]?.analysis.components[0]?.props[0]?.staticEvidence).toMatchObject({
      complete: true, properties: { flags: { elements: [{ value: true }, { value: null }, { value: 1 }] } }
    })
    expect(first.diagnostics).toContainEqual(expect.objectContaining({ code: 'vue-api-version-unsupported' }))
    expect(warm).toMatchObject({ cacheHits: 1, cacheMisses: 0 })
    expect(warm.source).toEqual(first.source)
    expect(warm.sourceFacts).toEqual(first.sourceFacts)
    expect(warm.preparedDocuments).toEqual(first.preparedDocuments)
    expect(warm.diagnostics).toEqual(first.diagnostics)
  })

  test.each([
    { name: 'empty object', path: [], value: {} },
    { name: 'null payload', path: [], value: null },
    { name: 'file identity', path: ['fileResult', 'file'], value: 'unrelated.vue' },
    { name: 'source blocks', path: ['fileResult', 'blocks'], value: null },
    { name: 'source block status', path: ['fileResult', 'blocks', 0, 'status'], value: 'complete' },
    { name: 'component list', path: ['components'], value: {} },
    { name: 'prop list', path: ['components', 0, 'props'], value: null },
    { name: 'prop kind', path: ['components', 0, 'props', 0, 'kind'], value: ['dynamic'] },
    { name: 'prop location', path: ['components', 0, 'props', 0, 'loc', 'line'], value: '1' },
    { name: 'event modifiers', path: ['components', 0, 'events', 0, 'modifiers'], value: [3] },
    { name: 'handler parameters', path: ['components', 0, 'events', 0, 'handler', 'parameters'], value: {} },
    { name: 'model modifiers', path: ['components', 0, 'models', 0, 'modifiers'], value: null },
    { name: 'slot location', path: ['components', 0, 'slots', 0, 'loc'], value: null },
    { name: 'directive modifiers', path: ['components', 0, 'directives', 0, 'modifiers'], value: [false] },
    { name: 'component origin', path: ['components', 0, 'origin', 'package', 'packageName'], value: 42 },
    { name: 'template binding provenance', path: ['components', 0, 'origin', 'templateBinding'], value: 'unverified' },
    { name: 'plugin package', path: ['globalPlugins', 0, 'package'], value: null },
    { name: 'prepared document', path: ['preparedDocument'], value: {} },
    { name: 'document attributes', path: ['preparedDocument', 'blocks', 0, 'attributes'], value: [] },
    { name: 'document offsets', path: ['preparedDocument', 'blocks', 0, 'start'], value: '0' },
    { name: 'document errors', path: ['preparedDocument', 'errors'], value: [{}] },
    { name: 'structural failures', path: ['preparedDocument', 'structuralFailures'], value: [{ block: 'style', message: 'Invalid block kind' }] },
    { name: 'source fact list', path: ['sourceFacts'], value: null },
    { name: 'profile options', path: ['sourceFacts', 0, 'options', 'resolveConstants'], value: 'yes' },
    { name: 'profile analysis', path: ['sourceFacts', 0, 'analysis', 'fileResult', 'blocks'], value: [null] },
    { name: 'nested static knowledge', path: ['sourceFacts', 0, 'analysis', 'components', 0, 'props', 0, 'staticEvidence', 'properties', 'flags', 'elements', 0, 'complete'], value: 'true' },
    { name: 'diagnostic evidence', path: ['diagnostics', 0, 'evidence'], value: [null] },
    { name: 'diagnostic fixes', path: ['diagnostics', 0, 'fixes'], value: [null] },
    { name: 'diagnostic severity', path: ['diagnostics', 0, 'severity'], value: ['warning'] }
  ])('reparses valid JSON cache corruption in $name before consumers see it', async ({ path, value }) => {
    const options = await createDetailedCacheFixture()
    const first = await scanDoctorSource(options)
    const entry = await sourceCacheEntry(options.cacheDirectory)
    const cached = JSON.parse(await readFile(entry, 'utf8'))
    await writeFile(entry, JSON.stringify(corruptField(cached, path, value)))

    const repaired = await scanDoctorSource(options)
    expect(repaired).toMatchObject({ cacheHits: 0, cacheMisses: 1 })
    expect(repaired.source).toEqual(first.source)
    expect(repaired.sourceFacts).toEqual(first.sourceFacts)
    expect(repaired.preparedDocuments).toEqual(first.preparedDocuments)
    expect(repaired.diagnostics).toEqual(first.diagnostics)
    const warm = await scanDoctorSource(options)
    expect(warm).toMatchObject({ cacheHits: 1, cacheMisses: 0 })
  })

  test('reparses invalid JSON cache entries without hiding source parse failures', async () => {
    const root = await createSourceFixture()
    await writeFile(join(root, 'src/App.vue'), '<script setup>const = broken</script><template><div /></template>')
    const cacheDirectory = await createTemporaryDirectory('vue-doctor-invalid-json-cache-')
    const options = { root, cacheDirectory, parallel: false }
    const first = await scanDoctorSource(options)
    await writeFile(await sourceCacheEntry(cacheDirectory), '{not valid JSON')

    const repaired = await scanDoctorSource(options)
    expect(repaired).toMatchObject({ cacheHits: 0, cacheMisses: 1 })
    expect(repaired.source).toEqual(first.source)
    expect(repaired.source.fileResults[0]?.blocks).toContainEqual(expect.objectContaining({ status: 'failed' }))
    const warm = await scanDoctorSource(options)
    expect(warm).toMatchObject({ cacheHits: 1, cacheMisses: 0 })
    expect(warm.source).toEqual(first.source)
  })

  test('continues source analysis with an ENOTDIR cache without hiding parse or read failures', async () => {
    const root = await createSourceFixture()
    const cacheDirectory = join(root, 'ordinary-file')
    const file = join(root, 'src/App.vue')
    await writeFile(cacheDirectory, 'not a directory')
    const options = { root, cacheDirectory, parallel: false }
    const valid = await scanDoctorSource(options)
    expect(valid).toMatchObject({ cacheHits: 0, cacheMisses: 1 })
    expect(valid.source.fileResults[0]?.blocks.some(block => block.status === 'failed')).toBe(false)

    await writeFile(file, '<script setup>const = broken</script><template><div /></template>')
    const invalid = await scanDoctorSource(options)
    expect(invalid.source.fileResults[0]?.blocks).toContainEqual(expect.objectContaining({
      kind: 'script-setup', status: 'failed', message: expect.any(String)
    }))

    await rm(file)
    const unreadable = await scanDoctorSource({
      ...options, targetFiles: { root, files: [file], issues: [] }
    })
    expect(unreadable.readFailures.has(file)).toBe(true)
    expect(unreadable.source.fileResults[0]?.blocks).toContainEqual(expect.objectContaining({
      status: 'failed', message: expect.stringContaining('ENOENT')
    }))
  })
})

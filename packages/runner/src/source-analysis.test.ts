import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { scanDoctorSource } from './source-analysis.js'

async function createSourceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-source-cache-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    dependencies: { vue: '3.5.39' }
  }))
  await writeFile(join(root, 'src/App.vue'), `<script setup>
const open = true
</script><template><div /></template>`, 'utf8')
  return root
}

describe('Doctor source analysis', () => {
  test('reuses unchanged file analysis and invalidates changed content', async () => {
    const root = await createSourceFixture()
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-source-cache-data-'))

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
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-source-versions-'))
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
})

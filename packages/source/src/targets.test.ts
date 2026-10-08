import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { discoverTargetFiles } from './targets.js'

describe('target files', () => {
  test('keeps scope and allowlist as independent intersections with auditable failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-targets-'))
    const selected = join(root, 'src/Selected.vue')
    const excluded = join(root, 'other/Excluded.vue')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'other'), { recursive: true })
    await writeFile(selected, '<template><main /></template>')
    await writeFile(excluded, '<template><aside /></template>')

    const targets = await discoverTargetFiles({
      root,
      scope: 'src',
      files: [selected, excluded, 'src/missing.vue']
    })

    expect(targets).toMatchObject({
      root,
      scope: 'src',
      requestedFiles: [selected, excluded, 'src/missing.vue'],
      files: [selected]
    })
    expect(targets.issues).toEqual([
      expect.objectContaining({ kind: 'scope-not-found', path: join(root, 'src/missing.vue') })
    ])
  })

  test('distinguishes an explicit empty target set from an invalid scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-targets-empty-'))
    await writeFile(join(root, 'package.json'), '{}')

    await expect(discoverTargetFiles({ root, files: [] })).resolves.toMatchObject({
      files: [],
      issues: []
    })
    await expect(discoverTargetFiles({ root, scope: 'missing', files: [] })).resolves.toMatchObject({
      files: [],
      issues: [expect.objectContaining({ kind: 'scope-not-found' })]
    })
  })
})

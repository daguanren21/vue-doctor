import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { discoverSourceFiles, listSourceFiles } from './files.js'

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-discovery-'))
  await mkdir(join(root, 'src', 'nested'), { recursive: true })
  await writeFile(join(root, 'src', 'App.vue'), '<template><div /></template>')
  await writeFile(join(root, 'src', 'nested', 'feature.ts'), 'export const feature = true')
  return root
}

describe('source discovery', () => {
  test('accepts an in-project directory whose name begins with two dots', async () => {
    const root = await createProject()
    await mkdir(join(root, '..components'))
    const file = join(root, '..components', 'Example.vue')
    await writeFile(file, '<template><div /></template>')
    await expect(discoverSourceFiles(root, '..components')).resolves.toEqual({ files: [file], issues: [] })
  })
  test('keeps the listSourceFiles compatibility wrapper deterministic', async () => {
    const root = await createProject()

    expect(await listSourceFiles(root)).toEqual([
      join(root, 'src', 'App.vue'),
      join(root, 'src', 'nested', 'feature.ts')
    ])
  })

  test('filters discovered files by exact relative and absolute allowlist entries', async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), 'vue-doctor-allowlist-outside-'))
    const outsideFile = join(outside, 'outside.ts')
    const linkedFile = join(root, 'src', 'linked.ts')
    await writeFile(outsideFile, 'export const outside = true')
    await symlink(outsideFile, linkedFile)
    const discovery = await discoverSourceFiles(root, undefined, [], [
      'src/App.vue',
      join(root, 'src', 'nested', 'feature.ts'),
      'src',
      'src/missing.ts',
      linkedFile,
      outsideFile
    ])

    expect(discovery.files).toEqual([
      join(root, 'src', 'App.vue'),
      join(root, 'src', 'nested', 'feature.ts')
    ])
    expect(discovery.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'scope-unreadable', path: join(root, 'src') }),
      expect.objectContaining({ kind: 'scope-not-found', path: join(root, 'src', 'missing.ts') }),
      expect.objectContaining({ kind: 'scope-outside-root', path: linkedFile }),
      expect.objectContaining({ kind: 'scope-outside-root', path: outsideFile })
    ]))
    await expect(discoverSourceFiles(root, undefined, [], [])).resolves.toEqual({ files: [], issues: [] })
  })

  test('keeps multi-scope discovery and the file allowlist as independent intersections', async () => {
    const root = await createProject()
    await mkdir(join(root, 'tests'))
    const testFile = join(root, 'tests', 'feature.ts')
    await writeFile(testFile, 'export const tested = true')

    const discovery = await discoverSourceFiles(root, ['src', 'tests'], [], [
      'src/nested/feature.ts',
      testFile
    ])
    expect(discovery).toEqual({ files: [
      join(root, 'src', 'nested', 'feature.ts'),
      testFile
    ], issues: [] })

    await expect(discoverSourceFiles(root, [], [], [testFile])).resolves.toEqual({ files: [], issues: [] })
  })

  test('distinguishes a valid empty target set from invalid scopes', async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), 'vue-doctor-outside-'))

    await expect(discoverSourceFiles(root, [])).resolves.toEqual({ files: [], issues: [] })
    await expect(discoverSourceFiles(root, 'missing', [], [])).resolves.toEqual({
      files: [],
      issues: [expect.objectContaining({ kind: 'scope-not-found', path: join(root, 'missing') })]
    })

    const result = await discoverSourceFiles(root, [
      'missing',
      join(outside, 'outside.vue'),
      'node_modules'
    ])
    expect(result.files).toEqual([])
    expect(result.issues.map((issue) => issue.kind)).toEqual([
      'scope-not-found',
      'scope-ignored',
      'scope-outside-root'
    ])
  })

  test('validates scope readability even when the file allowlist is empty', async () => {
    const root = await createProject()
    const locked = join(root, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o000)
    try {
      const result = await discoverSourceFiles(root, 'locked', [], [])
      expect(result.files).toEqual([])
      expect(result.issues).toEqual([
        expect.objectContaining({ kind: 'scope-unreadable', path: locked })
      ])
    } finally {
      await chmod(locked, 0o700)
    }
  })

  test('rejects a scoped symlink escape and reports it', async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), 'vue-doctor-symlink-outside-'))
    await writeFile(join(outside, 'Outside.vue'), '<template><div /></template>')
    await symlink(outside, join(root, 'escape'))

    const result = await discoverSourceFiles(root, 'escape')
    expect(result.files).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: 'scope-outside-root', path: join(root, 'escape') })
    ])
  })
})

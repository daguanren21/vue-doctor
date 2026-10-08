import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { intersectChangedFilesWithScope, resolveChangedFiles } from './changed-files.js'

async function createGitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-changed-'))
  run(root, ['git', 'init'])
  run(root, ['git', 'config', 'user.email', 'vue-doctor@example.com'])
  run(root, ['git', 'config', 'user.name', 'Vue Doctor'])
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n', 'utf8')
  await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8')
  run(root, ['git', 'add', '.'])
  run(root, ['git', 'commit', '-m', 'init'])
  return root
}

function run(cwd: string, args: string[]) {
  const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || args.join(' '))
  }
  return result.stdout.trim()
}

describe('resolveChangedFiles', () => {
  test('preserves changed files inside directories beginning with two dots', async () => {
    const root = await createGitRepo()
    await mkdir(join(root, '..components'))
    const file = join(root, '..components', 'Example.vue')
    await writeFile(file, '<template><div /></template>')
    expect(resolveChangedFiles({ root, base: 'HEAD' }).files).toEqual([file])
    expect(intersectChangedFilesWithScope(root, [file], '..components')).toEqual([file])
  })
  test('returns working-tree changes for base=HEAD', async () => {
    const root = await createGitRepo()
    await writeFile(join(root, 'src/New.vue'), '<template><span /></template>\n', 'utf8')
    await writeFile(join(root, 'src/App.vue'), '<template><main /></template>\n', 'utf8')

    const result = resolveChangedFiles({ root, base: 'HEAD' })
    expect(result.mode).toBe('working-tree')
    expect(result.files.map((file) => file.replace(root + '/', ''))).toEqual([
      'src/App.vue',
      'src/New.vue'
    ])
  })

  test('parses NUL-delimited unicode, spaces, newlines and renames', async () => {
    const root = await createGitRepo()
    await writeFile(join(root, 'src', '中文 空格.vue'), '<template><span /></template>\n')
    await writeFile(join(root, 'src', 'line\nbreak.vue'), '<template><span /></template>\n')
    await rename(join(root, 'src/App.vue'), join(root, 'src', '重命名 App.vue'))
    run(root, ['git', 'add', '-A'])

    const result = resolveChangedFiles({ root, base: 'HEAD' })

    expect(result.files).toEqual([
      join(root, 'src', 'line\nbreak.vue'),
      join(root, 'src', '中文 空格.vue'),
      join(root, 'src', '重命名 App.vue')
    ].sort())
  })

  test('maps repository changes into a nested consuming project without crossing its root', async () => {
    const repositoryRoot = await createGitRepo()
    const projectRoot = join(repositoryRoot, 'packages/app')
    await mkdir(join(projectRoot, 'src'), { recursive: true })
    await writeFile(join(projectRoot, 'src/App.vue'), '<template><div /></template>\n')
    run(repositoryRoot, ['git', 'add', '.'])
    run(repositoryRoot, ['git', 'commit', '-m', 'add app'])
    await writeFile(join(projectRoot, 'src/App.vue'), '<template><main /></template>\n')
    await writeFile(join(repositoryRoot, 'src/App.vue'), '<template><aside /></template>\n')

    const result = resolveChangedFiles({ root: projectRoot, base: 'HEAD' })

    expect(result.repositoryRoot).toBe(repositoryRoot)
    expect(result.files).toEqual([join(projectRoot, 'src/App.vue')])
  })

  test('uses an explicit merge-base range for committed changes', async () => {
    const root = await createGitRepo()
    const base = run(root, ['git', 'rev-parse', 'HEAD'])
    await rename(join(root, 'src/App.vue'), join(root, 'src', 'Renamed.vue'))
    run(root, ['git', 'add', '-A'])
    run(root, ['git', 'commit', '-m', 'rename'])

    const result = resolveChangedFiles({ root, base: `${base}...HEAD` })

    expect(result.mode).toBe('diff')
    expect(result.base).toBe(`${base}...HEAD`)
    expect(result.files).toEqual([join(root, 'src', 'Renamed.vue')])
  })

  test('intersects changed files with a valid scope and preserves invalid scope evidence', async () => {
    const root = await createGitRepo()
    await mkdir(join(root, 'src/nested'))
    const nested = join(root, 'src/nested/App.vue')
    await writeFile(nested, '<template><div /></template>')

    expect(intersectChangedFilesWithScope(root, [join(root, 'src/App.vue'), nested], 'src/nested'))
      .toEqual([nested])
    expect(intersectChangedFilesWithScope(root, [nested], 'missing')).toEqual(['missing'])
    expect(intersectChangedFilesWithScope(root, [nested], '../outside')).toEqual(['../outside'])
  })
})

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { collectArtifacts } from './artifacts.js'

async function createPackageRoot() {
  return mkdtemp(join(tmpdir(), 'vue-doctor-public-entries-'))
}

async function writeFixture(root: string, relativePath: string, source = 'export {}\n') {
  const path = join(root, relativePath)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, source, 'utf8')
}

describe('public package artifact resolution', () => {
  test('uses the package types field when exports does not declare a root entry', async () => {
    const packageRoot = await createPackageRoot()
    await writeFixture(packageRoot, 'dist/index.d.ts')

    const artifacts = await collectArtifacts(packageRoot, {
      name: 'example-ui',
      types: './dist/index.d.ts',
      exports: {
        './feature': {
          types: './dist/feature.d.ts'
        }
      }
    })

    expect(artifacts.declarationEntries.map((artifact) => artifact.relativePath)).toEqual([
      'dist/index.d.ts'
    ])
  })

  test('resolves only root and exact observed public entries', async () => {
    const packageRoot = await createPackageRoot()
    await writeFixture(packageRoot, 'dist/index.d.ts')
    await writeFixture(packageRoot, 'dist/index.mjs')
    await writeFixture(packageRoot, 'dist/index.cjs')
    await writeFixture(packageRoot, 'dist/calendar.d.ts')
    await writeFixture(packageRoot, 'dist/components/dialog.d.ts')
    await writeFixture(packageRoot, 'dist/components/unobserved.d.ts')

    const artifacts = await collectArtifacts(
      packageRoot,
      {
        name: 'example-ui',
        exports: {
          '.': [
            {
              types: './dist/index.d.ts',
              import: './dist/index.mjs',
              require: './dist/index.cjs'
            }
          ],
          './calendar': {
            types: './dist/calendar.d.ts'
          },
          './components/*': {
            types: './dist/components/*.d.ts'
          }
        }
      },
      ['./calendar', './components/dialog', './components/dialog']
    )

    expect(artifacts.declarationEntries.map((artifact) => artifact.relativePath)).toEqual([
      'dist/index.d.ts',
      'dist/calendar.d.ts',
      'dist/components/dialog.d.ts'
    ])
    expect(artifacts.declarationEntries.some((artifact) => artifact.relativePath.includes('*'))).toBe(false)
    expect(artifacts.declarationEntries.some((artifact) => artifact.relativePath.includes('unobserved'))).toBe(false)
    expect(artifacts.runtimeEntries.map((artifact) => artifact.relativePath)).toEqual([
      'dist/index.mjs',
      'dist/index.cjs'
    ])
    expect(artifacts.issues).toEqual([])
  })

  test('does not replace an explicit unreadable root declaration with the types field', async () => {
    const packageRoot = await createPackageRoot()
    await writeFixture(packageRoot, 'dist/fallback.d.ts')

    const artifacts = await collectArtifacts(packageRoot, {
      name: 'example-ui',
      types: './dist/fallback.d.ts',
      exports: {
        '.': {
          types: './dist/missing.d.ts'
        }
      }
    })

    expect(artifacts.declarationEntries).toEqual([])
  })

  test('uses package types when the root export only exposes runtime code', async () => {
    const packageRoot = await createPackageRoot()
    await writeFixture(packageRoot, 'dist/index.mjs')
    await writeFixture(packageRoot, 'dist/index.d.ts')

    const artifacts = await collectArtifacts(packageRoot, {
      name: 'example-ui',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          import: './dist/index.mjs'
        }
      }
    })

    expect(artifacts.declarationEntries.map((artifact) => artifact.relativePath)).toEqual([
      'dist/index.d.ts'
    ])
    expect(artifacts.runtimeEntries.map((artifact) => artifact.relativePath)).toEqual([
      'dist/index.mjs'
    ])
  })

  test('continues from import to require when discovering an adjacent declaration', async () => {
    const packageRoot = await createPackageRoot()
    await writeFixture(packageRoot, 'dist/index.mjs')
    await writeFixture(packageRoot, 'dist/index.cjs')
    await writeFixture(packageRoot, 'dist/index.d.cts')
    await writeFixture(packageRoot, 'dist/fallback.js')
    await writeFixture(packageRoot, 'dist/fallback.d.ts')

    const artifacts = await collectArtifacts(packageRoot, {
      name: 'example-ui',
      exports: {
        '.': {
          default: './dist/fallback.js',
          require: './dist/index.cjs',
          import: './dist/index.mjs'
        }
      }
    })

    expect(artifacts.declarationEntries.map((artifact) => artifact.relativePath)).toEqual([
      'dist/index.d.cts'
    ])
    expect(artifacts.runtimeEntries.map((artifact) => artifact.relativePath)).toEqual([
      'dist/index.mjs',
      'dist/index.cjs'
    ])
  })

  test('records issues instead of accepting missing, escaped, or literal wildcard targets', async () => {
    const packageRoot = await createPackageRoot()
    await writeFixture(join(packageRoot, '..'), 'outside.d.ts')

    const artifacts = await collectArtifacts(
      packageRoot,
      {
        name: 'example-ui',
        exports: {
          './missing/*': {
            types: './dist/missing/*.d.ts'
          },
          './escape': {
            types: '../outside.d.ts'
          },
          './unobserved/*': {
            types: './dist/unobserved/*.d.ts'
          }
        }
      },
      ['./missing/button', './escape']
    )

    expect(artifacts.declarationEntries).toEqual([])
    expect(artifacts.runtimeEntries).toEqual([])
    expect(artifacts.issues).toEqual([
      expect.objectContaining({ code: 'public-entry-unresolved', entry: './missing/button' }),
      expect.objectContaining({ code: 'public-entry-unresolved', entry: './escape' })
    ])
    expect(artifacts.issues.some((issue) => issue.entry.includes('*'))).toBe(false)
  })
})

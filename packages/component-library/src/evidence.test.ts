import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { createComponentLibraryEvidence, findPackageTextEvidence } from './index.js'

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-component-library-'))
  const packageRoot = join(root, 'node_modules/example-ui')

  await writeJson(join(root, 'package.json'), {
    name: 'fixture-app',
    dependencies: {
      'example-ui': '1.2.0'
    }
  })

  await mkdir(join(packageRoot, 'es/components/date-picker'), { recursive: true })
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await writeJson(join(packageRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    types: './es/index.d.ts',
    module: './es/index.mjs',
    main: './lib/index.cjs',
    'web-types': './web-types.json',
    vetur: {
      tags: './tags.json',
      attributes: './attributes.json'
    },
    exports: {
      '.': {
        types: './es/index.d.ts',
        import: './es/index.mjs'
      },
      './date-picker': {
        types: './es/components/date-picker/index.d.ts',
        import: './es/components/date-picker/index.mjs'
      }
    }
  })
  await writeFile(join(packageRoot, 'es/index.d.ts'), 'export {}\n', 'utf8')
  await writeFile(join(packageRoot, 'es/index.mjs'), 'export {}\n', 'utf8')
  await writeFile(join(packageRoot, 'lib/index.cjs'), 'module.exports = {}\n', 'utf8')
  await writeFile(join(packageRoot, 'web-types.json'), '{}\n', 'utf8')
  await writeFile(join(packageRoot, 'tags.json'), '{}\n', 'utf8')
  await writeFile(join(packageRoot, 'attributes.json'), '{}\n', 'utf8')
  await writeFile(
    join(packageRoot, 'es/components/date-picker/index.d.ts'),
    'export declare const ExampleDatePicker: unknown\n',
    'utf8'
  )
  await writeFile(
    join(packageRoot, 'es/components/date-picker/index.mjs'),
    'const visible = true\nemit("visible-change", "start", visible)\n',
    'utf8'
  )

  return {
    root,
    packageRoot,
    package: {
      dependencyName: 'example-ui',
      canonicalName: 'example-ui',
      declaredVersion: '1.2.0',
      installedVersion: '1.2.3',
      packageJsonPath: join(packageRoot, 'package.json'),
      packageRoot,
      importRoots: ['example-ui'],
      source: 'installed' as const
    }
  }
}

describe('component-library evidence', () => {
  test('collects installed package metadata and published artifact paths', async () => {
    const fixture = await createProject()

    const evidence = await createComponentLibraryEvidence({
      package: fixture.package,
      observedSubpaths: ['./date-picker']
    })

    expect(evidence.package).toBe(fixture.package)
    expect(evidence.artifacts.types?.relativePath).toBe('es/index.d.ts')
    expect(evidence.artifacts.declarationEntries.map((entry) => entry.relativePath)).toEqual([
      'es/index.d.ts',
      'es/components/date-picker/index.d.ts'
    ])
    expect(evidence.artifacts.webTypes?.relativePath).toBe('web-types.json')
    expect(evidence.artifacts.veturTags?.relativePath).toBe('tags.json')
    expect(evidence.artifacts.veturAttributes?.relativePath).toBe('attributes.json')
    expect(evidence.artifacts.runtimeEntries.map((entry) => entry.relativePath)).toEqual([
      'es/index.mjs',
      'es/components/date-picker/index.mjs'
    ])
  })

  test('returns declared evidence when a package is not installed', async () => {
    const packageResolution = {
      dependencyName: 'missing-ui',
      canonicalName: 'missing-ui',
      declaredVersion: '^4.0.0',
      importRoots: ['missing-ui'],
      source: 'declared' as const
    }

    const evidence = await createComponentLibraryEvidence({ package: packageResolution })

    expect(evidence.package).toBe(packageResolution)
    expect(evidence.artifacts.declarationEntries).toEqual([])
    expect(evidence.artifacts.runtimeEntries).toEqual([])
    expect(evidence.artifacts.issues).toEqual([])
  })

  test('orders the root export declaration before subpath declarations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-component-library-exports-'))
    const packageRoot = join(root, 'node_modules/example-ui')
    await writeJson(join(root, 'package.json'), {
      dependencies: {
        'example-ui': '1.2.0'
      }
    })
    await mkdir(join(packageRoot, 'es/feature'), { recursive: true })
    await writeJson(join(packageRoot, 'package.json'), {
      name: 'example-ui',
      version: '1.2.3',
      exports: {
        './feature': {
          types: './es/feature/index.d.ts'
        },
        '.': {
          types: './es/index.d.ts'
        }
      }
    })
    await writeFile(join(packageRoot, 'es/feature/index.d.ts'), 'export declare const feature: unknown\n', 'utf8')
    await writeFile(join(packageRoot, 'es/index.d.ts'), 'export {}\n', 'utf8')

    const evidence = await createComponentLibraryEvidence({
      package: {
        dependencyName: 'example-ui',
        canonicalName: 'example-ui',
        declaredVersion: '1.2.0',
        installedVersion: '1.2.3',
        packageJsonPath: join(packageRoot, 'package.json'),
        packageRoot,
        importRoots: ['example-ui'],
        source: 'installed'
      },
      observedSubpaths: ['./feature']
    })

    expect(evidence.artifacts.declarationEntries.map((entry) => entry.relativePath)).toEqual([
      'es/index.d.ts',
      'es/feature/index.d.ts'
    ])
  })

  test('finds text evidence in installed package artifacts with line numbers', async () => {
    const fixture = await createProject()

    const matches = await findPackageTextEvidence({
      package: fixture.package,
      query: 'visible-change'
    })

    expect(matches).toEqual([
      expect.objectContaining({
        kind: 'package-text-match',
        line: 2,
        relativePath: 'es/components/date-picker/index.mjs'
      })
    ])
  })
})

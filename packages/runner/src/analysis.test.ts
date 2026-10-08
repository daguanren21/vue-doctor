import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComponentLibraryEvidence } from '@vue-doctor/component-library'
import type { PackageResolution, ProjectContext } from '@vue-doctor/core'
import type { VueComponentUsage, VueSourceUsageReport } from '@vue-doctor/source'
import { afterEach, describe, expect, test } from 'vitest'
import { analyzeComponentLibraries } from './analysis.js'

const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function packageIdentity(
  dependencyName: string,
  canonicalName = dependencyName,
  importRoots = [dependencyName, canonicalName]
): PackageResolution {
  return {
    dependencyName,
    canonicalName,
    installedVersion: '1.2.3',
    packageRoot: `/project/node_modules/${canonicalName}`,
    packageJsonPath: `/project/node_modules/${canonicalName}/package.json`,
    importRoots: [...new Set(importRoots)],
    source: 'installed'
  }
}

async function componentLibrary(
  packageIdentityValue: PackageResolution,
  components: Array<{ name: string; attributes?: Array<{ name: string }>; events?: Array<{ name: string }>; slots?: Array<{ name: string }> }>
): Promise<ComponentLibraryEvidence> {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-analysis-'))
  const metadataPath = join(root, 'web-types.json')
  fixtureRoots.push(root)

  await writeFile(metadataPath, JSON.stringify({
    contributions: {
      html: {
        elements: components.map((component) => (
          component.attributes || component.events || component.slots
            ? component
            : { ...component, events: [] }
        ))
      }
    }
  }), 'utf8')

  return {
    package: packageIdentityValue,
    artifacts: {
      declarationEntries: [],
      webTypes: {
        path: metadataPath,
        relativePath: 'web-types.json',
        source: 'package-json'
      },
      runtimeEntries: [],
      issues: []
    }
  }
}

function unavailableLibrary(packageIdentityValue: PackageResolution): ComponentLibraryEvidence {
  return {
    package: packageIdentityValue,
    artifacts: { declarationEntries: [], runtimeEntries: [], issues: [] }
  }
}

function usage(
  componentName: string,
  origin?: VueComponentUsage['origin'],
  overrides: Partial<VueComponentUsage> = {}
): VueComponentUsage {
  return {
    file: '/project/src/App.vue',
    tag: componentName,
    componentName,
    loc: { line: 1, column: 1 },
    props: [],
    propSpreads: [],
    events: [],
    models: [],
    slots: [],
    directives: [],
    origin,
    ...overrides
  }
}

function source(
  components: VueComponentUsage[],
  overrides: Partial<VueSourceUsageReport> = {}
): VueSourceUsageReport {
  return {
    root: '/project',
    files: ['/project/src/App.vue'],
    components,
    globalPlugins: [],
    fileResults: [{
      file: '/project/src/App.vue',
      blocks: [
        { kind: 'template', status: 'available' },
        { kind: 'script', status: 'absent' },
        { kind: 'script-setup', status: 'absent' }
      ]
    }],
    ...overrides
  }
}

describe('component library analysis', () => {
  test('ranks direct package roots before registered plugins and contract matches', async () => {
    const exampleUi = await componentLibrary(packageIdentity('@fixture/ui-alias', '@fixture/ui'), [{ name: 'SharedButton' }])
    const otherUi = await componentLibrary(packageIdentity('@fixture/other-ui'), [{ name: 'SharedButton' }])

    const result = await analyzeComponentLibraries({
      source: source([usage('SharedButton', {
        kind: 'direct-import',
        package: { specifier: '@fixture/ui-alias/button', packageName: '@fixture/ui-alias', subpath: 'button' },
        importedName: 'SharedButton'
      })], {
        globalPlugins: [{
          file: '/project/src/main.ts',
          package: { specifier: '@fixture/other-ui', packageName: '@fixture/other-ui' },
          localName: 'OtherUi'
        }]
      }),
      libraries: [otherUi, exampleUi]
    })

    expect(result.matches[0]?.library.package.canonicalName).toBe('@fixture/ui')
    expect(result.ownership[0]).toMatchObject({
      status: 'matched',
      evidence: 'direct-import',
      package: expect.objectContaining({ canonicalName: '@fixture/ui' })
    })
  })

  test('uses aliases and canonical package roots for direct imports', async () => {
    const library = await componentLibrary(packageIdentity('@fixture/ui-alias', '@fixture/ui'), [{ name: 'ExampleButton' }])
    const result = await analyzeComponentLibraries({
      source: source([usage('ExampleButton', {
        kind: 'direct-import',
        package: { specifier: '@fixture/ui-alias/button', packageName: '@fixture/ui-alias', subpath: 'button' },
        importedName: 'ExampleButton'
      })]),
      libraries: [library]
    })

    expect(result.matches).toHaveLength(1)
    expect(result.ownership[0]?.package?.importRoots).toEqual(['@fixture/ui-alias', '@fixture/ui'])
  })

  test('uses a registered plugin only to break a contract-name tie', async () => {
    const exampleUi = await componentLibrary(packageIdentity('@fixture/ui'), [{ name: 'SharedButton' }])
    const otherUi = await componentLibrary(packageIdentity('@fixture/other-ui'), [{ name: 'SharedButton' }])
    const result = await analyzeComponentLibraries({
      source: source([usage('SharedButton')], {
        globalPlugins: [{
          file: '/project/src/main.ts',
          package: { specifier: '@fixture/ui', packageName: '@fixture/ui' },
          localName: 'ExampleUi'
        }]
      }),
      libraries: [exampleUi, otherUi]
    })

    expect(result.matches[0]?.library.package.canonicalName).toBe('@fixture/ui')
    expect(result.ownership[0]?.evidence).toBe('registered-plugin')
  })

  test('uses only plugins registered on the component usage application', async () => {
    const firstUi = await componentLibrary(packageIdentity('@fixture/first-ui'), [{ name: 'SharedButton' }])
    const secondUi = await componentLibrary(packageIdentity('@fixture/second-ui'), [{ name: 'SharedButton' }])
    const result = await analyzeComponentLibraries({
      source: source([
        usage('SharedButton', undefined, { file: '/project/first/App.vue', applicationId: 'first' }),
        usage('SharedButton', undefined, { file: '/project/second/App.vue', applicationId: 'second' })
      ], {
        files: ['/project/first/App.vue', '/project/second/App.vue'],
        globalPlugins: [
          {
            file: '/project/first/main.ts',
            package: { specifier: '@fixture/first-ui', packageName: '@fixture/first-ui' },
            localName: 'FirstUi',
            applicationId: 'first'
          },
          {
            file: '/project/second/main.ts',
            package: { specifier: '@fixture/second-ui', packageName: '@fixture/second-ui' },
            localName: 'SecondUi',
            applicationId: 'second'
          }
        ]
      }),
      libraries: [firstUi, secondUi]
    })

    expect(result.matches.map((match) => match.library.package.canonicalName)).toEqual([
      '@fixture/first-ui',
      '@fixture/second-ui'
    ])
  })

  test('uses the target owning package to disambiguate direct imports without an application entry', async () => {
    const firstIdentity = {
      ...packageIdentity('ui-lib'),
      installedVersion: '1.0.0',
      packageRoot: '/project/apps/first/node_modules/ui-lib',
      packageJsonPath: '/project/apps/first/node_modules/ui-lib/package.json'
    }
    const secondIdentity = {
      ...packageIdentity('ui-lib'),
      installedVersion: '2.0.0',
      packageRoot: '/project/apps/second/node_modules/ui-lib',
      packageJsonPath: '/project/apps/second/node_modules/ui-lib/package.json'
    }
    const firstUi = await componentLibrary(firstIdentity, [{ name: 'SharedButton' }])
    const secondUi = await componentLibrary(secondIdentity, [{ name: 'SharedButton' }])
    const firstFile = '/project/apps/first/src/App.vue'
    const secondFile = '/project/apps/second/src/App.vue'
    const directOrigin: VueComponentUsage['origin'] = {
      kind: 'direct-import',
      package: { specifier: 'ui-lib', packageName: 'ui-lib' },
      importedName: 'SharedButton'
    }
    const projectContext: ProjectContext = {
      root: '/project',
      packages: [{
        root: '/project/apps/first',
        inventory: { root: '/project/apps/first', packages: { 'ui-lib': firstIdentity } },
        targetFiles: [firstFile]
      }, {
        root: '/project/apps/second',
        inventory: { root: '/project/apps/second', packages: { 'ui-lib': secondIdentity } },
        targetFiles: [secondFile]
      }],
      applications: [],
      files: [],
      issues: []
    }

    const result = await analyzeComponentLibraries({
      source: source([
        usage('SharedButton', directOrigin, { file: firstFile }),
        usage('SharedButton', directOrigin, { file: secondFile })
      ], { files: [firstFile, secondFile] }),
      libraries: [firstUi, secondUi],
      projectContext
    })

    expect(result.matches.map((match) => match.library.package.packageJsonPath)).toEqual([
      firstIdentity.packageJsonPath,
      secondIdentity.packageJsonPath
    ])
    expect(result.ownership.map((item) => item.status)).toEqual(['matched', 'matched'])
  })

  test('marks source coverage partial when project context is incomplete', async () => {
    const result = await analyzeComponentLibraries({
      source: source([]),
      libraries: [],
      contextIssues: [{
        code: 'entry-import-unresolved',
        file: '/project/src/main.ts',
        message: 'Alias is unresolved.'
      }]
    })

    expect(result.coverage).toMatchObject({
      status: 'partial',
      source: {
        status: 'partial',
        contextIssues: [expect.objectContaining({ code: 'entry-import-unresolved' })]
      }
    })
  })

  test('uses a unique contract match only without direct or plugin evidence', async () => {
    const exampleUi = await componentLibrary(packageIdentity('@fixture/ui'), [{ name: 'UniqueButton' }])
    const otherUi = await componentLibrary(packageIdentity('@fixture/other-ui'), [{ name: 'OtherButton' }])
    const result = await analyzeComponentLibraries({
      source: source([usage('UniqueButton')]),
      libraries: [exampleUi, otherUi]
    })

    expect(result.ownership[0]).toMatchObject({ status: 'matched', evidence: 'unique-contract' })
  })

  test('does not attribute a locally imported component to a matching library contract', async () => {
    const library = await componentLibrary(packageIdentity('@fixture/ui'), [{ name: 'TimePicker' }])
    const result = await analyzeComponentLibraries({
      source: source([usage('TimePicker', { kind: 'local-import' })]),
      libraries: [library]
    })

    expect(result.matches).toEqual([])
    expect(result.ownership).toEqual([{ status: 'unmatched', candidates: [] }])
    expect(result.coverage.componentLibraries).toEqual([])
  })

  test('keeps equal contract matches ambiguous instead of selecting an owner', async () => {
    const firstUi = await componentLibrary(packageIdentity('@fixture/first-ui'), [{ name: 'SharedButton' }])
    const secondUi = await componentLibrary(packageIdentity('@fixture/second-ui'), [{ name: 'SharedButton' }])
    const result = await analyzeComponentLibraries({
      source: source([usage('SharedButton')]),
      libraries: [firstUi, secondUi]
    })

    expect(result.matches).toEqual([])
    expect(result.ownership[0]).toMatchObject({
      status: 'ambiguous',
      candidates: [
        expect.objectContaining({ canonicalName: '@fixture/first-ui' }),
        expect.objectContaining({ canonicalName: '@fixture/second-ui' })
      ]
    })
  })

  test('keeps zero-use plugin libraries out of component coverage', async () => {
    const exampleUi = await componentLibrary(packageIdentity('@fixture/ui'), [{ name: 'UnusedButton' }])
    const result = await analyzeComponentLibraries({
      source: source([usage('LocalPanel')], {
        globalPlugins: [{
          file: '/project/src/main.ts',
          package: { specifier: '@fixture/ui', packageName: '@fixture/ui' },
          localName: 'ExampleUi'
        }]
      }),
      libraries: [exampleUi]
    })

    expect(result.coverage.componentLibraries).toEqual([])
  })

  test('derives block-specific source failures from fileResults once', async () => {
    const result = await analyzeComponentLibraries({
      source: source([], {
        files: ['/project/src/App.vue', '/project/src/Broken.vue'],
        fileResults: [{
          file: '/project/src/App.vue',
          blocks: [{ kind: 'template', status: 'available' }]
        }, {
          file: '/project/src/Broken.vue',
          blocks: [{ kind: 'template', status: 'failed', message: 'template parse failed' }]
        }]
      }),
      libraries: []
    })

    expect(result.coverage.source).toMatchObject({
      status: 'partial',
      failedFiles: [{ file: '/project/src/Broken.vue', block: 'template', message: 'template parse failed' }]
    })
  })

  test('blocked extraction is coverage only and records explicit ownership', async () => {
    const result = await analyzeComponentLibraries({
      source: source([usage('ExampleButton', {
        kind: 'direct-import',
        package: { specifier: '@fixture/ui', packageName: '@fixture/ui' },
        importedName: 'ExampleButton'
      })]),
      libraries: [unavailableLibrary(packageIdentity('@fixture/ui'))]
    })

    expect(result.coverage.componentLibraries).toEqual([
      expect.objectContaining({
        package: expect.objectContaining({ canonicalName: '@fixture/ui' }),
        status: 'blocked'
      })
    ])
    expect(result.matches).toHaveLength(0)
  })

  test('marks undeclared attributes partial when fallthrough is unknown', async () => {
    const library = await componentLibrary(packageIdentity('@fixture/ui'), [{
      name: 'ExampleLink',
      attributes: [{ name: 'href' }]
    }])
    const result = await analyzeComponentLibraries({
      source: source([usage('ExampleLink', {
        kind: 'direct-import',
        package: { specifier: '@fixture/ui', packageName: '@fixture/ui' },
        importedName: 'ExampleLink'
      }, {
        props: [{ name: 'target', kind: 'static', value: '_blank', loc: { line: 2, column: 3 } }]
      })]),
      libraries: [library]
    })

    expect(result.coverage.componentLibraries[0]).toMatchObject({
      status: 'partial',
      dimensions: { props: 'partial' }
    })
  })

  test('keeps declared props complete when fallthrough is unknown', async () => {
    const library = await componentLibrary(packageIdentity('@fixture/ui'), [{
      name: 'ExampleLink',
      attributes: [{ name: 'href' }]
    }])
    const result = await analyzeComponentLibraries({
      source: source([usage('ExampleLink', {
        kind: 'direct-import',
        package: { specifier: '@fixture/ui', packageName: '@fixture/ui' },
        importedName: 'ExampleLink'
      }, {
        props: [{ name: 'href', kind: 'static', value: '/docs', loc: { line: 2, column: 3 } }]
      })]),
      libraries: [library]
    })

    expect(result.coverage.componentLibraries[0]).toMatchObject({
      status: 'complete',
      dimensions: { props: 'known' }
    })
  })

  test.each([
    { version: '2.7.16', modifiers: ['native'], status: 'complete' },
    { version: '3.5.0', modifiers: ['native'], status: 'partial' },
    { version: undefined, modifiers: ['native'], status: 'partial' },
    { version: '2.7.16', modifiers: [], status: 'partial' }
  ])('keeps native listener coverage version-specific: $version $modifiers', async ({ version, modifiers, status }) => {
    const library = await componentLibrary(packageIdentity('@fixture/ui'), [{
      name: 'ExampleButton',
      attributes: [{ name: 'label' }]
    }])
    const result = await analyzeComponentLibraries({
      source: source([usage('ExampleButton', {
        kind: 'direct-import',
        package: { specifier: '@fixture/ui', packageName: '@fixture/ui' },
        importedName: 'ExampleButton'
      }, {
        events: [{ name: 'click', modifiers, loc: { line: 2, column: 3 } }]
      })]),
      libraries: [library],
      vueVersions: { '/project/src/App.vue': version }
    })

    expect(result.coverage.componentLibraries[0]).toMatchObject({
      status,
      dimensions: { events: 'unknown' }
    })
  })
})

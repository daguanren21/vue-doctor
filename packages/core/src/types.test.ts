import { describe, expect, expectTypeOf, test } from 'vitest'
import type {
  ComponentOwnership,
  DoctorReport,
  CoverageProblem,
  PackageResolution,
  SourceCoverageFailure
} from './index.js'

const packageIdentity: PackageResolution = {
  dependencyName: '@fixture/ui-alias',
  canonicalName: '@fixture/ui',
  declaredVersion: 'npm:@fixture/ui@1.2.3',
  installedVersion: '1.2.3',
  packageJsonPath: '/fixture/node_modules/@fixture/ui-alias/package.json',
  packageRoot: '/fixture/node_modules/@fixture/ui-alias',
  importRoots: ['@fixture/ui-alias', '@fixture/ui'],
  source: 'installed'
}

describe('Doctor report coverage contract', () => {
  test('uses one explicit package identity representation', () => {
    expect(packageIdentity.importRoots).toEqual(['@fixture/ui-alias', '@fixture/ui'])
    expectTypeOf(packageIdentity).toMatchTypeOf<PackageResolution>()
  })

  test('keeps coverage separate from diagnostics', () => {
    const problem: CoverageProblem = {
      code: 'component-library-contracts-unavailable',
      message: 'No usable component contracts were extracted.',
      evidence: []
    }

    const report = {
      project: { root: '/fixture', vueFramework: 'unknown', uiLibraries: [] },
      inventory: { root: '/fixture', packages: {} },
      coverage: {
        status: 'blocked',
        source: { status: 'complete', scannedFileCount: 1, failedFiles: [] },
        componentLibraries: [{
          package: packageIdentity,
          status: 'blocked',
          contractSources: [],
          detectedUsageCount: 1,
          matchedUsageCount: 0,
          dimensions: { props: 'unknown', events: 'unknown', models: 'unknown', slots: 'unknown' },
          problems: [problem]
        }]
      },
      diagnostics: []
    } satisfies DoctorReport

    expect(report.diagnostics).toEqual([])
    expectTypeOf(report.coverage.status).toEqualTypeOf<'blocked'>()
  })

  test('exposes ranked ownership and block-specific source coverage DTOs', () => {
    const ownership: ComponentOwnership = {
      status: 'ambiguous',
      candidates: [packageIdentity]
    }
    const failure: SourceCoverageFailure = {
      file: '/fixture/src/App.vue',
      block: 'template',
      message: 'template parse failed'
    }

    expect(ownership.status).toBe('ambiguous')
    expect(failure.block).toBe('template')
    expectTypeOf(ownership).toMatchTypeOf<ComponentOwnership>()
    expectTypeOf(failure).toMatchTypeOf<SourceCoverageFailure>()
  })
})

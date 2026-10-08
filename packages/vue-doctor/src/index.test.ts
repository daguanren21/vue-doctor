import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, expectTypeOf, test } from 'vitest'
import type {
  ComponentLibraryCoverage,
  ContractKnowledge,
  ContractSourceEvidence,
  CoverageProblem,
  CoverageProblemCode,
  CoverageStatus,
  DoctorCoverage,
  DoctorReport,
  SourceCoverage
} from './index.js'
import { getDiagnosticReference, listDiagnosticReferences, renderInspectorHtml, runDoctor, startInspectorServer } from './index.js'
import * as viteFacade from './vite.js'

describe('vue-doctor facade exports', () => {
  test('exposes the reusable Doctor Inspector renderer', () => {
    expect(typeof renderInspectorHtml).toBe('function')
    expect(renderInspectorHtml()).toContain('<title>Vue Doctor Inspector</title>')
  })

  test('exposes the local Inspector server with editor support', () => {
    expect(typeof startInspectorServer).toBe('function')
  })

  test('declares the supported Node runtime floor', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8'
    )) as { engines?: { node?: string } }

    expect(packageJson.engines?.node).toBe('>=20.19.0')
  })

  test('exposes the Diagnostic Reference catalog', () => {
    expect(listDiagnosticReferences()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'vue-security-restrict-v-html' }),
      expect.objectContaining({ code: 'vue-template-v-if-for' }),
      expect.objectContaining({ code: 'vue-template-v-for-key' }),
      expect.objectContaining({ code: 'vue-prop-mutated' }),
      expect.objectContaining({ code: 'vue-ref-as-operand' }),
      expect.objectContaining({ code: 'vue-setup-props-destructure' }),
      expect.objectContaining({ code: 'component-event-payload-changed' }),
      expect.objectContaining({ code: 'component-prop-unsupported' }),
      expect.objectContaining({ code: 'component-prop-required-missing' }),
      expect.objectContaining({ code: 'component-prop-type-mismatch' }),
      expect.objectContaining({ code: 'component-attribute-unverified' }),
      expect.objectContaining({ code: 'component-model-unsupported' }),
      expect.objectContaining({ code: 'component-slot-unsupported' }),
      expect.objectContaining({ code: 'component-event-unsupported' })
    ]))
    expect(getDiagnosticReference('component-event-unsupported')).toEqual(expect.objectContaining({
      title: 'Component event is unsupported'
    }))
  })

  test('exposes Doctor coverage contracts as facade types', () => {
    expectTypeOf<DoctorCoverage['status']>().toEqualTypeOf<CoverageStatus>()
    expectTypeOf<DoctorCoverage['source']>().toEqualTypeOf<SourceCoverage>()
    expectTypeOf<DoctorCoverage['componentLibraries']>().toEqualTypeOf<ComponentLibraryCoverage[]>()
    expectTypeOf<ComponentLibraryCoverage['dimensions']['props']>().toEqualTypeOf<ContractKnowledge>()
    expectTypeOf<ComponentLibraryCoverage['contractSources'][number]>().toEqualTypeOf<ContractSourceEvidence>()
    expectTypeOf<CoverageProblem['code']>().toEqualTypeOf<CoverageProblemCode>()
  })

  test('returns the shared Doctor report model from a zero-config run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-facade-'))

    try {
      const report = await runDoctor({ root })

      expect(report).toEqual(expect.objectContaining({
        project: expect.any(Object),
        inventory: expect.any(Object),
        coverage: expect.any(Object),
        diagnostics: expect.any(Array)
      }))
      expectTypeOf(report).toEqualTypeOf<DoctorReport>()
      expect(Object.keys(viteFacade)).toEqual(['vueDoctor'])
      expect(typeof viteFacade.vueDoctor).toBe('function')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

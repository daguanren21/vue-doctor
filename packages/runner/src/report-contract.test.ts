import { describe, expect, test } from 'vitest'
import { isSupportedDoctorReport } from '@vue-doctor/core'
import type { Diagnostic, DoctorReport } from '@vue-doctor/core'
import { extractDoctorSuppressions } from '@vue-doctor/source'
import { finalizeDoctorReport } from './report-contract.js'

function diagnostic(overrides: Partial<Diagnostic> & Pick<Diagnostic, 'code' | 'message'>): Diagnostic {
  return {
    severity: 'warning',
    evidence: [],
    fixes: [{ title: 'Review this finding.' }],
    confidence: 'high',
    ...overrides
  }
}

function report(root: string, diagnostics: Diagnostic[]): DoctorReport {
  return {
    project: { root, vueFramework: 'vue3', uiLibraries: [] },
    inventory: { root, packages: {} },
    coverage: {
      status: 'partial',
      source: { status: 'partial', scannedFileCount: 1, failedFiles: [] },
      componentLibraries: []
    },
    diagnostics,
    skippedChecks: [],
    checks: []
  }
}

describe('Doctor report v1 contract', () => {
  test('normalizes target facts, location precision and suggestion fixes', () => {
    const root = '/checkout/project'
    const result = finalizeDoctorReport(report(root, [
      diagnostic({ code: 'file', message: 'file', file: `${root}/src/File.vue` }),
      diagnostic({ code: 'line', message: 'line', file: `${root}/src/Line.vue`, evidence: [{ kind: 'source', file: `${root}/src/Line.vue`, line: 2 }] }),
      diagnostic({ code: 'point', message: 'point', file: `${root}/src/Point.vue`, evidence: [{ kind: 'source', file: `${root}/src/Point.vue`, line: 3, column: 1 }] }),
      diagnostic({ code: 'range', message: 'range', file: `${root}/src/Range.vue`, evidence: [{ kind: 'source', file: `${root}/src/Range.vue`, line: 4, column: 2, endLine: 4, endColumn: 8 }] })
    ]), {
      target: {
        root,
        scope: ['./src', 'src'],
        requestedFiles: ['./src/Range.vue', `${root}/src/Point.vue`],
        files: [`${root}/src/Point.vue`, `${root}/src/Range.vue`]
      },
      generation: 4
    })

    expect(result.schemaVersion).toBe(1)
    expect(result.run).toEqual({
      status: 'partial',
      generation: 4,
      target: {
        mode: 'files',
        scopes: ['src'],
        requestedFiles: ['src/Point.vue', 'src/Range.vue'],
        files: ['src/Point.vue', 'src/Range.vue']
      }
    })
    expect(Object.fromEntries(result.diagnostics.map((item) => [item.code, item.primaryLocation?.precision]))).toEqual({
      file: 'file',
      line: 'line',
      point: 'point',
      range: 'range'
    })
    expect(result.diagnostics.every((item) => item.fixes.every((fix) => fix.kind === 'suggestion'))).toBe(true)
    expect(result.diagnostics.every((item) => /^vd1:[a-f0-9]{32}$/.test(item.id ?? ''))).toBe(true)
    expect(isSupportedDoctorReport(result)).toBe(true)
  })

  test('keeps IDs stable across checkout, Git, severity, tags, fixes, evidence and diagnostic order', () => {
    const build = (root: string, reverse: boolean, changedPolicy: boolean) => {
      const first = diagnostic({
        code: 'stable-rule',
        message: `Stable finding in ${root}/src/App.vue`,
        file: `${root}/src/App.vue`,
        severity: changedPolicy ? 'error' : 'warning',
        tags: changedPolicy ? ['policy-b'] : ['policy-a'],
        fixes: [{ title: changedPolicy ? 'New suggestion' : 'Old suggestion' }],
        evidence: changedPolicy
          ? [
              { kind: 'primary', file: `${root}/src/App.vue`, line: 2, message: `At ${root}/src/App.vue` },
              { kind: 'secondary', file: `${root}/src/App.vue`, line: 3, git: { commit: 'b', authorName: 'Dev' } }
            ]
          : [
              { kind: 'secondary', file: `${root}/src/App.vue`, line: 3, git: { commit: 'a', authorName: 'Dev' } },
              { kind: 'primary', file: `${root}/src/App.vue`, line: 2, message: `At ${root}/src/App.vue` }
            ]
      })
      const second = diagnostic({ code: 'other-rule', message: 'Other finding', file: `${root}/src/Other.vue` })
      return finalizeDoctorReport(report(root, reverse ? [second, first] : [first, second]), {
        target: { root, files: [`${root}/src/App.vue`, `${root}/src/Other.vue`] }
      })
    }

    const left = build('/tmp/checkout-a', false, false)
    const right = build('/var/work/checkout-b', true, true)
    expect(Object.fromEntries(left.diagnostics.map((item) => [item.code, item.id]))).toEqual(
      Object.fromEntries(right.diagnostics.map((item) => [item.code, item.id]))
    )
  })

  test('collapses only exact duplicate findings deterministically', () => {
    const root = '/project'
    const duplicate = diagnostic({
      code: 'duplicate-rule',
      message: 'Duplicate',
      file: `${root}/src/App.vue`,
      evidence: [{ kind: 'source', file: `${root}/src/App.vue`, line: 1 }]
    })
    const result = finalizeDoctorReport(report(root, [duplicate, { ...duplicate }, { ...duplicate, severity: 'error' }]), {
      target: { root, files: [`${root}/src/App.vue`] }
    })

    expect(result.diagnostics).toHaveLength(2)
    expect(new Set(result.diagnostics.map((item) => item.id))).toHaveLength(1)
  })

  test('keeps one-based HTML and style evidence precise for external rule packs', () => {
    const root = '/project'
    const result = finalizeDoctorReport(report(root, [
      diagnostic({
        code: 'custom-html-rule',
        message: 'HTML finding',
        evidence: [{ kind: 'custom-html', file: `${root}/index.html`, line: 1, column: 1 }]
      }),
      diagnostic({
        code: 'custom-style-rule',
        message: 'Style finding',
        evidence: [{ kind: 'custom-style', file: `${root}/src/theme.css`, line: 2, column: 1, endLine: 2, endColumn: 5 }]
      })
    ]), {
      target: { root, files: [`${root}/index.html`, `${root}/src/theme.css`] }
    })

    expect(result.diagnostics.find((item) => item.code === 'custom-html-rule')?.primaryLocation).toEqual({
      file: 'index.html',
      start: { line: 1, column: 1 },
      precision: 'point'
    })
    expect(result.diagnostics.find((item) => item.code === 'custom-style-rule')?.primaryLocation).toEqual({
      file: 'src/theme.css',
      start: { line: 2, column: 1 },
      end: { line: 2, column: 5 },
      precision: 'range'
    })
  })

  test('never grafts evidence coordinates onto an explicit file-only location', () => {
    const root = '/project'
    const result = finalizeDoctorReport(report(root, [diagnostic({
      code: 'explicit-file-rule',
      message: 'Config finding',
      primaryLocation: { file: `${root}/vite.config.ts`, precision: 'file' },
      evidence: [{ kind: 'source', file: `${root}/src/App.vue`, line: 8, column: 3 }]
    })]), {
      target: { root, files: [`${root}/vite.config.ts`, `${root}/src/App.vue`] }
    })

    expect(result.diagnostics[0]?.primaryLocation).toEqual({
      file: 'vite.config.ts',
      precision: 'file'
    })
  })

  test('does not graft coordinates from a different evidence file onto diagnostic.file', () => {
    const root = '/project'
    const result = finalizeDoctorReport(report(root, [diagnostic({
      code: 'diagnostic-file-rule',
      message: 'Config finding',
      file: `${root}/vite.config.ts`,
      evidence: [{ kind: 'related-source', file: `${root}/src/App.vue`, line: 8, column: 3 }]
    })]), {
      target: { root, files: [`${root}/vite.config.ts`, `${root}/src/App.vue`] }
    })

    expect(result.diagnostics[0]?.primaryLocation).toEqual({
      file: 'vite.config.ts',
      precision: 'file'
    })
  })

  test('applies suppression after IDs and preserves pre-suppression execution facts', () => {
    const root = '/project'
    const scans = [extractDoctorSuppressions(`${root}/src/App.ts`, [
      '// vue-doctor-disable-next-line known-rule -- reviewed false positive',
      'runRiskyCode()'
    ].join('\n'))]
    const input = report(root, [diagnostic({
      code: 'known-rule',
      message: 'Finding',
      file: `${root}/src/App.ts`,
      evidence: [{ kind: 'source', file: `${root}/src/App.ts`, line: 2, column: 1 }]
    })])
    input.domainCoverage = [{
      domain: 'unclassified',
      status: 'complete',
      ruleCount: 1,
      diagnosticCount: 1,
      pendingCheckCount: 0,
      unavailableCheckCount: 0,
      unreportedCheckCount: 0,
      inactiveRuleCount: 0
    }]
    const originalCoverage = input.coverage
    const originalChecks = input.checks
    const originalSkips = input.skippedChecks

    const result = finalizeDoctorReport(input, {
      target: { root, files: [`${root}/src/App.ts`] },
      suppression: { scans, registeredRuleCodes: new Set(['known-rule']) }
    })

    expect(result.diagnostics).toEqual([])
    expect(result.suppressionAudit).toEqual([
      expect.objectContaining({
        status: 'applied',
        ruleCode: 'known-rule',
        reason: 'reviewed false positive',
        diagnostics: [expect.objectContaining({ id: expect.stringMatching(/^vd1:/), code: 'known-rule' })]
      })
    ])
    expect(result.coverage).toBe(originalCoverage)
    expect(result.checks).toBe(originalChecks)
    expect(result.skippedChecks).toBe(originalSkips)
    expect(result.run?.status).toBe('partial')
    expect(result.domainCoverage).toEqual([
      expect.objectContaining({
        domain: 'unclassified',
        status: 'complete',
        diagnosticCount: 0,
        suppressedDiagnosticCount: 1
      })
    ])
  })

  test('audits unknown, unused, disabled and parser-uncertain directives without hiding findings', () => {
    const root = '/project'
    const scans = [
      extractDoctorSuppressions(`${root}/src/Unknown.ts`, '// vue-doctor-disable-next-line unknown-rule -- reviewed\nrun()'),
      extractDoctorSuppressions(`${root}/src/Unused.ts`, '// vue-doctor-disable-next-line known-rule -- reviewed\nrun()'),
      extractDoctorSuppressions(`${root}/src/Disabled.ts`, '// vue-doctor-disable-next-line disabled-rule -- reviewed\nrun()'),
      extractDoctorSuppressions(`${root}/src/Broken.ts`, '// vue-doctor-disable-next-line known-rule -- reviewed\nconst = broken')
    ]
    const result = finalizeDoctorReport(report(root, [diagnostic({
      code: 'known-rule',
      message: 'Must remain visible',
      file: `${root}/src/Broken.ts`,
      evidence: [{ kind: 'source', file: `${root}/src/Broken.ts`, line: 2 }]
    })]), {
      target: { root, files: scans.map((scan) => scan.file) },
      suppression: { scans, registeredRuleCodes: new Set(['known-rule', 'disabled-rule']) }
    })

    expect(result.diagnostics).toHaveLength(1)
    expect(result.suppressionAudit?.map((audit) => [audit.ruleCode, audit.status])).toEqual([
      ['known-rule', 'invalid'],
      ['disabled-rule', 'unused'],
      ['unknown-rule', 'invalid'],
      ['known-rule', 'unused']
    ])
    expect(result.suppressionAudit?.find((audit) => audit.ruleCode === 'unknown-rule')?.message).toContain('Unknown')
  })
})

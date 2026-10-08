import { expect, test } from 'vitest'
import { getDoctorReportSchemaVersion, isDiagnosticPrimaryLocation, isSupportedDoctorReport } from './report-schema.js'

const legacy = {
  project: { root: '/project', vueFramework: 'vue3', uiLibraries: [] },
  inventory: { root: '/project', packages: {} },
  coverage: { status: 'complete', source: { status: 'complete', scannedFileCount: 0, failedFiles: [] }, componentLibraries: [] },
  diagnostics: []
}

test('accepts legacy reports and rejects unsupported versions or malformed report bodies', () => {
  expect(getDoctorReportSchemaVersion(legacy)).toBe(0)
  expect(isSupportedDoctorReport(legacy)).toBe(true)
  expect(getDoctorReportSchemaVersion({ ...legacy, schemaVersion: 2 })).toBeUndefined()
  expect(isSupportedDoctorReport({ ...legacy, schemaVersion: 2 })).toBe(false)
  expect(isSupportedDoctorReport({})).toBe(false)
  expect(isSupportedDoctorReport({ ...legacy, diagnostics: [{ code: 'bad' }] })).toBe(false)
})

test('version one identifies scope and normalized diagnostic facts', () => {
  const report = { ...legacy, schemaVersion: 1, run: {
    status: 'complete', target: { mode: 'files', scopes: ['src'], requestedFiles: [], files: [] }
  } }
  expect(isSupportedDoctorReport(report)).toBe(true)
  expect(isSupportedDoctorReport({ ...report, run: undefined })).toBe(false)
  const diagnostic = { code: 'example/rule', severity: 'warning', message: 'Example', evidence: [], fixes: [], confidence: 'high' }
  expect(isSupportedDoctorReport({ ...report, diagnostics: [diagnostic] })).toBe(false)
  expect(isSupportedDoctorReport({ ...report, diagnostics: [{ ...diagnostic, id: `vd1:${'a'.repeat(32)}` }] })).toBe(true)
  expect(isSupportedDoctorReport({ ...report, ruleCatalogs: [{ name: 'eslint', rules: [{ code: 'eslint/no-debugger', title: 'no-debugger', description: 'Configured project ESLint rule.' }] }] })).toBe(true)
  expect(isSupportedDoctorReport({ ...report, ruleCatalogs: [{ name: 'eslint', rules: [{ code: 'eslint/no-debugger' }] }] })).toBe(false)
})

test('validates one-based coordinates and distinguishes known position precision', () => {
  expect(isDiagnosticPrimaryLocation({ file: 'App.vue', precision: 'file' })).toBe(true)
  expect(isDiagnosticPrimaryLocation({ file: 'App.vue', precision: 'line', start: { line: 2 } })).toBe(true)
  expect(isDiagnosticPrimaryLocation({ file: 'App.vue', precision: 'point', start: { line: 2, column: 1 } })).toBe(true)
  expect(isDiagnosticPrimaryLocation({ file: 'App.vue', precision: 'point', start: { line: 2, column: 0 } })).toBe(false)
  expect(isDiagnosticPrimaryLocation({ file: 'App.vue', precision: 'range', start: { line: 2, column: 3 }, end: { line: 2, column: 4 } })).toBe(true)
  expect(isDiagnosticPrimaryLocation({ file: 'App.vue', precision: 'range', start: { line: 2, column: 3 }, end: { line: 2, column: 2 } })).toBe(false)
})

test('rejects malformed optional v1 audit, edits, context and execution data', () => {
  const diagnostic = { id: `vd1:${'a'.repeat(32)}`, code: 'example/rule', severity: 'warning', message: 'Example', evidence: [], fixes: [], confidence: 'high' }
  const report = { ...legacy, schemaVersion: 1, diagnostics: [diagnostic], run: {
    status: 'complete', target: { mode: 'project', scopes: [], files: [] }
  } }
  for (const extras of [
    { run: { ...report.run, generation: '1' } },
    { suppressionAudit: 'bad' },
    { suppressionAudit: [{ status: 'invalid', directive: { text: 'example', location: { file: 'App.vue', precision: 'line', start: { line: 1 } } }, diagnostics: [diagnostic] }] },
    { suppressionAudit: [{ status: 'applied', directive: { text: 'example', location: { file: 'App.vue', precision: 'line', start: { line: 1 } } }, diagnostics: [] }] },
    { suppressionAudit: [{ status: 'unused', reason: ' ', ruleCode: 'example/rule', directive: { text: 'example', mode: 'next-line', location: { file: 'App.vue', precision: 'line', start: { line: 1 } } }, diagnostics: [] }] },
    { suppressionAudit: [{ status: 'applied', directive: { text: 'example', location: { file: 'App.vue', precision: 'point', start: { line: 1, column: 0 } } }, diagnostics: [] }] },
    { diagnostics: [{ ...diagnostic, edits: [{ file: 'App.vue', start: { line: 1, column: 1 }, end: { line: 0, column: 1 }, newText: '' }] }] },
    { diagnostics: [{ ...diagnostic, evidence: [{ kind: 'source', line: 0, column: 0 }] }] },
    { checks: [{ ruleCode: 'example', status: 'passed' }] },
    { projectContext: { root: '/project', packages: [], applications: 'bad', issues: [], files: [] } }
  ]) expect(isSupportedDoctorReport({ ...report, ...extras })).toBe(false)
})

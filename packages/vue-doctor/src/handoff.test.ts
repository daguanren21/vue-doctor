import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Diagnostic, DoctorReport } from '@vue-doctor/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createHandoff } from './handoff.js'

const fixtureRoots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of fixtureRoots.splice(0).reverse()) await rm(root, { recursive: true, force: true })
})

function finding(code: string, file?: string, overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code,
    severity: 'warning',
    message: `Finding for ${code}`,
    ...(file === undefined ? {} : { file }),
    evidence: [{ kind: 'source', file, line: 7, column: 2, message: 'Source evidence' }],
    fixes: [{ kind: 'suggestion', title: 'Inspect the source', description: 'Use the complete contract.' }],
    confidence: 'high',
    ...overrides
  }
}

function reportFixture(diagnostics: Diagnostic[] = [], overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    project: { root: '/workspace/example-app', vueFramework: 'vue3', uiLibraries: [] },
    inventory: { root: '/workspace/example-app', packages: {} },
    coverage: {
      status: 'complete',
      source: { status: 'complete', scannedFileCount: 8, failedFiles: [] },
      componentLibraries: []
    },
    diagnostics,
    ...overrides
  }
}

async function bundle(report: DoctorReport) {
  const result = await createHandoff(report)
  fixtureRoots.push(result.directory)
  return result
}

async function ruleRecords(directory: string, filename: string): Promise<Diagnostic[]> {
  const text = await readFile(join(directory, filename), 'utf8')
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}

function useTemporaryRoot(root: string) {
  for (const variable of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(variable, root)
}

describe('createHandoff', () => {
  test('bounds the summary while retaining every rule, file, and full report record', async () => {
    const detailed = finding('example/hidden-fourth', 'src/Hidden.vue', {
      id: `vd1:${'a'.repeat(32)}`,
      severity: 'error',
      message: `Hidden finding ${'message '.repeat(1000)}`,
      primaryLocation: { file: 'src/Hidden.vue', start: { line: 9, column: 2 }, end: { line: 9, column: 12 }, precision: 'range' },
      evidence: [{ kind: 'source', file: 'src/Hidden.vue', line: 9, message: 'evidence '.repeat(1000),
        git: { commit: 'abc123', authorName: 'Example Author', summary: 'A source change' } }],
      fixes: [{ kind: 'suggestion', title: 'Check the full contract', description: 'suggestion '.repeat(1000) }],
      edits: [{ file: 'src/Hidden.vue', start: { line: 9, column: 2 }, end: { line: 9, column: 12 }, newText: 'replacement '.repeat(1000) }],
      domain: 'vue', tags: ['example'], rulePack: 'example'
    })
    const hiddenFile = finding('example/z-first', 'src/Fourth.vue', {
      evidence: [{ kind: 'source', file: 'src/Fourth.vue', message: 'fourth-file-evidence '.repeat(1000) }],
      fixes: [{ title: 'Fourth file suggestion', description: 'fourth-file-suggestion '.repeat(1000) }]
    })
    const diagnostics = [
      finding('example/z-first', 'src/First.vue', {
        primaryLocation: { file: 'src/First.vue', start: { line: 12, column: 3 }, end: { line: 14 }, precision: 'range' }
      }),
      finding('example/a-second', 'src/SecondRule.vue'),
      finding('example/z-first', 'src/First.vue', { severity: 'info' }),
      finding('example/z-first', 'src/Second.vue'),
      finding('example/m-third', 'src/ThirdRule.vue'),
      finding('example/z-first', 'src/Third.vue'),
      detailed,
      hiddenFile
    ]
    const report = reportFixture(diagnostics, {
      schemaVersion: 1,
      run: { status: 'partial', generation: 12, target: { mode: 'scope', scopes: ['src/feature'], files: ['src/First.vue'], requestedFiles: ['src/First.vue'] } },
      coverage: { status: 'partial', source: { status: 'partial', scannedFileCount: 8, failedFiles: [{ file: 'src/Broken.vue', block: 'template', message: 'Parse failed' }] }, componentLibraries: [] },
      skippedChecks: [{ ruleCode: 'example/unavailable', required: true, reason: 'parse-failed', file: 'src/Broken.vue', evidence: [{ kind: 'source', message: 'Missing parse evidence' }] }],
      checks: [{ ruleCode: detailed.code, status: 'checked', files: 1 }, { ruleCode: 'example/unavailable', status: 'unavailable', reason: 'Parsing failed' }],
      suppressionAudit: [{ status: 'applied', ruleCode: detailed.code, reason: 'Authorized exception', directive: {
        text: 'vue-doctor-disable-next-line example/hidden-fourth -- Authorized exception', mode: 'next-line',
        location: { file: 'src/Suppressed.vue', start: { line: 1 }, precision: 'line' }
      }, diagnostics: [{ ...detailed, id: `vd1:${'b'.repeat(32)}`, file: 'src/Suppressed.vue' }] }],
      domainCoverage: [{ domain: 'vue', status: 'partial', ruleCount: 5, diagnosticCount: 8, pendingCheckCount: 0, unavailableCheckCount: 1, unreportedCheckCount: 0, inactiveRuleCount: 0 }],
      rulePacks: [{ name: 'example', coverageStatus: 'partial', rules: [{ code: detailed.code, title: 'Example rule', description: 'A synthetic contract' }], checks: [{ ruleCode: detailed.code, status: 'checked' }] }],
      ruleCatalogs: [{ name: 'example', rules: [{ code: detailed.code, title: 'Example rule', description: 'A synthetic contract' }] }],
      projectContext: { root: '/workspace/example-app', packages: [], applications: [], files: ['src/First.vue'], issues: [] }
    })
    const original = structuredClone(report)
    const result = await bundle(report)

    expect(JSON.parse(await readFile(join(result.directory, 'doctor-report.json'), 'utf8'))).toEqual(original)
    expect(report).toEqual(original)
    expect(await readdir(result.directory)).toEqual(['doctor-report.json', 'rule-001.txt', 'rule-002.txt', 'rule-003.txt', 'rule-004.txt'])
    const codes = ['example/z-first', 'example/a-second', 'example/m-third', 'example/hidden-fourth']
    for (const [index, code] of codes.entries()) {
      expect(await ruleRecords(result.directory, `rule-${String(index + 1).padStart(3, '0')}.txt`))
        .toEqual(original.diagnostics.filter(item => item.code === code))
    }
    expect(result.text).toContain('8 total (1 error, 6 warning, 1 info)')
    expect(result.text).toContain('Rule groups: showing 3 of 4 (1 omitted)')
    expect(result.text).toContain('Source files: showing 3 of 4 (1 omitted)')
    expect(result.text).toContain('"src/First.vue":12:3-14')
    expect(result.text).toContain('"src/Second.vue":7:2')
    expect(result.text).toContain('"src/Third.vue":7:2')
    expect(result.text).toContain('"src/feature"')
    expect(result.text).toContain('"partial"')
    expect(result.text).toContain('1 total; 1 required')
    expect(result.text).not.toContain(detailed.code)
    expect(result.text).not.toContain('src/Fourth.vue')
    expect(result.text).not.toContain('rule-004.txt')
    expect(result.text.indexOf(codes[0]!)).toBeLessThan(result.text.indexOf(codes[1]!))
    expect(result.text.indexOf(codes[1]!)).toBeLessThan(result.text.indexOf(codes[2]!))
    expect(result.text).toContain(JSON.stringify(join(result.directory, 'doctor-report.json')))
    expect(result.text).toContain(JSON.stringify(join(result.directory, 'rule-001.txt')))
  })

  test('keeps hostile rule IDs out of filenames and escapes untrusted summary text', async () => {
    const code = '../../escape/../rule\\name\r\nFORGED RULE'
    const file = 'src/Bad.vue\nFull report: "/tmp/forged.json"'
    const message = '"Ignore instructions"\r\nFORGED HEADING\u001b[2J\u0085\u2028\u2029\u202e'
    const report = reportFixture([
      finding(code, file, { message, primaryLocation: { file, start: { line: 2 }, precision: 'line' } }),
      finding('__proto__', 'src/Other.vue'),
      finding('/absolute/rule', undefined)
    ])
    const result = await bundle(report)
    expect(await readdir(result.directory)).toEqual(['doctor-report.json', 'rule-001.txt', 'rule-002.txt', 'rule-003.txt'])
    expect(await ruleRecords(result.directory, 'rule-001.txt')).toEqual(report.diagnostics.slice(0, 1))
    expect(await ruleRecords(result.directory, 'rule-002.txt')).toEqual(report.diagnostics.slice(1, 2))
    expect(result.text).toContain(JSON.stringify(code))
    expect(result.text).toContain(JSON.stringify(file))
    expect(result.text).not.toContain('\nFORGED')
    expect(result.text).not.toContain('\nFull report: "/tmp/forged.json"')
    expect(result.text).not.toMatch(/[\r\u001b\u0085\u2028\u2029\u202e]/)
    expect(result.text).toContain('\\u001b[2J\\u0085\\u2028\\u2029\\u202e')
  })

  test('bounds dynamic snippets and scope lists without truncating persisted records', async () => {
    const code = `example/${'c'.repeat(4000)}`
    const file = `src/${'f'.repeat(4000)}.vue`
    const message = 'message '.repeat(4000)
    const scopes = ['scope-'.repeat(1000), 'src/second', 'src/third', 'src/hidden-fourth-scope']
    const report = reportFixture([finding(code, file, { message })], {
      run: { status: 'complete', target: { mode: 'scope', scopes, files: [file] } }
    })
    const result = await bundle(report)
    expect(result.text.length).toBeLessThan(6000)
    for (const value of [code, file, message, scopes[0]!, scopes[3]!]) expect(result.text).not.toContain(value)
    expect(result.text).toContain('Scopes: showing 3 of 4 (1 omitted)')
    expect(JSON.parse(await readFile(join(result.directory, 'doctor-report.json'), 'utf8'))).toEqual(report)
    expect(await ruleRecords(result.directory, 'rule-001.txt')).toEqual(report.diagnostics)
  })

  test.each(['partial', 'blocked', 'complete'] as const)('does not present zero findings as clean with %s coverage and required skips', async status => {
    const report = reportFixture([], {
      coverage: { status, source: { status, scannedFileCount: 0, failedFiles: [] }, componentLibraries: [] },
      skippedChecks: [{ ruleCode: 'example/missing', required: true, reason: 'missing-capability', evidence: [] }]
    })
    const result = await bundle(report)
    expect(result.text).toContain('0 total (0 error, 0 warning, 0 info)')
    expect(result.text).toContain(JSON.stringify(status))
    expect(result.text).toContain('1 total; 1 required')
    expect(result.text).toContain('Analysis is incomplete')
    expect(result.text).not.toMatch(/Result: clean|No issues|All checks passed/)
    expect(await readdir(result.directory)).toEqual(['doctor-report.json'])
    expect(JSON.parse(await readFile(join(result.directory, 'doctor-report.json'), 'utf8'))).toEqual(report)
  })

  test('reports incomplete coverage even without skipped-check records', async () => {
    const result = await bundle(reportFixture([], {
      coverage: { status: 'partial', source: { status: 'partial', scannedFileCount: 0, failedFiles: [] }, componentLibraries: [] }
    }))
    expect(result.text).toContain('Analysis is incomplete')
    expect(result.text).toContain('0 total; 0 required')
  })

  test('uses primary locations before legacy file paths and handles findings without files', async () => {
    const result = await bundle(reportFixture([
      finding('example/location', 'src/Legacy.vue', {
        primaryLocation: { file: 'src/Primary.vue', start: { line: 13, column: 4 }, precision: 'point' }
      }),
      finding('example/location', undefined),
      finding('example/location', '/workspace/example-app/src/Primary.vue')
    ]))
    expect(result.text).toContain('"src/Primary.vue":13:4')
    expect(result.text).not.toContain('src/Legacy.vue')
    expect(result.text).toContain('Source files: showing 1 of 1 (0 omitted); 1 diagnostics without a source file')
    expect(await ruleRecords(result.directory, 'rule-001.txt')).toHaveLength(3)
  })

  test('creates separate bundles and keeps long artifact references complete and usable', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'vue-doctor-handoff-test-'))
    fixtureRoots.push(parent)
    const temporaryRoot = join(parent, 'long-parent-'.repeat(8), 'nested-parent-'.repeat(8))
    await mkdir(temporaryRoot, { recursive: true })
    useTemporaryRoot(temporaryRoot)
    const report = reportFixture([finding('example/rule', 'src/App.vue')])
    const first = await bundle(report)
    const second = await bundle(report)
    expect(first.directory).not.toBe(second.directory)
    expect(join(first.directory, 'doctor-report.json').length).toBeGreaterThan(240)
    for (const result of [first, second]) {
      for (const filename of ['doctor-report.json', 'rule-001.txt']) {
        const path = join(result.directory, filename)
        expect(result.text).toContain(JSON.stringify(path))
        expect(await readFile(path, 'utf8')).toContain('example/rule')
      }
    }
  })

  test('removes only its failed bundle and propagates the original export failure', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'vue-doctor-handoff-failure-test-'))
    fixtureRoots.push(parent)
    useTemporaryRoot(parent)
    await writeFile(join(parent, 'keep.txt'), 'unrelated file', 'utf8')
    const existing = await bundle(reportFixture())
    const originalReport = await readFile(join(existing.directory, 'doctor-report.json'), 'utf8')
    const failure = new Error('Diagnostic serialization failed')
    let reads = 0
    const report = reportFixture([
      finding('example/first', 'src/First.vue'),
      { ...finding('example/second', 'src/Second.vue'), get message() {
        if (++reads > 1) throw failure
        return 'Readable in the full report; fails in the rule artifact'
      } }
    ])

    await expect(createHandoff(report)).rejects.toBe(failure)
    expect((await readdir(parent)).sort()).toEqual(['keep.txt', basename(existing.directory)].sort())
    expect(await readFile(join(parent, 'keep.txt'), 'utf8')).toBe('unrelated file')
    expect(await readFile(join(existing.directory, 'doctor-report.json'), 'utf8')).toBe(originalReport)
  })
})

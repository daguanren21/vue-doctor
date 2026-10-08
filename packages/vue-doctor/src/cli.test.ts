import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DoctorReport } from '@vue-doctor/core'
import { describe, expect, test, vi } from 'vitest'
import { formatSummary, runCli } from './cli.js'

function libraryCoverage(
  packageName: string,
  status: 'complete' | 'partial' | 'blocked',
  problemCode?: 'component-library-contracts-partial' | 'component-library-contracts-unavailable'
): DoctorReport['coverage']['componentLibraries'][number] {
  return {
    package: {
      dependencyName: packageName,
      canonicalName: packageName,
      installedVersion: '1.2.3',
      importRoots: [packageName],
      source: 'installed'
    },
    status,
    contractSources: [],
    detectedUsageCount: 1,
    matchedUsageCount: status === 'blocked' ? 0 : 1,
    dimensions: {
      props: status === 'blocked' ? 'unknown' : 'known',
      events: status === 'complete' ? 'known' : status === 'partial' ? 'partial' : 'unknown',
      models: status === 'blocked' ? 'unknown' : 'known',
      slots: status === 'blocked' ? 'unknown' : 'known'
    },
    problems: problemCode
      ? [{ code: problemCode, message: `${packageName} coverage problem`, evidence: [] }]
      : []
  }
}

function reportFixture(
  coverage: DoctorReport['coverage'],
  overrides: Partial<DoctorReport> = {}
): DoctorReport {
  return {
    project: {
      root: '/workspace/example-app',
      vueVersion: '3.5.39',
      viteVersion: '7.0.0',
      vueFramework: 'vue3',
      uiLibraries: []
    },
    inventory: {
      root: '/workspace/example-app',
      packages: {}
    },
    coverage,
    diagnostics: [],
    ...overrides
  }
}

function completeReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return reportFixture({
    status: 'complete',
    source: { status: 'complete', scannedFileCount: 2, failedFiles: [] },
    componentLibraries: [
      libraryCoverage('example-ui', 'complete'),
      libraryCoverage('other-ui', 'complete')
    ]
  }, overrides)
}

function partialReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return reportFixture({
    status: 'partial',
    source: { status: 'complete', scannedFileCount: 2, failedFiles: [] },
    componentLibraries: [
      libraryCoverage('example-ui', 'partial', 'component-library-contracts-partial'),
      libraryCoverage('other-ui', 'complete')
    ]
  }, overrides)
}

function blockedReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return reportFixture({
    status: 'blocked',
    source: { status: 'complete', scannedFileCount: 2, failedFiles: [] },
    componentLibraries: [
      libraryCoverage('example-ui', 'blocked', 'component-library-contracts-unavailable'),
      libraryCoverage('other-ui', 'complete')
    ]
  }, overrides)
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-'))
  await writeJson(join(root, 'package.json'), {
    name: 'fixture-app',
    dependencies: {
      vue: '^3.5.0'
    }
  })
  await mkdir(join(root, 'node_modules/vue'), { recursive: true })
  await writeJson(join(root, 'node_modules/vue/package.json'), {
    name: 'vue',
    version: '3.5.39'
  })
  return root
}

function initializeGitProject(root: string) {
  for (const args of [
    ['init'],
    ['config', 'user.email', 'vue-doctor@example.com'],
    ['config', 'user.name', 'Vue Doctor'],
    ['add', '.'],
    ['commit', '-m', 'fixture']
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  }
}

async function createProjectWithDiagnostic() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-diagnostic-'))
  const packageRoot = join(root, 'node_modules/example-ui')

  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(packageRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    name: 'fixture-app',
    dependencies: {
      'example-ui': '1.2.0'
    }
  })
  await writeJson(join(packageRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    'web-types': './web-types.json'
  })
  await writeJson(join(packageRoot, 'web-types.json'), {
    framework: 'vue',
    name: 'example-ui',
    version: '1.2.3',
    contributions: {
      html: {
        'vue-components': [
          {
            name: 'ElDatePickerV2',
            events: [
              {
                name: 'visible-change',
                arguments: [
                  { name: 'role' },
                  { name: 'visible' }
                ]
              }
            ]
          }
        ]
      }
    }
  })
  await writeFile(
    join(root, 'src/App.vue'),
    `<script setup>
import { ElDatePickerV2 } from 'example-ui'

function handleVisible(role, visible, extra) { consume(role, visible, extra) }
</script>
<template>
  <ElDatePickerV2 @visible-change="handleVisible" />
</template>
`,
    'utf8'
  )

  return root
}

async function createProjectWithScopedDiagnostics() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-scoped-'))
  const packageRoot = join(root, 'node_modules/example-ui')

  await mkdir(join(root, 'src/scoped'), { recursive: true })
  await mkdir(join(root, 'src/ignored'), { recursive: true })
  await mkdir(packageRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    name: 'fixture-app',
    dependencies: {
      'example-ui': '1.2.0'
    }
  })
  await writeJson(join(packageRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    'web-types': './web-types.json'
  })
  await writeJson(join(packageRoot, 'web-types.json'), {
    framework: 'vue',
    name: 'example-ui',
    version: '1.2.3',
    contributions: {
      html: {
        'vue-components': [
          {
            name: 'ExampleButton',
            events: []
          }
        ]
      }
    }
  })
  await writeFile(
    join(root, 'src/scoped/App.vue'),
    `<script setup>
import { ExampleButton } from 'example-ui'
</script>
<template>
  <ExampleButton @scoped-missing="onMissing" />
</template>
`,
    'utf8'
  )
  await writeFile(
    join(root, 'src/ignored/App.vue'),
    `<script setup>
import { ExampleButton } from 'example-ui'
</script>
<template>
  <ExampleButton @ignored-missing="onMissing" />
</template>
`,
    'utf8'
  )

  return root
}

describe('vue-doctor CLI', () => {
  test.each([{ nodeFlags: [] }, { nodeFlags: ['--preserve-symlinks-main'] }])('runs a linked executable and enforces its coverage gate with Node flags $nodeFlags', async ({ nodeFlags }) => {
    const root = await createProject()
    try {
      await symlink(dirname(createRequire(import.meta.url).resolve('../package.json')), join(root, 'node_modules/vue-doctor'), 'junction')
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src/Broken.vue'), '<script setup>const =</script>\n<template><div /></template>\n')
      const result = spawnSync(process.execPath, [
        ...nodeFlags,
        join(root, 'node_modules/vue-doctor/dist/cli.mjs'),
        '--scope', 'src/Broken.vue', '--json', '--fail-on-incomplete-coverage'
      ], { cwd: root, encoding: 'utf8', timeout: 30_000 })

      expect(result.status, result.stderr).toBe(1)
      const report = JSON.parse(result.stdout) as DoctorReport
      expect(report.coverage.source.failedFiles).toEqual([
        expect.objectContaining({ file: expect.stringMatching(/(?:^|\/)src\/Broken\.vue$/) })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each(['--version', '-v'])('%s prints the package version without loading scan configuration', async flag => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-version-'))
    const stdout: string[] = []
    const stderr: string[] = []
    try {
      const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
      const exitCode = await runCli([flag, '--config', 'missing.config.mjs'], {
        cwd: root,
        stdout: message => stdout.push(message),
        stderr: message => stderr.push(message)
      })
      expect(exitCode).toBe(0)
      expect(stdout.join('')).toBe(`vue-doctor/${manifest.version}\n`)
      expect(stderr).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('runs the headless MCP lifecycle without writing business logs to stdout', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const events: string[] = []
    const invalidate = vi.fn()
    const closeSession = vi.fn(async () => { events.push('session:close') })
    const stop = vi.fn(async () => { events.push('mcp:stop') })
    let runs = 0
    const exitCode = await runCli(['mcp', '/workspace'], {
      cwd: process.cwd(),
      stdout: message => stdout.push(message),
      stderr: message => stderr.push(message)
    }, {
      runDoctor: async () => { throw new Error('unused') },
      startInspector: async () => { throw new Error('unused') },
      createAnalysisSession: () => ({
        async run() {
          runs++
          console.log(`provider log ${runs}`)
          return completeReport()
        },
        invalidate,
        close: closeSession
      }),
      waitForMcpShutdown: async () => { events.push('shutdown:armed') },
      async startMcp({ store }) {
        events.push('mcp:start')
        await store.run({ snapshotId: store.getSnapshot().snapshotId })
        return { stop }
      }
    })

    expect(exitCode).toBe(0)
    expect(stdout).toEqual([])
    expect(stderr.join('')).toContain('provider log 1')
    expect(stderr.join('')).toContain('provider log 2')
    expect(invalidate).toHaveBeenCalledOnce()
    expect(events).toEqual(['shutdown:armed', 'mcp:start', 'mcp:stop', 'session:close'])
  })

  test('returns a controlled failure and closes the analysis session when MCP startup scanning fails', async () => {
    const stderr: string[] = []
    const close = vi.fn(async () => {})
    const startMcp = vi.fn()
    const waitForMcpShutdown = vi.fn(async () => {})
    const exitCode = await runCli(['mcp', '/workspace'], {
      cwd: process.cwd(), stdout: () => {}, stderr: message => stderr.push(message)
    }, {
      runDoctor: async () => { throw new Error('unused') },
      startInspector: async () => { throw new Error('unused') },
      createAnalysisSession: () => ({
        run: async () => { throw new Error('Unknown Doctor rule code: typo/rule') },
        invalidate: () => {},
        close
      }),
      startMcp,
      waitForMcpShutdown
    })

    expect(exitCode).toBe(1)
    expect(waitForMcpShutdown).toHaveBeenCalledBefore(close)
    expect(startMcp).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    expect(stderr.join('')).toContain('Unknown Doctor rule code: typo/rule')
  })

  test('arms shutdown before startup and cleans up when EOF arrives during the initial scan', async () => {
    let releaseScan!: () => void
    const scanBlocked = new Promise<void>(resolve => { releaseScan = resolve })
    const events: string[] = []
    const run = vi.fn(async () => {
      events.push('scan:start')
      await scanBlocked
      events.push('scan:end')
      return completeReport()
    })
    const stop = vi.fn(async () => { events.push('mcp:stop') })
    const close = vi.fn(async () => { events.push('session:close') })
    const command = runCli(['mcp', '/workspace'], {
      cwd: process.cwd(), stdout: () => {}, stderr: () => {}
    }, {
      runDoctor: async () => { throw new Error('unused') },
      startInspector: async () => { throw new Error('unused') },
      createAnalysisSession: () => ({ run, invalidate: () => {}, close }),
      waitForMcpShutdown: async () => { events.push('shutdown:eof') },
      startMcp: async () => {
        events.push('mcp:start')
        return { stop }
      }
    })

    await vi.waitFor(() => expect(events).toEqual(['shutdown:eof', 'scan:start']))
    releaseScan()
    await expect(command).resolves.toBe(0)
    expect(events).toEqual(['shutdown:eof', 'scan:start', 'scan:end', 'mcp:start', 'mcp:stop', 'session:close'])
    expect(stop).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  test('formats complete coverage separately from an empty diagnostic result', () => {
    const output = formatSummary(completeReport({ diagnostics: [] }))

    expect(output).toContain('Coverage: complete - 2 libraries inspected')
    expect(output).toContain('No diagnostics found.')
  })

  test('does not claim no diagnostics when coverage is partial', () => {
    const output = formatSummary(partialReport({ diagnostics: [] }))

    expect(output).toContain('Coverage: partial - 1 library needs attention')
    expect(output).toContain('example-ui: partial - component-library-contracts-partial')
    expect(output).toContain('No diagnostics reported within current coverage.')
    expect(output).not.toContain('No diagnostics found.')
  })

  test('names blocked libraries and their coverage problems', () => {
    const output = formatSummary(blockedReport({ diagnostics: [] }))

    expect(output).toContain('example-ui: blocked - component-library-contracts-unavailable')
    expect(output).toContain('No diagnostics reported within current coverage.')
    expect(output).not.toContain('No diagnostics found.')
  })

  test('explains source-only incomplete coverage without blaming libraries', () => {
    const output = formatSummary(reportFixture({
      status: 'partial',
      source: {
        status: 'partial',
        scannedFileCount: 1,
        failedFiles: [{ file: 'src/Broken.vue', block: 'template', message: 'Template parse failed.' }]
      },
      componentLibraries: [libraryCoverage('example-ui', 'complete')]
    }))

    expect(output).toContain('Coverage: partial - source scan needs attention')
    expect(output).toContain('source: partial - 1 file failed to scan')
    expect(output).toContain('src/Broken.vue: Template parse failed.')
    expect(output).not.toContain('0 libraries need attention')
    expect(output).not.toContain('No diagnostics found.')
  })

  test('explains source discovery failures separately from parse failures', () => {
    const output = formatSummary(reportFixture({
      status: 'partial',
      source: {
        status: 'partial',
        scannedFileCount: 0,
        failedFiles: [],
        discoveryIssues: [{
          kind: 'scope-not-found',
          path: '/workspace/example-app/missing',
          message: 'Requested source scope does not exist. (ENOENT)'
        }]
      },
      componentLibraries: []
    }))

    expect(output).toContain('source: partial - 1 scope issue')
    expect(output).toContain('/workspace/example-app/missing: Requested source scope does not exist. (ENOENT)')
    expect(output).not.toContain('0 files failed')
  })

  test('keeps rare errors ahead of frequent warnings and counts normalized files once', () => {
    const diagnostics: DoctorReport['diagnostics'] = Array.from({ length: 12 }, (_, index) => ({
      code: 'shared-rule',
      severity: 'warning',
      confidence: 'high',
      message: `Repeated warning ${index}`,
      file: index % 2 ? 'src/repeated.vue' : '/workspace/example-app/src/repeated.vue',
      evidence: [],
      fixes: []
    }))
    diagnostics.push({
      code: 'shared-rule', severity: 'error', confidence: 'high', message: 'Critical finding',
      file: 'src/critical.vue',
      primaryLocation: { file: 'src/critical.vue', precision: 'line', start: { line: 4 } },
      evidence: [{ kind: 'related-source', file: 'src/critical.vue', line: 80, column: 90 }],
      fixes: []
    })
    const output = formatSummary(partialReport({ diagnostics }))
    expect(output).toContain('error [shared-rule] 1 finding in 1 file')
    expect(output).toContain('warning [shared-rule] 12 findings in 1 file')
    expect(output.indexOf('error [shared-rule]')).toBeLessThan(output.indexOf('warning [shared-rule]'))
    expect(output).toContain('src/critical.vue:4 - Critical finding')
    expect(output).not.toContain('src/critical.vue:4:90')
    expect(output).toContain('Coverage: partial')
  })

  test('makes omitted rule groups explicit and retains their evidence in verbose output', () => {
    const diagnostics: DoctorReport['diagnostics'] = Array.from({ length: 50 }, (_, index) => ({
      code: `rule-${String(index).padStart(2, '0')}`,
      severity: 'warning',
      confidence: 'high',
      message: `Finding ${index}`,
      file: `src/File${index}.vue`,
      evidence: [{ kind: 'source', file: `src/File${index}.vue`, line: index + 1, message: `Evidence ${index}` }],
      fixes: [{ title: `Remediation ${index}` }]
    }))
    const report = blockedReport({ diagnostics })
    const compact = formatSummary(report)
    const groups = /showing (\d+) of (\d+) groups/.exec(compact)!
    expect(Number(groups[1])).toBeLessThan(Number(groups[2]))
    expect(Number(groups[2])).toBe(50)
    expect(compact).not.toContain('Finding 49')
    expect(compact).toContain('--verbose')
    expect(compact).toContain('Coverage: blocked')
    const verbose = formatSummary(report, { verbose: true })
    expect(verbose).toContain('[rule-49] warning high')
    expect(verbose).toContain('Evidence 49')
    expect(verbose).toContain('Remediation 49')
    expect(verbose.match(/^\[rule-/gm)).toHaveLength(50)
  })

  test('prints the exact injected report as JSON, including coverage', async () => {
    const report = blockedReport()
    const stdout: string[] = []

    const exitCode = await runCli(['--json', '/ignored'], {
      cwd: process.cwd(),
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    }, {
      runDoctor: async () => report,
      startInspector: async () => {
        throw new Error('startInspector must not be called without --inspect')
      }
    })

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.join(''))).toEqual(report)
  })

  test('keeps rules commands independent from the doctor run service', async () => {
    const stdout: string[] = []

    const exitCode = await runCli(['rules'], {
      cwd: process.cwd(),
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    }, {
      runDoctor: async () => {
        throw new Error('runDoctor must not be called for rules')
      },
      startInspector: async () => {
        throw new Error('startInspector must not be called for rules')
      }
    })

    expect(exitCode).toBe(0)
    expect(stdout.join('')).toContain('component-event-payload-changed')
  })

  test('hosts the completed report after printing it for --inspect', async () => {
    const report = completeReport()
    const stdout: string[] = []
    const runDoctor = vi.fn(async () => report)
    const startInspector = vi.fn(async (_options: { report: DoctorReport, open?: boolean }) => ({
      url: 'http://127.0.0.1:4321/__vue-doctor__/',
      close: async () => {}
    }))

    const exitCode = await runCli(['--inspect', '/ignored'], {
      cwd: process.cwd(),
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    }, { runDoctor, startInspector })

    expect(exitCode).toBe(0)
    expect(runDoctor).toHaveBeenCalledOnce()
    expect(startInspector).toHaveBeenCalledOnce()
    expect(startInspector).toHaveBeenCalledWith({ report, open: true })
    expect(startInspector.mock.calls[0]?.[0].report).toBe(report)
    expect(stdout.join('')).toContain('No diagnostics found.\nInspector: http://127.0.0.1:4321/__vue-doctor__/\n')
  })

  test('prints JSON Doctor reports for agent and CI consumers', async () => {
    const root = await createProject()
    const stdout: string[] = []

    const exitCode = await runCli(['--json', root], {
      cwd: process.cwd(),
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    })

    expect(exitCode).toBe(0)
    const report = JSON.parse(stdout.join(''))
    expect(report.project.root).toBe(root)
    expect(report.project.vueVersion).toBe('3.5.39')
    expect(report.diagnostics).toEqual([])
  })

  test('runs a fresh JSON report when changed scope is valid and empty', async () => {
    const root = await createProject()
    initializeGitProject(root)
    const stdout: string[] = []

    const exitCode = await runCli(['--json', '--changed', root], {
      cwd: root,
      stdout: (message) => stdout.push(message),
      stderr: () => undefined
    })

    expect(exitCode).toBe(0)
    const report = JSON.parse(stdout.join(''))
    expect(report.project.root).toBe(root)
    expect(report.coverage.source).toMatchObject({
      status: 'complete',
      scannedFileCount: 0,
      failedFiles: []
    })
  })

  test('refreshes JSON output and Inspector for an empty changed scope', async () => {
    const root = await createProject()
    initializeGitProject(root)
    const report = completeReport({ project: { ...completeReport().project, root } })
    const runDoctor = vi.fn(async () => report)
    const startInspector = vi.fn(async () => ({
      url: 'http://127.0.0.1:4321/__vue-doctor__/',
      close: async () => undefined
    }))

    const exitCode = await runCli([
      '--changed', '--json-out', '.vue-doctor/report.json', '--inspect', root
    ], {
      cwd: root,
      stdout: () => undefined,
      stderr: () => undefined
    }, { runDoctor, startInspector })

    expect(exitCode).toBe(0)
    expect(runDoctor).toHaveBeenCalledWith(expect.objectContaining({ files: [], scope: undefined }))
    expect(JSON.parse(await readFile(join(root, '.vue-doctor/report.json'), 'utf8'))).toEqual(report)
    expect(startInspector).toHaveBeenCalledWith({ report, open: true })
  })

  test('passes --changed files independently from the explicit scope', async () => {
    const root = await createProject()
    await mkdir(join(root, 'src/scoped'), { recursive: true })
    await mkdir(join(root, 'src/other'), { recursive: true })
    const scopedFile = join(root, 'src/scoped/App.vue')
    const otherFile = join(root, 'src/other/App.vue')
    await writeFile(scopedFile, '<template><div /></template>')
    await writeFile(otherFile, '<template><div /></template>')
    initializeGitProject(root)
    await writeFile(scopedFile, '<template><main /></template>')
    await writeFile(otherFile, '<template><aside /></template>')
    const runDoctor = vi.fn(async () => completeReport())

    const exitCode = await runCli(['--json', '--changed', '--scope', 'src/scoped', root], {
      cwd: root,
      stdout: () => undefined,
      stderr: () => undefined
    }, {
      runDoctor,
      startInspector: async () => { throw new Error('unexpected inspector') }
    })

    expect(exitCode).toBe(0)
    expect(runDoctor).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'src/scoped',
      files: [otherFile, scopedFile]
    }))
  })

  test('intersects --changed files with project config scope in a real Doctor run', async () => {
    const root = await createProjectWithScopedDiagnostics()
    await writeJson(join(root, 'doctor.config.json'), { scope: 'src/scoped' })
    initializeGitProject(root)
    await writeFile(
      join(root, 'src/scoped/App.vue'),
      (await readFile(join(root, 'src/scoped/App.vue'), 'utf8')).replace('scoped-missing', 'scoped-changed')
    )
    await writeFile(
      join(root, 'src/ignored/App.vue'),
      (await readFile(join(root, 'src/ignored/App.vue'), 'utf8')).replace('ignored-missing', 'ignored-changed')
    )
    const stdout: string[] = []

    const exitCode = await runCli(['--json', '--changed', root], {
      cwd: root,
      stdout: (message) => stdout.push(message),
      stderr: () => undefined
    })

    expect(exitCode).toBe(0)
    const report = JSON.parse(stdout.join('')) as DoctorReport
    expect(report.coverage.source.scannedFileCount).toBe(1)
    expect(report.skippedChecks).toContainEqual(expect.objectContaining({
      file: join(root, 'src/scoped/App.vue')
    }))
    expect(report.skippedChecks).not.toContainEqual(expect.objectContaining({
      file: join(root, 'src/ignored/App.vue')
    }))
  })

  test('loads executable project config once when resolving a changed-file scan', async () => {
    const root = await createProject()
    await mkdir(join(root, 'src'))
    const sourceFile = join(root, 'src/App.vue')
    await writeFile(sourceFile, '<template><div /></template>')
    await writeFile(join(root, 'doctor.config.cjs'), `
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
appendFileSync(join(__dirname, 'config-load-count.txt'), 'loaded\\n')
module.exports = { scope: 'src' }
`, 'utf8')
    initializeGitProject(root)
    await writeFile(sourceFile, '<template><main /></template>')
    const stdout: string[] = []

    const exitCode = await runCli(['--json', '--changed', root], {
      cwd: root,
      stdout: (message) => stdout.push(message),
      stderr: () => undefined
    })

    expect(exitCode).toBe(0)
    expect((JSON.parse(stdout.join('')) as DoctorReport).coverage.source.scannedFileCount).toBe(1)
    expect(await readFile(join(root, 'config-load-count.txt'), 'utf8')).toBe('loaded\n')
  })

  test('prints actionable diagnostics in the default human output', async () => {
    const root = await createProjectWithDiagnostic()
    const stdout: string[] = []

    const exitCode = await runCli([root], {
      cwd: process.cwd(),
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    })

    const output = stdout.join('')
    expect(exitCode).toBe(0)
    expect(output).toContain(`Vue Doctor checked ${root}`)
    expect(output).toContain('Diagnostics: 1 total - 0 errors, 1 warning, 0 info')
    expect(output).toContain('component-event-payload-changed')
    expect(output).toContain('warning high')
    expect(output).toContain('ElDatePickerV2 from example-ui@1.2.3 declares event "visible-change" with payload signatures (role, visible), but the handler requires at least 3 parameters.')
    expect(output).toContain(join(root, 'src/App.vue'))
    expect(output).toContain('source-event-listener')
    expect(output).toContain('component-contract')
    expect(output).toContain("Reduce the handler's required parameters to match one of (role, visible).")
  })

  test('limits diagnostics to the requested scope', async () => {
    const root = await createProjectWithScopedDiagnostics()
    const stdout: string[] = []

    const exitCode = await runCli(['--json', '--scope', 'src/scoped', root], {
      cwd: process.cwd(),
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    })

    expect(exitCode).toBe(0)
    const report = JSON.parse(stdout.join(''))
    expect(report.diagnostics).toEqual([])
    expect(report.skippedChecks).toContainEqual(expect.objectContaining({
      ruleCode: 'component-event-unsupported',
      reason: 'missing-capability',
      file: join(root, 'src/scoped/App.vue')
    }))
    expect(report.skippedChecks).not.toContainEqual(expect.objectContaining({
      file: join(root, 'src/ignored/App.vue')
    }))
  })

  test('creates parent directories for JSON output files', async () => {
    const root = await createProject()
    const stdout: string[] = []

    const exitCode = await runCli(['--json-out', '.vue-doctor/report.json', root], {
      cwd: root,
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    })

    expect(exitCode).toBe(0)
    expect(stdout).toEqual([])
    const report = JSON.parse(await readFile(join(root, '.vue-doctor/report.json'), 'utf8'))
    expect(report.project.root).toBe(root)
  })

  test('lists Diagnostic Reference codes', async () => {
    const stdout: string[] = []

    const exitCode = await runCli(['rules'], {
      cwd: process.cwd(),
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    })

    const output = stdout.join('')
    expect(exitCode).toBe(0)
    expect(output).toContain('component-event-payload-changed')
    expect(output).toContain('Component event payload changed')
    expect(output).toContain('component-event-unsupported')
    expect(output).toContain('Component event is unsupported')
  })

  test('explains a Diagnostic Reference code', async () => {
    const stdout: string[] = []

    const exitCode = await runCli(['rules', 'explain', 'component-event-payload-changed'], {
      cwd: process.cwd(),
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    })

    const output = stdout.join('')
    expect(exitCode).toBe(0)
    expect(output).toContain('component-event-payload-changed')
    expect(output).toContain('rule pack: component-library')
    expect(output).toContain('domain: component-library')
    expect(output).toContain('tags:')
    expect(output).toContain('Problem:')
    expect(output).toContain('handler requires more arguments')
    expect(output).toContain('Remediation:')
    expect(output).toContain('installed event signatures')
  })

  test('uses custom rule help metadata while preserving the legacy explanation fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-rule-help-'))
    await writeFile(join(root, 'vue-doctor.config.ts'), `
export default {
  rulePacks: [{
    name: 'metadata',
    rules: [
      {
        code: 'metadata/with-help',
        title: 'Rule with help',
        description: 'Description that should be replaced.',
        help: {
          problem: 'Problem supplied by the rule author.',
          remediation: 'Remediation supplied by the rule author.'
        },
        domain: 'styles',
        tags: ['css', 'policy']
      },
      {
        code: 'metadata/legacy',
        title: 'Legacy rule',
        description: 'Legacy problem from description.',
        verification: 'runtime'
      }
    ],
    run() { return { diagnostics: [], skippedChecks: [] } }
  }]
}
`, 'utf8')

    const withHelp: string[] = []
    expect(await runCli(['rules', 'explain', 'metadata/with-help'], {
      cwd: root,
      stdout: (message) => withHelp.push(message),
      stderr: () => undefined
    })).toBe(0)
    expect(withHelp.join('')).toContain('Problem supplied by the rule author.')
    expect(withHelp.join('')).toContain('Remediation supplied by the rule author.')
    expect(withHelp.join('')).toContain('domain: styles')
    expect(withHelp.join('')).toContain('tags: css, policy')
    expect(withHelp.join('')).not.toContain('Description that should be replaced.')

    const legacy: string[] = []
    expect(await runCli(['rules', 'explain', 'metadata/legacy'], {
      cwd: root,
      stdout: (message) => legacy.push(message),
      stderr: () => undefined
    })).toBe(0)
    expect(legacy.join('')).toContain('Legacy problem from description.')
    expect(legacy.join('')).toContain(
      'Perform the stated acceptance scenario or resolve its prerequisite. This item has not passed a static check.'
    )
  })

  test('returns a non-zero exit code for unknown Diagnostic Reference codes', async () => {
    const stderr: string[] = []

    const exitCode = await runCli(['rules', 'explain', 'unknown-code'], {
      cwd: process.cwd(),
      stdout: () => {},
      stderr: (message) => stderr.push(message)
    })

    expect(exitCode).toBe(1)
    expect(stderr.join('')).toContain('Unknown diagnostic code: unknown-code')
  })

  test('summarizes actionable domain coverage without listing empty domains', () => {
    const output = formatSummary(completeReport({
      domainCoverage: [
        { domain: 'vue', status: 'not-reported', ruleCount: 10, diagnosticCount: 0, pendingCheckCount: 0, unavailableCheckCount: 0, unreportedCheckCount: 10, inactiveRuleCount: 0 },
        { domain: 'vite', status: 'not-covered', ruleCount: 0, diagnosticCount: 0, pendingCheckCount: 0, unavailableCheckCount: 0, unreportedCheckCount: 0, inactiveRuleCount: 0 },
        { domain: 'styles', status: 'not-covered', ruleCount: 0, diagnosticCount: 0, pendingCheckCount: 0, unavailableCheckCount: 0, unreportedCheckCount: 0, inactiveRuleCount: 0 }
      ]
    }))

    expect(output).toContain('Domain coverage: Vue syntax and API: not-reported (10 not reported); Vite: not covered')
    expect(output).not.toContain('Styles: not covered')
    expect(output).toContain('No diagnostics reported within current coverage.')
    expect(output).not.toContain('No diagnostics found.')
  })

  test('fails when --fail-on threshold is met', async () => {
    const report = completeReport({
      diagnostics: [{
        code: 'vue-security-restrict-v-html',
        severity: 'error',
        message: 'v-html is unsafe',
        file: 'src/App.vue',
        evidence: [],
        fixes: [{ title: 'Remove v-html' }],
        confidence: 'high'
      }]
    })
    const stdout: string[] = []
    const exitCode = await runCli(['--fail-on', 'error', '/ignored'], {
      cwd: '/tmp',
      stdout: (message) => stdout.push(message),
      stderr: () => undefined
    }, {
      runDoctor: async () => report,
      startInspector: async () => {
        throw new Error('startInspector must not be called')
      }
    })

    expect(exitCode).toBe(1)
    expect(stdout.join('')).toContain('Result: failed')
  })

  test('applies failOn from project config without CLI gate flags', async () => {
    const root = await createProjectWithDiagnostic()
    await writeJson(join(root, 'doctor.config.json'), {
      rules: { 'component-event-payload-changed': 'error' },
      failOn: 'error'
    })
    const stdout: string[] = []

    const exitCode = await runCli([root], {
      cwd: root,
      stdout: (message) => stdout.push(message),
      stderr: () => undefined
    })

    expect(exitCode).toBe(1)
    expect(stdout.join('')).toContain('Result: failed')
  })

  test('lets an explicit CLI failOn never override project config', async () => {
    const root = await createProjectWithDiagnostic()
    await writeJson(join(root, 'doctor.config.json'), {
      rules: { 'component-event-payload-changed': 'error' },
      failOn: 'error'
    })

    const exitCode = await runCli(['--fail-on', 'never', root], {
      cwd: root,
      stdout: () => undefined,
      stderr: () => undefined
    })

    expect(exitCode).toBe(0)
  })

  test('applies failOnIncompleteCoverage from project config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-incomplete-config-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeJson(join(root, 'package.json'), {})
    await writeJson(join(root, 'doctor.config.json'), {
      failOnIncompleteCoverage: true
    })
    await writeFile(
      join(root, 'src/App.vue'),
      '<script setup lang="ts">const = broken</script><template><div /></template>',
      'utf8'
    )

    const exitCode = await runCli([root], {
      cwd: root,
      stdout: () => undefined,
      stderr: () => undefined
    })

    expect(exitCode).toBe(1)
  })

  test('lists diagnostic codes grouped by rule pack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-rules-'))
    const stdout: string[] = []
    try {
      const exitCode = await runCli(['rules', 'list'], {
        cwd: root,
        stdout: (message) => stdout.push(message),
        stderr: () => undefined
      }, {
        runDoctor: async () => {
          throw new Error('runDoctor must not be called for rules')
        },
        startInspector: async () => {
          throw new Error('startInspector must not be called for rules')
        }
      })

      expect(exitCode).toBe(0)
      expect(stdout.join('')).toContain('[vue]')
      expect(stdout.join('')).toContain('[component-library]')
      expect(stdout.join('')).toContain('vue-doctor rules explain <code>')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('lists and explains project custom ESLint rules without running Doctor analysis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-project-eslint-'))
    try {
      const eslintRequire = createRequire(new URL('../../rules-eslint/package.json', import.meta.url))
      await mkdir(join(root, 'node_modules'), { recursive: true })
      await symlink(dirname(eslintRequire.resolve('eslint/package.json')), join(root, 'node_modules/eslint'), 'dir')
      await mkdir(join(root, 'src'))
      await writeJson(join(root, 'package.json'), { name: 'fixture-app', type: 'module' })
      await writeFile(join(root, 'src/Example.js'), 'const value = 1;\n')
      await writeFile(join(root, 'eslint.config.mjs'), `export default [{
        files: ['src/**/*.js'],
        plugins: { team: { rules: { 'no-var': {
          meta: { schema: [], docs: { description: 'Use block-scoped project declarations' } },
          create() { return {} }
        } } } },
        rules: { 'team/no-var': 'warn' }
      }];\n`)
      const services = {
        runDoctor: vi.fn(async () => { throw new Error('rules commands must not run Doctor analysis') }),
        startInspector: vi.fn(async () => { throw new Error('rules commands must not start Inspector') })
      }
      const stdout: string[] = []
      const stderr: string[] = []
      const io = { cwd: root, stdout: (message: string) => stdout.push(message), stderr: (message: string) => stderr.push(message) }

      expect(await runCli(['rules', 'list', 'eslint', '--scope', 'src'], io, services)).toBe(0)
      expect(stdout.join('')).toContain('eslint/team/no-var')
      expect(stdout.join('')).toContain('Use block-scoped project declarations')
      stdout.length = 0
      expect(await runCli(['rules', 'explain', 'eslint/team/no-var', '--scope', 'src'], io, services)).toBe(0)
      expect(stdout.join('')).toContain('Use block-scoped project declarations')
      expect(stderr).toEqual([])
      expect(services.runDoctor).not.toHaveBeenCalled()
      expect(services.startInspector).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })



  test('ci install writes a GitHub Actions workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-ci-'))
    const stdout: string[] = []
    const exitCode = await runCli(['ci', 'install'], {
      cwd: root,
      stdout: (message) => stdout.push(message),
      stderr: () => {}
    })
    expect(exitCode).toBe(0)
    expect(stdout.join('')).toContain('.github/workflows/vue-doctor.yml')
    const workflow = await readFile(join(root, '.github/workflows/vue-doctor.yml'), 'utf8')
    expect(workflow).toContain('Vue Doctor')
    expect(workflow).toContain('--fail-on error')
  })


  test('install skill into project agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-cli-install-'))
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['install', '--agent', 'claude-code'], {
      cwd: root,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message)
    })
    expect(exitCode).toBe(0)
    expect(stdout.join('')).toContain('Installed for claude-code')
    const skill = await readFile(join(root, '.claude/skills/vue-doctor/SKILL.md'), 'utf8')
    expect(skill).toContain('Vue Doctor')
  })


})

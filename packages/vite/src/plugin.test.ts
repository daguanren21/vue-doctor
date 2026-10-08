import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComponentLibraryCoverage, Diagnostic, DoctorReport } from '@vue-doctor/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { vueDoctor } from './index.js'
import {
  createVueDoctorPlugin,
  inspectorBasePath,
  inspectorOpenPath,
  inspectorReportPath,
  inspectorSnippetPath
} from './plugin.js'

describe('vueDoctor Vite plugin', () => {
  test('defaults to serve-only diagnostics and does not inject app modules', () => {
    const plugin = vueDoctor()

    expect(plugin.name).toBe('vue-doctor')
    expect(plugin.apply).toBe('serve')
    expect(plugin.transform).toBeUndefined()
    expect(plugin.resolveId).toBeUndefined()
    expect(plugin.load).toBeUndefined()
  })

  test('supports build and both run modes without blocking build output', () => {
    expect(vueDoctor({ run: 'build' }).apply).toBe('build')
    expect(vueDoctor({ run: 'both' }).apply).toBeUndefined()
  })

  test('reports Doctor diagnostics as Vite warnings during build', async () => {
    const root = await createProjectWithIncompatibleComponentProp()
    const warnings: string[] = []
    const plugin = vueDoctor({ run: 'build' })

    const configResolved = plugin.configResolved as ((config: unknown) => void) | undefined
    if (typeof configResolved === 'function') {
      configResolved({ root })
    }

    expect(typeof plugin.buildStart).toBe('function')

    await (plugin.buildStart as (this: { warn: (message: string) => void }) => Promise<void>).call({
      warn(message: string) {
        warnings.push(message)
      }
    })

    expect(warnings).toEqual([
      expect.stringContaining('component-prop-type-mismatch')
    ])
    expect(warnings[0]).toContain('ElDatePickerV2')
    expect(warnings[0]).toContain('size')
  })

  test('limits build warnings to the configured scope', async () => {
    const root = await createProjectWithScopedDiagnostics()
    const warnings: string[] = []
    const plugin = vueDoctor({ run: 'build', scope: 'src/scoped' })

    const configResolved = plugin.configResolved as ((config: unknown) => void) | undefined
    if (typeof configResolved === 'function') {
      configResolved({ root })
    }

    await (plugin.buildStart as (this: { warn: (message: string) => void }) => Promise<void>).call({
      warn(message: string) {
        warnings.push(message)
      }
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('scoped-size')
    expect(warnings[0]).not.toContain('ignored-size')
  })

  test('keeps complete coverage silent while preserving diagnostic warnings', async () => {
    const report = createReport({
      coverageStatus: 'complete',
      libraries: [createLibraryCoverage('example-ui', 'complete')],
      diagnostics: [createDiagnostic()]
    })
    const warnings = await collectBuildWarnings(report)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[vue-doctor] WARNING component-event-unsupported')
    expect(warnings).not.toContainEqual(expect.stringContaining('[vue-doctor] COVERAGE'))
  })

  test('keeps info diagnostics in reports without flooding Vite warnings', async () => {
    const report = createReport({
      coverageStatus: 'complete',
      diagnostics: [
        createDiagnostic(),
        {
          ...createDiagnostic(),
          code: 'component-attribute-unverified',
          severity: 'info',
          message: 'ExampleButton attribute support is unverified.',
          confidence: 'low'
        }
      ]
    })

    const warnings = await collectBuildWarnings(report)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('component-event-unsupported')
    expect(warnings[0]).not.toContain('component-attribute-unverified')
  })

  test('emits one partial coverage warning separately from diagnostics', async () => {
    const report = createReport({
      coverageStatus: 'partial',
      libraries: [createLibraryCoverage(
        'example-ui',
        'partial',
        'component-library-contracts-unavailable'
      )],
      diagnostics: [createDiagnostic()]
    })
    report.coverage.componentLibraries[0]?.problems.push({
      code: 'component-library-contracts-unavailable',
      message: 'Duplicate coverage problem',
      evidence: []
    })
    const warnings = await collectBuildWarnings(report)
    const coverageWarnings = warnings.filter((warning) => warning.includes('[vue-doctor] COVERAGE'))
    const diagnosticWarnings = warnings.filter((warning) => warning.includes('[vue-doctor] WARNING'))

    expect(warnings).toHaveLength(2)
    expect(coverageWarnings).toHaveLength(1)
    expect(diagnosticWarnings).toHaveLength(1)
    expect(coverageWarnings[0]).toContain(
      '[vue-doctor] COVERAGE partial: 1 component library needs attention'
    )
    expect(coverageWarnings[0]).toContain(
      'example-ui: partial - component-library-contracts-unavailable'
    )
    expect(coverageWarnings[0]?.match(/component-library-contracts-unavailable/g)).toHaveLength(1)
    expect(warnings).toContainEqual(expect.stringContaining('component-event-unsupported'))
    expect(diagnosticWarnings).not.toContainEqual(expect.stringContaining(
      'WARNING component-library-contracts-unavailable:'
    ))
  })

  test('pluralizes one blocked coverage warning for multiple affected libraries', async () => {
    const report = createReport({
      coverageStatus: 'blocked',
      libraries: [
        createLibraryCoverage('example-ui', 'blocked', 'component-library-contracts-unavailable'),
        createLibraryCoverage('other-ui', 'partial', 'component-library-contracts-partial')
      ]
    })
    const warnings = await collectBuildWarnings(report)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      '[vue-doctor] COVERAGE blocked: 2 component libraries need attention'
    )
    expect(warnings[0]).toContain('example-ui: blocked - component-library-contracts-unavailable')
    expect(warnings[0]).toContain('other-ui: partial - component-library-contracts-partial')
  })

  test('describes source-only partial coverage without claiming a library needs attention', async () => {
    const report = createReport({ coverageStatus: 'partial' })
    report.coverage.source = {
      status: 'partial',
      scannedFileCount: 1,
      failedFiles: [{ file: '/fixture/src/Broken.vue', block: 'template', message: 'Unexpected token' }]
    }

    const warnings = await collectBuildWarnings(report)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[vue-doctor] COVERAGE partial: source scan needs attention')
    expect(warnings[0]).toContain('source: partial - 1 file failed to scan')
    expect(warnings[0]).toContain('/fixture/src/Broken.vue')
    expect(warnings[0]).not.toContain('0 component libraries need attention')
  })

  test('describes source-only blocked coverage as unavailable scanning', async () => {
    const report = createReport({ coverageStatus: 'blocked' })
    report.coverage.source = {
      status: 'blocked',
      scannedFileCount: 0,
      failedFiles: []
    }

    const warnings = await collectBuildWarnings(report)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[vue-doctor] COVERAGE blocked: source scanning is unavailable')
    expect(warnings[0]).toContain('source: blocked - scanning did not run')
    expect(warnings[0]).not.toContain('0 files failed to scan')
    expect(warnings[0]).not.toContain('0 component libraries')
  })

  test('registers one pre-history Inspector dispatcher in dev', () => {
    const registered: unknown[][] = []
    const plugin = vueDoctor({ inspector: true })
    const configureServer = plugin.configureServer

    expect(typeof configureServer).toBe('function')

    if (typeof configureServer !== 'function') {
      throw new Error('Expected configureServer to be a function')
    }

    ;(configureServer as (server: unknown) => void)({
      middlewares: {
        use(...args: unknown[]) {
          registered.push(args)
        }
      },
      config: {
        root: process.cwd()
      }
    } as never)

    expect(plugin.enforce).toBe('pre')
    expect(registered).toHaveLength(1)
    expect(registered[0]).toHaveLength(1)
    expect(registered[0]?.[0]).toBeTypeOf('function')
  })

  test('legacy report reads invoke the provider once per request after initial analysis', async () => {
    const report = createReport({ root: '/fixture', coverageStatus: 'partial' })
    const calls: unknown[] = []
    const plugin = createVueDoctorPlugin({ scope: 'src/widgets' }, { runDoctor: async options => { calls.push(options); return report } })
    const host = await registerInspectorServer(plugin, '/fixture')
    expect(calls).toHaveLength(1)
    const response = await fetch(new URL(inspectorReportPath, host.url))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(report)
    expect(calls).toEqual(Array.from({ length: 2 }, () => ({ root: '/fixture', scope: 'src/widgets' })))
  })

  test('rejects Vite snippet reads outside the configured project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-vite-root-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'vue-doctor-vite-outside-'))
    const outsideFile = join(outsideRoot, 'secret.txt')
    await writeFile(outsideFile, 'secret\n', 'utf8')
    const host = await registerInspectorServer(createVueDoctorPlugin({}, { runDoctor: async () => createReport({ root }) }), root)
    const url = new URL(inspectorSnippetPath, host.url)
    url.searchParams.set('file', outsideFile)
    url.searchParams.set('line', '1')
    const response = await fetch(url)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Source file is outside the project root.' })
  })

  test('rejects oversized Vite open-editor request bodies', async () => {
    const host = await registerInspectorServer(createVueDoctorPlugin({}, { runDoctor: async () => createReport() }))
    const response = await fetch(new URL(inspectorOpenPath, host.url), { method: 'POST', body: JSON.stringify({ editor: 'vscode', file: 'x'.repeat(17 * 1024) }) })
    expect(response.status).toBe(413)
  })

  test('legacy report failures return a JSON error and preserve the last completed snapshot', async () => {
    let reads = 0
    const report = createReport()
    const host = await registerInspectorServer(createVueDoctorPlugin({}, { runDoctor: async () => { if (++reads > 1) throw new Error('Doctor Run failed'); return report } }))
    const response = await fetch(new URL(inspectorReportPath, host.url))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Doctor Run failed' })
  })

  test('serves a presentation-only Hub and one portable iframe without embedding the report', async () => {
    const report = createReport({ root: '/must-not-be-serialized' })
    let runs = 0
    const host = await registerInspectorServer(createVueDoctorPlugin({}, { runDoctor: async () => { runs++; return report } }))
    const shell = await fetch(new URL(inspectorBasePath, host.url))
    expect(shell.status).toBe(200)
    const html = await shell.text()
    expect(html).toContain('type="module"')
    expect(html).not.toContain('/must-not-be-serialized')
    const frame = await fetch(new URL(`${inspectorBasePath}vue-doctor/`, host.url))
    const frameHtml = await frame.text()
    expect(frame.status).toBe(200)
    expect(frameHtml).toContain('./assets/inspector.js')
    expect(frameHtml).not.toContain(JSON.stringify(report))
    expect(runs).toBe(1)
  })

  test('redirects legacy Inspector links and forwards business history routes', async () => {
    const host = await registerInspectorServer(createVueDoctorPlugin({}, { runDoctor: async () => createReport() }))
    const legacy = await fetch(new URL('/__vue-doctor__/', host.url), { redirect: 'manual' })
    expect(legacy.status).toBe(308)
    expect(legacy.headers.get('location')).toBe(inspectorBasePath)
    const business = await fetch(new URL('/orders/123?tab=detail', host.url))
    expect(business.status).toBe(404)
    expect(await business.text()).toBe('business route')
  })
})

const activeHosts: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(activeHosts.splice(0).map(close => close())) })

async function registerInspectorServer(plugin: ReturnType<typeof createVueDoctorPlugin>, root = '/fixture') {
  let dispatcher: Function | undefined
  const server = createServer((request, response) => dispatcher!(request, response, () => response.writeHead(404).end('business route')))
  const post = (plugin.configureServer as Function)({
    middlewares: { use(handler: Function) { dispatcher = handler } },
    httpServer: server, config: { root, logger: { warn() {} } }
  })
  await post()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  activeHosts.push(async () => {
    await (plugin.closeBundle as Function)()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

async function collectBuildWarnings(report: DoctorReport): Promise<string[]> {
  const warnings: string[] = []
  const plugin = createVueDoctorPlugin({}, {
    runDoctor: async () => report
  })

  await (plugin.buildStart as (this: { warn: (message: string) => void }) => Promise<void>).call({
    warn(message: string) {
      warnings.push(message)
    }
  })

  return warnings
}

function createReport(options: {
  root?: string
  coverageStatus?: DoctorReport['coverage']['status']
  libraries?: ComponentLibraryCoverage[]
  diagnostics?: Diagnostic[]
} = {}): DoctorReport {
  const root = options.root ?? '/fixture'

  return {
    project: {
      root,
      vueVersion: '3.5.0',
      viteVersion: '7.0.0',
      vueFramework: 'vue3',
      uiLibraries: []
    },
    inventory: { root, packages: {} },
    coverage: {
      status: options.coverageStatus ?? 'complete',
      source: { status: 'complete', scannedFileCount: 1, failedFiles: [] },
      componentLibraries: options.libraries ?? []
    },
    diagnostics: options.diagnostics ?? []
  }
}

function createLibraryCoverage(
  packageName: string,
  status: ComponentLibraryCoverage['status'],
  problemCode?: ComponentLibraryCoverage['problems'][number]['code']
): ComponentLibraryCoverage {
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
      props: status === 'complete' ? 'known' : 'partial',
      events: status === 'complete' ? 'known' : 'partial',
      models: status === 'complete' ? 'known' : 'partial',
      slots: status === 'complete' ? 'known' : 'partial'
    },
    problems: problemCode
      ? [{ code: problemCode, message: `${packageName} coverage problem`, evidence: [] }]
      : []
  }
}

function createDiagnostic(): Diagnostic {
  return {
    code: 'component-event-unsupported',
    severity: 'warning',
    message: 'ExampleButton does not declare event "missing".',
    file: '/fixture/src/App.vue',
    evidence: [],
    fixes: [],
    confidence: 'high'
  }
}

async function createProjectWithIncompatibleComponentProp() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-vite-'))
  const libraryRoot = join(root, 'node_modules/example-ui')

  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(libraryRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    dependencies: {
      'example-ui': '1.2.0'
    }
  })
  await writeJson(join(libraryRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    'web-types': './web-types.json'
  })
  await writeJson(join(libraryRoot, 'web-types.json'), {
    framework: 'vue',
    name: 'example-ui',
    version: '1.2.3',
    contributions: {
      html: {
        'vue-components': [
          {
            name: 'ElDatePickerV2',
            props: [{ name: 'size', type: 'number' }]
          }
        ]
      }
    }
  })
  await writeFile(
    join(root, 'src/App.vue'),
    `<script setup>
import { ElDatePickerV2 } from 'example-ui'
</script>
<template>
  <ElDatePickerV2 size="large" />
</template>
`,
    'utf8'
  )

  return root
}

async function createProjectWithScopedDiagnostics() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-vite-scoped-'))
  const libraryRoot = join(root, 'node_modules/example-ui')

  await mkdir(join(root, 'src/scoped'), { recursive: true })
  await mkdir(join(root, 'src/ignored'), { recursive: true })
  await mkdir(libraryRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    dependencies: {
      'example-ui': '1.2.0'
    }
  })
  await writeJson(join(libraryRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    'web-types': './web-types.json'
  })
  await writeJson(join(libraryRoot, 'web-types.json'), {
    framework: 'vue',
    name: 'example-ui',
    version: '1.2.3',
    contributions: {
      html: {
        'vue-components': [
          {
            name: 'ExampleButton',
            props: [{ name: 'scoped-size', type: 'number' }, { name: 'ignored-size', type: 'number' }]
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
  <ExampleButton scoped-size="large" />
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
  <ExampleButton ignored-size="large" />
</template>
`,
    'utf8'
  )

  return root
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import type { DoctorReport } from '@vue-doctor/core'

const host = vi.hoisted(() => {
  const backend = {
    definition: { id: 'vue-doctor' },
    compatibilityMiddleware: vi.fn(),
    store: { getSnapshot: () => ({ snapshotId: 'fixture' }), getReport: () => ({}) },
    close: vi.fn(async () => {})
  }
  return {
    backend,
    createBackend: vi.fn(() => backend),
    createHost: vi.fn(async () => ({ ...backend, hub: { close: vi.fn(async () => {}) }, closeTransport: vi.fn(async () => {}), nodeMiddleware: vi.fn() }))
  }
})
vi.mock('@vue-doctor/inspector/host', () => ({
  createInspectorBackend: host.createBackend,
  createInspectorHost: host.createHost
}))
import { createVueDoctorPlugin } from './vite.js'

const report: DoctorReport = {
  project: { root: '/fixture', vueFramework: 'vue3', uiLibraries: [] },
  inventory: { root: '/fixture', packages: {} },
  coverage: { status: 'complete', source: { status: 'complete', scannedFileCount: 0, failedFiles: [] }, componentLibraries: [] },
  diagnostics: []
}
function server() {
  return { config: { root: '/fixture', logger: { warn: vi.fn() } }, watcher: new EventEmitter(), httpServer: new EventEmitter(), middlewares: { use: vi.fn() } }
}

test('native DevTools installs one definition and reuses the initial analysis for warnings', async () => {
  vi.clearAllMocks()
  const run = vi.fn(async () => report)
  const close = vi.fn(async () => {})
  const plugin = createVueDoctorPlugin({}, { runDoctor: run, createAnalysisSession: () => ({ run, close, invalidate: vi.fn() }) })
  const install = vi.fn(async () => {})
  const fixture = server()
  const post = (plugin.configureServer as Function)(fixture)
  await plugin.devtools.setup({ install })
  await post()
  await (plugin.buildStart as Function).call({ warn: vi.fn() })
  expect(run).toHaveBeenCalledTimes(1)
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ id: 'vue-doctor', setup: expect.any(Function) }), { dock: { frameId: 'vue-doctor', subTabs: { protocol: 'postmessage' } } })
  expect(host.createHost).not.toHaveBeenCalled()
  fixture.middlewares.use.mock.calls[0]![0]({}, {}, vi.fn())
  expect(host.backend.compatibilityMiddleware).toHaveBeenCalledTimes(1)
  await Promise.all([(plugin.closeBundle as Function)(), (plugin.closeBundle as Function)()])
  expect(host.backend.close).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
  expect(fixture.watcher.listenerCount('all')).toBe(0)
})

test('a late native host closes only the fallback transport while keeping its backend', async () => {
  vi.clearAllMocks()
  const plugin = createVueDoctorPlugin({}, { runDoctor: async () => report })
  const fixture = server()
  await (plugin.configureServer as Function)(fixture)()
  const fallback = await host.createHost.mock.results[0]!.value
  await plugin.devtools.setup({ install: vi.fn(async () => {}) })
  expect(fallback.closeTransport).toHaveBeenCalledTimes(1)
  expect(host.createBackend).toHaveBeenCalledTimes(1)
  expect(host.backend.close).not.toHaveBeenCalled()
  fixture.middlewares.use.mock.calls[0]![0]({}, {}, vi.fn())
  expect(host.backend.compatibilityMiddleware).toHaveBeenCalledTimes(1)
  expect(fallback.nodeMiddleware).not.toHaveBeenCalled()
  await (plugin.closeBundle as Function)()
})

test('a failed native installation leaves the standalone transport available', async () => {
  vi.clearAllMocks()
  const plugin = createVueDoctorPlugin({}, { runDoctor: async () => report })
  const fixture = server()
  await (plugin.configureServer as Function)(fixture)()
  const fallback = await host.createHost.mock.results[0]!.value
  await expect(plugin.devtools.setup({ install: async () => { throw new Error('host unavailable') } })).rejects.toThrow('host unavailable')
  fixture.middlewares.use.mock.calls[0]![0]({}, {}, vi.fn())
  expect(fallback.closeTransport).not.toHaveBeenCalled()
  expect(fallback.nodeMiddleware).toHaveBeenCalledTimes(1)
  await (plugin.closeBundle as Function)()
})

test('a failed first analysis can recover on a later native setup', async () => {
  vi.clearAllMocks()
  const run = vi.fn<() => Promise<DoctorReport>>().mockRejectedValueOnce(new Error('temporary scan failure')).mockResolvedValue(report)
  const plugin = createVueDoctorPlugin({}, { runDoctor: run })
  const install = vi.fn(async () => {})
  await expect(plugin.devtools.setup({ install })).rejects.toThrow('temporary scan failure')
  await plugin.devtools.setup({ install })
  expect(run).toHaveBeenCalledTimes(2)
  expect(install).toHaveBeenCalledTimes(1)
  expect(host.createBackend).toHaveBeenCalledTimes(1)
  await (plugin.closeBundle as Function)()
})

test('disabling Inspector keeps watchers but does not install any frame', async () => {
  vi.clearAllMocks()
  const invalidate = vi.fn()
  const plugin = createVueDoctorPlugin({ inspector: false }, {
    runDoctor: async () => report,
    createAnalysisSession: () => ({ run: async () => report, invalidate, close: async () => {} })
  })
  const fixture = server()
  expect((plugin.configureServer as Function)(fixture)).toBeUndefined()
  const install = vi.fn(async () => {})
  await plugin.devtools.setup({ install })
  fixture.watcher.emit('all', 'change', '/fixture/App.vue')
  expect(invalidate).toHaveBeenCalledWith('/fixture/App.vue')
  expect(install).not.toHaveBeenCalled()
  expect(host.createBackend).not.toHaveBeenCalled()
  await (plugin.closeBundle as Function)()
})

test('shutdown prevents a deferred native installation from adding subscriptions', async () => {
  vi.clearAllMocks()
  const plugin = createVueDoctorPlugin({}, { runDoctor: async () => report })
  let release!: () => void
  let installed: Parameters<Parameters<typeof plugin.devtools.setup>[0]['install']>[0] | undefined
  const pending = new Promise<void>(resolve => { release = resolve })
  const setup = plugin.devtools.setup({ install: async (definition) => { installed = definition; await pending } })
  await vi.waitFor(() => expect(installed).toBeDefined())
  await (plugin.closeBundle as Function)()
  const definition = installed!
  await expect(definition.setup({} as Parameters<typeof definition.setup>[0])).rejects.toThrow('closed')
  const rejection = expect(setup).rejects.toThrow('closed')
  release()
  await rejection
  expect(host.backend.close).toHaveBeenCalledTimes(1)
})

test('a later native host still serves compatibility APIs after fallback startup failure', async () => {
  vi.clearAllMocks()
  host.createHost.mockRejectedValueOnce(new Error('temporary transport failure'))
  const plugin = createVueDoctorPlugin({}, { runDoctor: async () => report })
  const fixture = server()
  await (plugin.configureServer as Function)(fixture)()
  const next = vi.fn()
  fixture.middlewares.use.mock.calls[0]![0]({}, {}, next)
  expect(next).toHaveBeenCalledTimes(1)
  await plugin.devtools.setup({ install: async () => {} })
  fixture.middlewares.use.mock.calls[0]![0]({}, {}, next)
  expect(host.backend.compatibilityMiddleware).toHaveBeenCalledTimes(1)
  await (plugin.closeBundle as Function)()
})

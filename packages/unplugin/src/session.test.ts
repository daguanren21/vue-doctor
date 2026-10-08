import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import type { DoctorReport } from '@vue-doctor/core'
import { createHostDoctorSession } from './session.js'
import { createVueDoctorPlugin } from './vite.js'

const report: DoctorReport = {
  project: { root: '/fixture', vueFramework: 'unknown', uiLibraries: [] },
  inventory: { root: '/fixture', packages: {} },
  coverage: { status: 'complete', source: { status: 'complete', scannedFileCount: 0, failedFiles: [] }, componentLibraries: [] },
  diagnostics: []
}

test('custom run services share in-flight work and never cache completed reports', async () => {
  const runDoctor = vi.fn(async () => report)
  const session = createHostDoctorSession({ runDoctor }, { root: '/fixture' })
  const first = session.run()
  expect(session.run()).toBe(first)
  await first
  await session.run()
  expect(runDoctor).toHaveBeenCalledTimes(2)
  await session.close()
  await expect(session.run()).rejects.toThrow('closed')
})

test('the Vite adapter invalidates its owned session and removes listeners on shutdown', async () => {
  const watcher = new EventEmitter()
  const httpServer = new EventEmitter()
  const invalidate = vi.fn()
  const close = vi.fn(async () => {})
  const createAnalysisSession = vi.fn(() => ({ run: async () => report, invalidate, close }))
  const plugin = createVueDoctorPlugin({ inspector: false }, { runDoctor: async () => report, createAnalysisSession })
  const configure = plugin.configureServer as (server: unknown) => void
  configure({ config: { root: '/fixture' }, watcher, httpServer })
  watcher.emit('all', 'change', '/fixture/App.vue')
  expect(createAnalysisSession).toHaveBeenCalledTimes(1)
  expect(invalidate).toHaveBeenCalledWith('/fixture/App.vue')
  await (plugin.buildStart as (this: unknown) => Promise<void>).call({ warn: vi.fn() })
  expect(createAnalysisSession).toHaveBeenCalledTimes(1)
  await (plugin.closeBundle as () => Promise<void>)()
  expect(close).toHaveBeenCalledTimes(1)
  expect(watcher.listenerCount('all')).toBe(0)
  expect(httpServer.listenerCount('close')).toBe(0)
})

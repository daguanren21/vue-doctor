import { effectScope } from 'vue'
import { expect, test, vi } from 'vitest'
import { useInspectorReport } from './useInspectorReport'

const legacy = {
  project: { root: '/project', vueFramework: 'vue3', uiLibraries: [] },
  inventory: { root: '/project', packages: {} },
  coverage: { status: 'complete', source: { status: 'complete', scannedFileCount: 0, failedFiles: [] }, componentLibraries: [] },
  diagnostics: []
}
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

test('loads legacy reports and rejects future versions with a recoverable error', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(legacy))
    .mockResolvedValueOnce(response({ ...legacy, schemaVersion: 2 }))
    .mockResolvedValueOnce(response(legacy))
  const scope = effectScope()
  const inspector = scope.run(() => useInspectorReport('/report', request))!
  await inspector.loadReport()
  expect(inspector.report.value?.project.root).toBe('/project')
  await inspector.loadReport()
  expect(inspector.report.value).toBeNull()
  expect(inspector.error.value).toContain('schema version')
  await inspector.loadReport()
  expect(inspector.error.value).toBeUndefined()
  expect(inspector.loading.value).toBe(false)
  scope.stop()
})

test('an older response cannot replace a newer refresh even if transport ignores abort', async () => {
  let resolveOld!: (response: Response) => void
  const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce(response({ ...legacy, project: { ...legacy.project, root: '/new' } }))
  const scope = effectScope()
  const inspector = scope.run(() => useInspectorReport('/report', request))!
  const old = inspector.loadReport()
  await inspector.loadReport()
  resolveOld(response(legacy))
  await old
  expect(inspector.report.value?.project.root).toBe('/new')
  expect(inspector.error.value).toBeUndefined()
  expect(inspector.loading.value).toBe(false)
  expect((request.mock.calls[0]![1]?.signal as AbortSignal).aborted).toBe(true)
  scope.stop()
})

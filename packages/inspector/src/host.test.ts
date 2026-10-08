import { expect, test } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createUi } from '@devframes/hub-ui'
import type { DoctorReport } from '@vue-doctor/core'
import { createInspectorBackend, createInspectorHost } from './host.js'

const inspectorClientAssets = fileURLToPath(new URL('../../inspector-ui/dist/', import.meta.url))
const readClientAsset = async (name: string) => name === 'favicon.svg'
  ? { body: '<svg data-fixture="doctor" />', contentType: 'image/svg+xml' }
  : undefined

const report: DoctorReport = {
  project: { root: '/fixture', vueFramework: 'vue3', uiLibraries: [] },
  inventory: { root: '/fixture', packages: {} },
  coverage: { status: 'complete', source: { status: 'complete', scannedFileCount: 0, failedFiles: [] }, componentLibraries: [] },
  diagnostics: []
}

test('failed setup detaches its observer from a reused backend', async () => {
  const backend = createInspectorBackend({ report, clientAssets: inspectorClientAssets, run: async () => report })
  const setup = backend.definition.setup
  let state: { value(): { revision: number } } | undefined
  backend.definition.setup = async (context) => {
    await setup(context)
    state = await context.scope('vue-doctor').rpc.sharedState('state')
    throw new Error('fixture setup failed after subscription')
  }
  await expect(createInspectorHost({ backend, hubUi: createUi(), auth: false })).rejects.toThrow('fixture setup failed')
  const revision = state!.value().revision
  await backend.store.run()
  expect(state!.value().revision).toBe(revision)
  await backend.close()
})

test('a custom Hub base serves exact relative SPA asset URLs', async () => {
  let host: Awaited<ReturnType<typeof createInspectorHost>> | undefined
  const server = createServer((request, response) => host!.nodeMiddleware(request, response, () => response.writeHead(404).end()))
  try {
    host = await createInspectorHost({ report, clientAssets: inspectorClientAssets, server, base: '/native-tools/', hubUi: createUi(), auth: false })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as { port: number }
    const pageUrl = `http://127.0.0.1:${address.port}/native-tools/vue-doctor/`
    const response = await fetch(pageUrl)
    expect(response.status).toBe(200)
    const html = await response.text()
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/gu)].map(match => new URL(match[1]!, pageUrl))
    expect(assets.length).toBeGreaterThanOrEqual(2)
    for (const asset of assets) {
      expect(asset.pathname).toContain('/native-tools/vue-doctor/assets/')
      const assetResponse = await fetch(asset)
      expect(assetResponse.status).toBe(200)
      await assetResponse.arrayBuffer()
    }
  } finally {
    await host?.close()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('closing a fallback mount detaches its shared state without closing the native backend', async () => {
  const backend = createInspectorBackend({ clientAssets: inspectorClientAssets, report, run: async () => ({ ...report, run: { status: 'complete', generation: 2, target: { mode: 'project', scopes: [], files: [] } } }) })
  const fallback = await createInspectorHost({ backend, hubUi: createUi(), auth: false })
  const native = await createInspectorHost({ backend, base: '/native-tools/', hubUi: createUi(), auth: false })
  try {
    const fallbackState = await (await fallback.hub.context).scope('vue-doctor').rpc.sharedState('state')
    const nativeState = await (await native.hub.context).scope('vue-doctor').rpc.sharedState('state')
    const revision = fallbackState.value().revision
    await fallback.closeTransport()
    await backend.store.run()
    expect(fallbackState.value().revision).toBe(revision)
    expect(nativeState.value().revision).toBe(backend.store.getSharedState().revision)
    expect(backend.store.getSnapshot().run.status).toBe('idle')
  } finally {
    await Promise.all([fallback.close(), native.close()])
  }
})

test('a reused backend serves compatibility APIs and injected branding assets at its host mount base', async () => {
  const backend = createInspectorBackend({ clientAssets: inspectorClientAssets, readClientAsset, report })
  const host = await createInspectorHost({ backend, base: '/native-tools/', hubUi: createUi(), auth: false })
  const request = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    let status = 0
    const response = {
      writeHead(code: number) { status = code },
      end(body: string | Buffer) { resolve({ status, body: String(body) }) }
    } as unknown as ServerResponse
    host.nodeMiddleware({ url: path, method: 'GET', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage, response, (error) => reject(error ?? new Error('Route was not handled')))
  })
  try {
    const result = await request('/native-tools/api/report.json')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual(report)
    const favicon = await request('/native-tools/favicon.svg')
    expect(favicon.status).toBe(200)
    expect(favicon.body).toContain('<svg')
  } finally { await host.close() }
})

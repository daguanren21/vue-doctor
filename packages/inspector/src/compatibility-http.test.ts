import type { IncomingMessage } from 'node:http'
import { expect, test } from 'vitest'
import type { ServerResponse } from 'node:http'
import { createInspectorCompatibilityMiddleware, isLocalCompatibilityRequest } from './compatibility-http.js'
import type { DoctorReport } from '@vue-doctor/core'

function request(peer: string, host: string, origin?: string): IncomingMessage {
  return { socket: { remoteAddress: peer }, headers: { host, ...(origin ? { origin } : {}) } } as IncomingMessage
}

test('legacy APIs reject remote peers, DNS rebinding hosts and cross-origin editor requests', () => {
  expect(isLocalCompatibilityRequest(request('127.0.0.1', '127.0.0.1:3000'))).toBe(true)
  expect(isLocalCompatibilityRequest(request('::1', 'localhost:3000', 'http://localhost:3000'))).toBe(true)
  expect(isLocalCompatibilityRequest(request('192.0.2.1', 'localhost:3000'))).toBe(false)
  expect(isLocalCompatibilityRequest(request('127.0.0.1', '127.attacker.example:3000'))).toBe(false)
  expect(isLocalCompatibilityRequest(request('127.0.0.1', 'localhost:3000', 'https://attacker.example'))).toBe(false)
  expect(isLocalCompatibilityRequest(request('127.0.0.1', 'localhost:3000', 'http://localhost:3001'))).toBe(false)
})

const report: DoctorReport = {
  project: { root: '/fixture', vueFramework: 'vue3', uiLibraries: [] },
  inventory: { root: '/fixture', packages: {} },
  coverage: { status: 'complete', source: { status: 'complete', scannedFileCount: 0, failedFiles: [] }, componentLibraries: [] },
  diagnostics: []
}

test('serves compatibility assets only through the host-owned UI adapter', async () => {
  const middleware = createInspectorCompatibilityMiddleware({
    report,
    readClientAsset: async name => name === 'favicon.svg'
      ? { body: '<svg />', contentType: 'image/svg+xml' }
      : undefined
  })
  let status = 0
  let contentType = ''
  let body = ''
  const response = {
    writeHead(code: number, headers?: Record<string, string>) {
      status = code
      contentType = headers?.['content-type'] ?? ''
    },
    end(value?: string | Uint8Array) { body = value ? String(value) : '' }
  } as unknown as ServerResponse
  middleware({
    url: '/vue-doctor/favicon.svg',
    method: 'GET',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' }
  } as IncomingMessage, response)
  await new Promise(resolve => setImmediate(resolve))
  expect({ status, contentType, body }).toEqual({ status: 200, contentType: 'image/svg+xml', body: '<svg />' })
})

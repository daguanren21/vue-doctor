import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderInspectorHtml } from '../../inspector-ui/assets.mjs'
import { createInspectorHost } from '../dist/host.mjs'

const workspace = '/workspace/example-app/'
const uiDist = join(dirname(fileURLToPath(import.meta.url)), '../../inspector-ui/dist')

export const createErrorTokenStore = (maxTokens = 64) => {
  const attempts = new Map()

  return {
    register(token) {
      attempts.delete(token)
      while (attempts.size >= maxTokens) {
        attempts.delete(attempts.keys().next().value)
      }
      attempts.set(token, 0)
    },
    shouldFail(token) {
      const attempt = attempts.get(token)
      if (attempt === 0) {
        attempts.set(token, 1)
        return true
      }
      if (attempt === 1) attempts.delete(token)
      return false
    },
    size() {
      return attempts.size
    }
  }
}

const coverageLibrary = (status) => ({
  package: {
    dependencyName: 'example-ui',
    canonicalName: 'example-ui',
    installedVersion: '2.4.0',
    declaredVersion: '^2.0.0',
    importRoots: ['example-ui'],
    source: 'installed'
  },
  status,
  contractSources: status === 'blocked' ? [] : [{
    kind: 'component-contract',
    source: 'typescript',
    file: `${workspace}node_modules/example-ui/dist/index.d.ts`
  }],
  detectedUsageCount: 3,
  matchedUsageCount: status === 'blocked' ? 0 : 3,
  dimensions: {
    props: status === 'blocked' ? 'unknown' : 'known',
    events: status === 'blocked' ? 'unknown' : 'known',
    models: status === 'complete' ? 'known' : status === 'partial' ? 'partial' : 'unknown',
    slots: status === 'blocked' ? 'unknown' : 'known'
  },
  problems: status === 'complete' ? [] : [{
    code: status === 'blocked'
      ? 'component-library-contracts-unavailable'
      : 'component-library-contracts-partial',
    message: status === 'blocked'
      ? 'No usable component contracts were found.'
      : 'Model contracts are incomplete.',
    evidence: [{
      kind: 'package-manifest',
      file: `${workspace}node_modules/example-ui/package.json`
    }]
  }]
})

const diagnostics = [{
  code: 'vue-v-for-missing-key',
  severity: 'warning',
  confidence: 'high',
  message: 'v-for is missing a :key binding in UserList.vue.',
  file: `${workspace}src/components/UserList.vue`,
  evidence: [
    { kind: 'template', file: `${workspace}src/components/UserList.vue`, line: 17, column: 10 }
  ],
  fixes: [{ title: 'Bind a stable key', description: 'Add :key="user.id" to the v-for element.' }]
}, {
  code: 'component-library-unsupported-prop',
  severity: 'error',
  confidence: 'high',
  message: 'ExampleButton from example-ui@2.4.0 does not declare the ghost prop.',
  file: `${workspace}src/features/orders/OrderActions.vue`,
  evidence: [
    { kind: 'source-prop', file: `${workspace}src/features/orders/OrderActions.vue`, line: 18, column: 5 },
    { kind: 'component-contract', file: `${workspace}node_modules/example-ui/dist/index.d.ts` }
  ],
  fixes: [{ title: 'Remove ghost', description: 'Use a prop declared by ExampleButton.' }]
}, {
  code: 'component-library-unsupported-event',
  severity: 'warning',
  confidence: 'high',
  message: 'ExampleModal from example-ui@2.4.0 does not declare the confirm-all event.',
  file: `${workspace}src/features/orders/OrderDialog.vue`,
  evidence: [
    { kind: 'source-event', file: `${workspace}src/features/orders/OrderDialog.vue`, line: 27, column: 5 },
    { kind: 'component-contract', file: `${workspace}node_modules/example-ui/dist/index.d.ts` }
  ],
  fixes: [{ title: 'Use confirm', description: 'Listen for the declared confirm event.' }]
}, {
  code: 'component-library-unsupported-slot',
  severity: 'info',
  confidence: 'medium',
  message: 'ExamplePanel from example-ui@2.4.0 does not declare the actions slot.',
  file: `${workspace}src/App.vue`,
  evidence: [
    { kind: 'source-slot', file: `${workspace}src/App.vue`, line: 9, column: 3 },
    { kind: 'component-contract', file: `${workspace}node_modules/example-ui/dist/index.d.ts` }
  ],
  fixes: [{ title: 'Use the default slot', description: 'Move the panel actions into a declared slot.' }]
}]

export const reportFor = (state) => {
  const coverageStatus = state === 'partial' ? 'partial' : state === 'blocked' ? 'blocked' : 'complete'
  const diagnosticsForState = state === 'findings' || state === 'partial' ? diagnostics : []
  return {
    project: {
      root: workspace.slice(0, -1),
      name: 'example-app',
      vueFramework: 'vue3',
      uiLibraries: ['example-ui']
    },
    inventory: {
      packages: {
        vue: { version: '3.5.0' },
        vite: { version: '7.0.0' },
        'example-ui': { version: '2.4.0' }
      }
    },
    coverage: {
      status: coverageStatus,
      componentLibraries: [coverageLibrary(coverageStatus)],
      source: { status: 'complete', scannedFileCount: 12, failedFiles: [] }
    },
    diagnostics: diagnosticsForState
  }
}

const contentType = (name) => {
  if (name.endsWith('.css')) return 'text/css; charset=utf-8'
  if (name.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}

export const createPreviewRequestHandler = ({
  errorTokens = createErrorTokenStore(),
  tokenFactory = randomUUID,
  loadingDelay = 1400
} = {}) => {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const segments = url.pathname.split('/').filter(Boolean)

    // Path params: /api/report/:state[/:token]
    if (segments[0] === 'api' && segments[1] === 'report') {
      const state = segments[2] ?? 'findings'
      const token = segments[3] ?? ''
      if (state === 'loading') await new Promise((resolve) => setTimeout(resolve, loadingDelay))
      if (state === 'error' && errorTokens.shouldFail(token)) {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'Preview transport failure' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(reportFor(state === 'error' ? 'findings' : state)))
      return
    }

    // Snippet preview: /api/snippet?file=...&line=...
    if (segments[0] === 'api' && segments[1] === 'snippet') {
      const file = url.searchParams.get('file') ?? ''
      const line = Number(url.searchParams.get('line') ?? '1')
      const column = url.searchParams.get('column') ? Number(url.searchParams.get('column')) : undefined
      const hitText = file.includes('OrderActions')
        ? '  <ExampleButton ghost @click="submit">'
        : file.includes('OrderDialog')
          ? '  <ExampleModal @confirm-all="onConfirm">'
          : file.includes('UserList')
            ? '  <li v-for="user in users">'
            : file.includes('App.vue')
              ? '  <ExamplePanel><template #actions>…</template></ExamplePanel>'
              : '  // source line'
      const suggested = file.includes('OrderDialog')
        ? '  <ExampleModal @confirm="onConfirm">'
        : file.includes('UserList')
          ? '  <li v-for="user in users" :key="user.id">'
          : null
      const lines = [
        { number: Math.max(1, line - 1), text: '  // surrounding context', kind: 'context' },
        { number: line, text: hitText, kind: 'hit' },
        suggested
          ? { number: '+', text: suggested, kind: 'suggested' }
          : { number: line + 1, text: '  // …', kind: 'context' }
      ]
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ file, line, column, lines }))
      return
    }

    // Vue SPA assets: /vue-doctor/assets/*
    if (segments[0] === 'vue-doctor' && segments[1] === 'assets' && segments[2]) {
      const assetName = segments.slice(2).join('/')
      if (assetName.includes('..')) {
        response.writeHead(404).end('Not found')
        return
      }
      try {
        const body = await readFile(join(uiDist, 'assets', assetName))
        response.writeHead(200, {
          'content-type': contentType(assetName),
          'cache-control': 'public, max-age=31536000, immutable'
        })
        response.end(body)
        return
      } catch {
        response.writeHead(404).end('Not found')
        return
      }
    }

    // Favicon: /vue-doctor/favicon.svg
    if (segments[0] === 'vue-doctor' && segments[1] === 'favicon.svg') {
      try {
        const body = await readFile(join(uiDist, 'favicon.svg'))
        response.writeHead(200, {
          'content-type': 'image/svg+xml',
          'cache-control': 'no-store'
        })
        response.end(body)
        return
      } catch {
        response.writeHead(404).end('Not found')
        return
      }
    }

    // Page path params: / | /findings | /clean | /error | /partial | /blocked | /loading
    const pageState = segments.length === 0
      ? 'findings'
      : segments.length === 1
        ? segments[0]
        : null

    if (pageState) {
      const token = pageState === 'error' ? tokenFactory() : ''
      if (token) errorTokens.register(token)
      const reportEndpoint = token
        ? `/api/report/${encodeURIComponent(pageState)}/${encodeURIComponent(token)}`
        : `/api/report/${encodeURIComponent(pageState)}`
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(renderInspectorHtml({
        reportEndpoint,
        openEditorEndpoint: '/api/open'
      }))
      return
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  }
}

export const startPreview = async ({ state = 'findings' } = {}) => {
  let host
  const server = createServer((request, response) => host.nodeMiddleware(request, response, () => {
    response.writeHead(404).end('Not found')
  }))
  let attempts = 0
  const getReport = async () => {
    if (state === 'error' && attempts++ === 0) throw new Error('Preview refresh failed. Try again.')
    if (state === 'loading') await new Promise((resolve) => setTimeout(resolve, 1500))
    return reportFor(state)
  }
  host = await createInspectorHost({ report: reportFor(state), getReport, server, auth: false, clientAssets: uiDist })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolve)
  })
  const address = server.address()
  console.log(`Vue Doctor Inspector preview: http://127.0.0.1:${address.port}/vue-doctor/`)
  const close = async () => { await host.close(); server.close(() => process.exit(0)) }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  return server
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) await startPreview({ state: process.argv.find((value) => value.startsWith('--state='))?.slice(8) ?? 'findings' })

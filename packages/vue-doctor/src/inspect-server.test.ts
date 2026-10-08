import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DoctorReport } from '@vue-doctor/core'
import { describe, expect, test, vi } from 'vitest'
import { getBrowserCommand, getEditorCommand, startInspectorServer } from './inspect-server.js'

const report: DoctorReport = {
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
  coverage: {
    status: 'complete',
    source: { status: 'complete', scannedFileCount: 1, failedFiles: [] },
    componentLibraries: []
  },
  diagnostics: []
}

describe('startInspectorServer', () => {
  test('refreshes an analysis provider and releases it once when the server closes', async () => {
    let generation = 0
    const onClose = vi.fn(async () => {})
    const server = await startInspectorServer({ report, open: false, port: 0, onClose,
      getReport: async () => ({ ...report, run: { status: 'complete', generation: ++generation,
        target: { mode: 'project', scopes: [], files: [] } } })
    })
    try {
      const first = await (await fetch(new URL('api/report.json', server.url))).json() as { run: { generation: number } }
      const second = await (await fetch(new URL('api/report.json', server.url))).json() as { run: { generation: number } }
      expect(first.run.generation).toBe(1)
      expect(second.run.generation).toBe(2)
    } finally {
      await Promise.all([server.close(), server.close()])
    }
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('returns a report-provider error and can recover on a later refresh', async () => {
    const getReport = vi.fn<() => Promise<DoctorReport>>().mockRejectedValueOnce(new Error('Unknown Doctor rule code.'))
      .mockResolvedValueOnce(report)
    const server = await startInspectorServer({ report, open: false, port: 0, getReport })
    try {
      const failed = await fetch(new URL('api/report.json', server.url))
      expect(failed.status).toBe(500)
      expect(((await failed.json()) as { error: string }).error).toContain('Unknown Doctor rule')
      expect(await (await fetch(new URL('api/report.json', server.url))).json()).toEqual(report)
    } finally { await server.close() }
  })

  test('serves the Inspector HTML and exact completed report on loopback', async () => {
    const server = await startInspectorServer({ report, open: false, port: 0 })

    try {
      const htmlResponse = await fetch(server.url)
      const reportResponse = await fetch(new URL('api/report.json', server.url))

      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vue-doctor\/$/)
      expect(htmlResponse.headers.get('content-type')).toContain('text/html')
      expect(htmlResponse.headers.get('cache-control')).toBe('no-store')
      const inspectorHtml = await htmlResponse.text()
      expect(inspectorHtml).toContain('type="module"')
      const metadata = await (await fetch(new URL('__connection.json', server.url))).json()
      expect(metadata).toMatchObject({ configs: { ui: { branding: { windowTitle: 'Vue Doctor Inspector' } } } })
      const frame = await fetch(new URL('vue-doctor/', server.url))
      expect(frame.headers.get('content-type')).toContain('text/html')
      expect(await frame.text()).toContain('inspector.js')
      expect(reportResponse.headers.get('content-type')).toContain('application/json')
      expect(reportResponse.headers.get('cache-control')).toBe('no-store')
      expect(await reportResponse.json()).toEqual(report)
    } finally {
      await server.close()
    }
  })

  test('advertises a browser-independent MCP endpoint and serves its bounded Node tools', async () => {
    const server = await startInspectorServer({ report, open: false, port: 0 })
    try {
      const connection = await (await fetch(new URL('__connection.json', server.url))).json() as {
        mcp: { path: string }
      }
      expect(connection.mcp.path).toBe('__mcp')
      const endpoint = new URL(connection.mcp.path, server.url)
      const origin = new URL(server.url).origin
      const initialized = await mcpPost(endpoint, origin, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vue-doctor-test', version: '1.0.0' } }
      })
      expect(initialized.body).toMatchObject({ result: { serverInfo: { name: 'Vue Doctor' } } })
      await mcpPost(endpoint, origin, { jsonrpc: '2.0', method: 'notifications/initialized' }, initialized.sessionId)
      const listed = await mcpPost(endpoint, origin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, initialized.sessionId)
      const names = (listed.body.result.tools as Array<{ name: string }>).map(tool => tool.name)
      expect(names).toContain('vue-doctor_get-overview')
      expect(names).toContain('vue-doctor_rescan')
      expect(names).not.toContain('vue-doctor_openEditor')
      expect(names).not.toContain('vue-doctor_exportReport')
      const called = await mcpPost(endpoint, origin, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'vue-doctor_get-overview', arguments: {} }
      }, initialized.sessionId)
      expect(called.body).toMatchObject({ result: { structuredContent: { ok: true, coverageStatus: 'complete', clean: true } } })
      const resourceList = await mcpPost(endpoint, origin, {
        jsonrpc: '2.0', id: 4, method: 'resources/list', params: {}
      }, initialized.sessionId)
      const resourceUris = (resourceList.body.result.resources as Array<{ uri: string }>)
        .map(resource => resource.uri)
        .filter(uri => uri.startsWith('devframe://resource/vue-doctor'))
      expect(resourceUris).toEqual([
        'devframe://resource/vue-doctor%3Ahelp',
        'devframe://resource/vue-doctor%3Aoverview'
      ])
      const help = await mcpPost(endpoint, origin, {
        jsonrpc: '2.0', id: 5, method: 'resources/read',
        params: { uri: resourceUris[0] }
      }, initialized.sessionId)
      expect(help.body.result.contents[0]).toMatchObject({
        uri: resourceUris[0],
        mimeType: 'text/plain'
      })
      expect(help.body.result.contents[0].text).toContain('vue-doctor_get-overview')
      const overview = await mcpPost(endpoint, origin, {
        jsonrpc: '2.0', id: 6, method: 'resources/read',
        params: { uri: resourceUris[1] }
      }, initialized.sessionId)
      expect(overview.body.result.contents[0]).toMatchObject({
        uri: resourceUris[1],
        mimeType: 'application/json'
      })
      expect(JSON.parse(overview.body.result.contents[0].text)).toMatchObject({
        ok: true,
        coverageStatus: 'complete',
        clean: true
      })
    } finally {
      await server.close()
    }
  })

  test('keeps the legacy Inspector path as a compatibility alias', async () => {
    const server = await startInspectorServer({ report, open: false, port: 0 })

    try {
      const legacyUrl = new URL('/__vue-doctor__/', server.url)
      const response = await fetch(legacyUrl, { redirect: 'manual' })

      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('/vue-doctor/')
      expect((await fetch(new URL(response.headers.get('location')!, server.url))).headers.get('content-type')).toContain('text/html')
    } finally {
      await server.close()
    }
  })

  test('returns a plain-text 404 for unknown paths', async () => {
    const server = await startInspectorServer({ report, open: false, port: 0 })

    try {
      const response = await fetch(new URL('/missing', server.url))

      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('text/plain')
      expect(await response.text()).toBe('Not found\n')
    } finally {
      await server.close()
    }
  })

  test('opens only project files through the selected editor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-inspector-open-'))
    const file = join(root, 'src/App.vue')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(file, '<template />\n', 'utf8')
    const resolvedFile = await realpath(file)
    const openEditor = vi.fn(async () => {})
    const scopedReport: DoctorReport = {
      ...report,
      project: { ...report.project, root },
      inventory: { ...report.inventory, root }
    }
    const server = await startInspectorServer({
      report: scopedReport,
      open: false,
      port: 0,
      openEditor
    })

    try {
      for (const editor of ['vscode', 'cursor', 'webstorm']) {
        const response = await fetch(new URL('api/open', server.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ editor, file, line: 12, column: 4 })
        })
        expect(response.status).toBe(204)
        expect(openEditor).toHaveBeenLastCalledWith({ editor, file: resolvedFile, line: 12, column: 4 })
      }
      for (const editor of ['sublime', 'system', 'unknown']) {
        const response = await fetch(new URL('api/open', server.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ editor, file })
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ error: `Unsupported editor: ${editor}.` })
      }
      expect(openEditor).toHaveBeenCalledTimes(3)
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('previews and opens supported source types without allowing symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-inspector-sources-'))
    const outside = await mkdtemp(join(tmpdir(), 'vue-doctor-inspector-external-'))
    const files = ['page.html', 'page.htm', 'theme.css', 'theme.scss', 'theme.sass', 'view.jsx', 'module.mts', 'module.cts']
    await Promise.all(files.map((file) => writeFile(join(root, file), '/* source evidence */\n')))
    await writeFile(join(outside, 'private.scss'), '$private: 1;\n')
    await symlink(join(outside, 'private.scss'), join(root, 'linked.scss'))
    const server = await startInspectorServer({
      report: { ...report, project: { ...report.project, root }, inventory: { ...report.inventory, root } },
      open: false, port: 0, openEditor: vi.fn(async () => {})
    })
    try {
      for (const file of [...files, 'linked.scss']) {
        const snippet = new URL('api/snippet', server.url)
        snippet.searchParams.set('file', file)
        snippet.searchParams.set('line', '1')
        const preview = await fetch(snippet)
        const opened = await fetch(new URL('api/open', server.url), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ editor: 'vscode', file })
        })
        if (file === 'linked.scss') {
          expect(preview.status).toBe(403)
          expect(opened.status).toBe(403)
        } else {
          expect(preview.status).toBe(200)
          expect(await preview.json()).toMatchObject({
            lines: expect.arrayContaining([{ number: 1, text: '/* source evidence */', kind: 'hit' }])
          })
          expect(opened.status).toBe(204)
        }
      }
    } finally {
      await server.close()
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
    }
  })

  test('rejects outside-root and non-source Inspector file access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-inspector-root-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'vue-doctor-inspector-outside-'))
    const outsideFile = join(outsideRoot, 'secret.txt')
    const secretFile = join(root, '.env')
    const sourceFile = join(root, 'src/App.vue')
    await mkdir(join(root, 'src'), { recursive: true })
    await Promise.all([
      writeFile(outsideFile, 'secret\n', 'utf8'),
      writeFile(secretFile, 'TOKEN=secret\n', 'utf8'),
      writeFile(sourceFile, '<template><div /></template>\n', 'utf8')
    ])
    const scopedReport: DoctorReport = {
      ...report,
      project: { ...report.project, root },
      inventory: { ...report.inventory, root }
    }
    const server = await startInspectorServer({ report: scopedReport, open: false, port: 0 })

    try {
      const snippetUrl = new URL('api/snippet', server.url)
      snippetUrl.searchParams.set('file', outsideFile)
      snippetUrl.searchParams.set('line', '1')
      const snippetResponse = await fetch(snippetUrl)
      const editorResponse = await fetch(new URL('api/open', server.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editor: 'vscode', file: outsideFile })
      })
      const secretSnippetUrl = new URL('api/snippet', server.url)
      secretSnippetUrl.searchParams.set('file', secretFile)
      secretSnippetUrl.searchParams.set('line', '1')
      const secretSnippetResponse = await fetch(secretSnippetUrl)
      const secretEditorResponse = await fetch(new URL('api/open', server.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editor: 'vscode', file: secretFile })
      })
      const sourceSnippetUrl = new URL('api/snippet', server.url)
      sourceSnippetUrl.searchParams.set('file', sourceFile)
      sourceSnippetUrl.searchParams.set('line', '1')
      const sourceSnippetResponse = await fetch(sourceSnippetUrl)


      expect(snippetResponse.status).toBe(403)
      expect(editorResponse.status).toBe(403)
      expect(secretSnippetResponse.status).toBe(403)
      expect(secretEditorResponse.status).toBe(403)
      expect(sourceSnippetResponse.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  test('rejects oversized source snippets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-inspector-large-source-'))
    const sourceFile = join(root, 'Large.vue')
    await writeFile(sourceFile, 'x'.repeat(512_001), 'utf8')
    const scopedReport: DoctorReport = {
      ...report,
      project: { ...report.project, root },
      inventory: { ...report.inventory, root }
    }
    const server = await startInspectorServer({ report: scopedReport, open: false, port: 0 })

    try {
      const snippetUrl = new URL('api/snippet', server.url)
      snippetUrl.searchParams.set('file', sourceFile)
      snippetUrl.searchParams.set('line', '1')
      const response = await fetch(snippetUrl)

      expect(response.status).toBe(413)
    } finally {
      await server.close()
    }
  })

  test('rejects oversized open-editor request bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-inspector-body-'))
    const scopedReport: DoctorReport = {
      ...report,
      project: { ...report.project, root },
      inventory: { ...report.inventory, root }
    }
    const server = await startInspectorServer({ report: scopedReport, open: false, port: 0 })

    try {
      const response = await fetch(new URL('api/open', server.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editor: 'vscode', file: 'x'.repeat(17 * 1024) })
      })

      expect(response.status).toBe(413)
    } finally {
      await server.close()
    }
  })

  test('opens the final URL only after the server is listening', async () => {
    const openBrowser = vi.fn(async (url: string) => {
      expect((await fetch(url)).status).toBe(200)
    })

    const server = await startInspectorServer({ report, port: 0, openBrowser })
    try {
      expect(openBrowser).toHaveBeenCalledOnce()
      expect(openBrowser).toHaveBeenCalledWith(server.url)
    } finally {
      await server.close()
    }
  })

  test('closes the listening server when browser launch fails', async () => {
    let listeningUrl = ''
    const launchError = new Error('browser launch failed')

    await expect(startInspectorServer({
      report,
      port: 0,
      openBrowser: async (url) => {
        listeningUrl = url
        expect((await fetch(url)).status).toBe(200)
        throw launchError
      }
    })).rejects.toBe(launchError)

    expect(listeningUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vue-doctor\/$/)
    await expect(fetch(listeningUrl)).rejects.toThrow()
  })
})

async function mcpPost(
  endpoint: URL,
  origin: string,
  body: Record<string, unknown>,
  sessionId?: string
): Promise<{ body: any; sessionId?: string }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin,
      ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' } : {})
    },
    body: JSON.stringify(body)
  })
  expect(response.status).toBeLessThan(300)
  const text = await response.text()
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split(/\r?\n/u).find(line => line.startsWith('data: '))?.slice(6)
    : text
  return {
    body: data ? JSON.parse(data) : undefined,
    ...(response.headers.get('mcp-session-id') ? { sessionId: response.headers.get('mcp-session-id')! } : {})
  }
}

describe('getBrowserCommand', () => {
  const url = 'http://127.0.0.1:1234/vue-doctor/'

  test.each([
    ['darwin', { command: 'open', args: [url] }],
    ['win32', { command: 'cmd', args: ['/c', 'start', '', url] }],
    ['linux', { command: 'xdg-open', args: [url] }]
  ] satisfies Array<[NodeJS.Platform, { command: string, args: string[] }]>) (
    'maps %s to its platform browser command',
    (platform, expected) => {
      expect(getBrowserCommand(platform, url)).toEqual(expected)
    }
  )
})

describe('getEditorCommand', () => {
  test.each([
    ['vscode', { command: 'code', args: ['--goto', '/project/src/App.vue:12:4'] }],
    ['cursor', { command: 'cursor', args: ['--goto', '/project/src/App.vue:12:4'] }],
    ['webstorm', { command: 'webstorm', args: ['--line', '12', '/project/src/App.vue'] }]
  ] satisfies Array<[Parameters<typeof getEditorCommand>[1], { command: string; args: string[] }]>) (
    'maps %s to its editor command',
    (editor, expected) => {
      expect(getEditorCommand('darwin', editor, '/project/src/App.vue', 12, 4)).toEqual(expected)
    }
  )

  test('uses the Windows WebStorm command', () => {
    expect(getEditorCommand('win32', 'webstorm', 'C:\\project\\App.vue', 12, 4)).toEqual({
      command: 'webstorm64.exe', args: ['--line', '12', 'C:\\project\\App.vue']
    })
  })

  test.each(['sublime', 'system'])('rejects the unsupported command %s before launching', editor => {
    expect(() => getEditorCommand('darwin', editor as Parameters<typeof getEditorCommand>[1], '/project/src/App.vue'))
      .toThrow('Unsupported editor')
  })
})

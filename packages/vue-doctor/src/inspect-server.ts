import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getEditorCommand as getInspectorEditorCommand } from '@vue-doctor/inspector'
import { createInspectorHost } from '@vue-doctor/inspector/host'
import { createInspectorHubUi, inspectorClientAssets, readInspectorAsset } from '@vue-doctor/inspector-ui/assets'
import type { DoctorReport } from '@vue-doctor/core'

export interface InspectorServerOptions {
  report: DoctorReport
  /** Re-run an owned analysis session on refresh; omitted for persisted report viewing. */
  getReport?: () => Promise<DoctorReport>
  /** Explicitly invalidate and run the owned analysis session. */
  run?: () => Promise<DoctorReport>
  onClose?: () => Promise<void>
  host?: '127.0.0.1'
  port?: number
  open?: boolean
  openBrowser?: (url: string) => Promise<void>
  openEditor?: (request: OpenEditorRequest) => Promise<void>
}

export type { EditorName } from '@vue-doctor/inspector'
import type { EditorName } from '@vue-doctor/inspector'

export interface OpenEditorRequest {
  editor: EditorName
  file: string
  line?: number
  column?: number
}

export interface InspectorServer {
  url: string
  close(): Promise<void>
}

export function getBrowserCommand(platform: NodeJS.Platform, url: string) {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] }
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] }
  }
  return { command: 'xdg-open', args: [url] }
}

export function getEditorCommand(
  platform: NodeJS.Platform,
  editor: EditorName,
  file: string,
  line = 1,
  column = 1
) {
  return getInspectorEditorCommand(platform, editor, file, line, column)
}

export async function startInspectorServer(options: InspectorServerOptions): Promise<InspectorServer> {
  // The independent Inspector is local-only; native hosts retain their own trust policy.
  const host = '127.0.0.1'
  let inspectorHost: Awaited<ReturnType<typeof createInspectorHost>> | undefined
  const server = createServer((request, response) => {
    if (!inspectorHost) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' })
      response.end('Vue Doctor Inspector is starting\n')
      return
    }
    inspectorHost.nodeMiddleware(request, response, () => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found\n')
    })
  })
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    try { await inspectorHost?.close() }
    finally {
      try { await closeServer(server) }
      finally { await options.onClose?.() }
    }
  })()

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    inspectorHost = await createInspectorHost({
      report: options.report,
      getReport: options.getReport,
      run: options.run,
      openEditor: options.openEditor,
      clientAssets: inspectorClientAssets,
      readClientAsset: readInspectorAsset,
      server,
      hubUi: createInspectorHubUi('/vue-doctor/'),
      auth: false
    })
    const address = server.address() as AddressInfo
    const inspector = { url: `http://${host}:${address.port}/vue-doctor/`, close }
    if (options.open !== false) await (options.openBrowser ?? openBrowser)(inspector.url)
    return inspector
  } catch (error) {
    await close()
    throw error
  }
}

async function openBrowser(url: string): Promise<void> {
  const { command, args } = getBrowserCommand(process.platform, url)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error)
      else resolve()
    })
  })
}

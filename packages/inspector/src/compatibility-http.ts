import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DoctorReport } from '@vue-doctor/core'
import {
  EditorOpenError,
  formatEditorLaunchError,
  getEditorCommand,
  resolveSourceFileWithinRoot
} from './editor.js'
import type { EditorName } from './editor.js'
import { isInspectorEditor } from './protocol.js'

const DEFAULT_INSPECTOR_BASE = '/vue-doctor/'
const LEGACY_INSPECTOR_BASE = '/__vue-doctor__/'
const MAX_EDITOR_REQUEST_BODY_BYTES = 16 * 1024

type Awaitable<T> = T | Promise<T>

export interface InspectorClientAsset {
  body: Uint8Array | string
  contentType: string
}

export type InspectorClientAssetReader = (
  name: string
) => Awaitable<InspectorClientAsset | undefined>

export interface LegacyOpenEditorRequest {
  editor: EditorName
  file: string
  line?: number
  column?: number
}

export interface InspectorCompatibilityOptions {
  report: DoctorReport
  /** Legacy report reads intentionally retain their historical rerun behavior. */
  getReport?: () => Awaitable<DoctorReport>
  /** Reads the current immutable snapshot when no legacy rerun callback exists. */
  getCompletedReport?: () => Awaitable<Readonly<DoctorReport>>
  openEditor?: (request: LegacyOpenEditorRequest) => Awaitable<void>
  base?: string
  /** Host-owned UI adapter. Omit it when only report/RPC services are installed. */
  readClientAsset?: InspectorClientAssetReader
}

export type InspectorNodeMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next?: (error?: unknown) => void
) => void

export function createInspectorCompatibilityMiddleware(
  options: InspectorCompatibilityOptions
): InspectorNodeMiddleware {
  const base = normalizeBase(options.base ?? DEFAULT_INSPECTOR_BASE)
  const projectRoot = options.report.project.root
  const initialReportJson = JSON.stringify(options.report)
  const open = options.openEditor ?? openEditorWithSystem

  return (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const route = compatibilityRoute(pathname, base)
    if (route && !isLocalCompatibilityRequest(request)) {
      writeJsonError(response, new EditorOpenError('Legacy Inspector APIs require a same-origin loopback request. Use the authenticated Doctor workspace on remote hosts.', { status: 403, code: 'invalid-request' }))
      return
    }

    if (route === 'report') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      void serveReport(response, options, projectRoot, initialReportJson)
      return
    }

    if (route === 'open' && request.method === 'POST') {
      void handleOpenEditor(request, response, projectRoot, open).catch(error => writeJsonError(response, error))
      return
    }

    if (route === 'snippet' && request.method === 'GET') {
      void handleSnippet(url, response, projectRoot).catch(error => writeJsonError(response, error))
      return
    }

    const asset = compatibilityAsset(pathname, base)
    if (asset) {
      void serveCompatibilityAsset(asset, response, next, options.readClientAsset)
      return
    }

    if (pathname === LEGACY_INSPECTOR_BASE.slice(0, -1) || pathname.startsWith(LEGACY_INSPECTOR_BASE)) {
      const suffix = pathname === LEGACY_INSPECTOR_BASE.slice(0, -1)
        ? ''
        : pathname.slice(LEGACY_INSPECTOR_BASE.length)
      response.writeHead(308, { location: `${base}${suffix}${url.search}` })
      response.end()
      return
    }

    next?.()
  }
}

/** Legacy clients have no Hub token; preserve them only within the local trust boundary. */
export function isLocalCompatibilityRequest(request: IncomingMessage): boolean {
  const peer = request.socket.remoteAddress
  if (peer !== '::1' && !/^127\./u.test(peer ?? '') && !/^::ffff:127\./u.test(peer ?? '')) return false
  try {
    const host = new URL(`http://${request.headers.host}`)
    if (host.hostname !== 'localhost' && host.hostname !== '[::1]' && !/^127(?:\.\d{1,3}){3}$/u.test(host.hostname)) return false
    const origin = request.headers.origin
    const protocol = 'encrypted' in request.socket && request.socket.encrypted ? 'https:' : 'http:'
    return !origin || (new URL(origin).host === host.host && new URL(origin).protocol === protocol)
  } catch { return false }
}

export async function openEditorWithSystem(request: LegacyOpenEditorRequest): Promise<void> {
  const line = Math.max(1, request.line ?? 1)
  const column = Math.max(1, request.column ?? 1)
  const command = getEditorCommand(process.platform, request.editor, request.file, line, column)
  try {
    await spawnDetached(command.command, command.args)
  } catch (cause) {
    throw formatEditorLaunchError(request.editor, command.command, cause)
  }
}

async function serveReport(
  response: ServerResponse,
  options: InspectorCompatibilityOptions,
  projectRoot: string,
  initialReportJson: string
): Promise<void> {
  try {
    const report = options.getReport
      ? await options.getReport()
      : await options.getCompletedReport?.()
    if (report && report.project.root !== projectRoot) {
      throw new Error('Inspector report project root changed.')
    }
    if (!canWrite(response)) return
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8'
    })
    response.end(report ? JSON.stringify(report) : initialReportJson)
  } catch (error) {
    writeJsonError(response, error, 500)
  }
}

async function handleOpenEditor(
  request: IncomingMessage,
  response: ServerResponse,
  projectRoot: string,
  open: (request: LegacyOpenEditorRequest) => Awaitable<void>
): Promise<void> {
  const body = await readRequestBody(request)
  let parsed: Partial<LegacyOpenEditorRequest>
  try {
    parsed = JSON.parse(body) as Partial<LegacyOpenEditorRequest>
  } catch {
    throw invalidRequest('Invalid JSON body for open-editor request.')
  }
  if (!parsed.file || typeof parsed.file !== 'string') {
    throw invalidRequest('A source file path is required.')
  }
  const editor = parsed.editor ?? 'vscode'
  if (!isInspectorEditor(editor)) {
    throw invalidRequest(`Unsupported editor: ${String(editor)}.`)
  }
  const file = await resolveSourceFileWithinRoot(projectRoot, parsed.file)
  await open({ editor, file, line: parsed.line, column: parsed.column })
  if (!canWrite(response)) return
  response.writeHead(204)
  response.end()
}

async function handleSnippet(
  url: URL,
  response: ServerResponse,
  projectRoot: string
): Promise<void> {
  const file = url.searchParams.get('file')
  const line = Number(url.searchParams.get('line') ?? '')
  const context = Math.min(8, Math.max(0, Number(url.searchParams.get('context') ?? '2') || 2))
  if (!file || !Number.isFinite(line) || line < 1) throw invalidRequest('file and line are required.')
  if (file.includes('\0')) throw invalidRequest('Invalid file path.')

  const resolvedFile = await resolveSourceFileWithinRoot(projectRoot, file)
  const content = await readFile(resolvedFile, 'utf8')
  if (!canWrite(response)) return
  const sourceLines = content.split(/\r?\n/u)
  const hit = Math.floor(line)
  const start = Math.max(1, hit - context)
  const end = Math.min(sourceLines.length, hit + context)
  const lines = []
  for (let number = start; number <= end; number += 1) {
    lines.push({
      number,
      text: sourceLines[number - 1] ?? '',
      kind: number === hit ? 'hit' : 'context'
    })
  }

  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8'
  })
  response.end(JSON.stringify({
    file: resolvedFile,
    line: hit,
    column: url.searchParams.get('column') ? Number(url.searchParams.get('column')) : undefined,
    lines
  }))
}

async function serveCompatibilityAsset(
  name: string,
  response: ServerResponse,
  next?: (error?: unknown) => void,
  readClientAsset?: InspectorClientAssetReader
): Promise<void> {
  try {
    const asset = await readClientAsset?.(name)
    if (!canWrite(response)) return
    if (!asset) {
      if (next) next()
      else {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found\n')
      }
      return
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': asset.contentType
    })
    response.end(asset.body)
  } catch (error) {
    if (next) next(error)
    else writeJsonError(response, error, 500)
  }
}

function compatibilityRoute(pathname: string, base: string): 'report' | 'open' | 'snippet' | undefined {
  for (const candidate of [base, LEGACY_INSPECTOR_BASE]) {
    if (pathname === `${candidate}api/report.json`) return 'report'
    if (pathname === `${candidate}api/open`) return 'open'
    if (pathname === `${candidate}api/snippet`) return 'snippet'
  }
  return undefined
}

function compatibilityAsset(pathname: string, base: string): string | undefined {
  for (const candidate of [base, LEGACY_INSPECTOR_BASE]) {
    const prefix = `${candidate}assets/`
    if (pathname.startsWith(prefix)) return `assets/${pathname.slice(prefix.length)}`
    if (pathname === `${candidate}favicon.svg`) return 'favicon.svg'
  }
  return undefined
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let settled = false
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      if (settled) return
      body += chunk
      if (Buffer.byteLength(body, 'utf8') > MAX_EDITOR_REQUEST_BODY_BYTES) {
        settled = true
        reject(new EditorOpenError('Open-editor request body is too large.', {
          status: 413,
          code: 'invalid-request'
        }))
      }
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      resolve(body)
    })
    request.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function writeJsonError(response: ServerResponse, error: unknown, fallbackStatus = 400): void {
  if (response.headersSent || !canWrite(response)) return
  const status = error instanceof EditorOpenError ? error.status : fallbackStatus
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8'
  })
  response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
}

function invalidRequest(message: string): EditorOpenError {
  return new EditorOpenError(message, { status: 400, code: 'invalid-request' })
}

function canWrite(response: ServerResponse): boolean {
  return !response.destroyed && !response.writableEnded
}

function normalizeBase(base: string): string {
  return `/${base.replace(/^\/+|\/+$/gu, '')}/`
}

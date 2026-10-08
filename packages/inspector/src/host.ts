import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { initHub } from '@devframes/hub/initiate'
import type { DevframeHubUi, HubInstance } from '@devframes/hub/initiate'
import type { DoctorReport } from '@vue-doctor/core'
import type { DevframeDefinition, DevframeNodeContext, StaticAssetsSource } from 'devframe'
import {
  createInspectorCompatibilityMiddleware,
  openEditorWithSystem
} from './compatibility-http.js'
import type {
  InspectorClientAssetReader,
  InspectorNodeMiddleware,
  LegacyOpenEditorRequest
} from './compatibility-http.js'
import { createVueDoctorDevframe, disposeVueDoctorDevframeMount } from './devframe.js'
import { InspectorReportStore } from './report-store.js'

const DEFAULT_INSPECTOR_BASE = '/vue-doctor/'

type Awaitable<T> = T | Promise<T>

export interface InspectorBackendOptions {
  report: DoctorReport
  /** Legacy HTTP reads invoke this callback; RPC reads remain snapshot-only. */
  getReport?: () => Awaitable<DoctorReport>
  /** Starts an explicit Doctor run. The host retains ownership of its analysis session. */
  run?: () => Awaitable<void | DoctorReport>
  openEditor?: (request: LegacyOpenEditorRequest) => Awaitable<void>
  clientAssets: StaticAssetsSource
  /** Compatibility SPA assets remain owned and supplied by the UI package. */
  readClientAsset?: InspectorClientAssetReader
  base?: string
}

export interface InspectorBackend {
  base: string
  store: InspectorReportStore
  definition: DevframeDefinition
  compatibilityMiddleware: InspectorNodeMiddleware
  createCompatibilityMiddleware(base: string): InspectorNodeMiddleware
  close(): Promise<void>
}

export interface InspectorHostOptions extends Partial<InspectorBackendOptions> {
  backend?: InspectorBackend
  server?: Server
  base?: string
  /** Host-owned Hub shell; Inspector stays headless without the UI package. */
  hubUi: DevframeHubUi
  /** Standalone loopback hosts may explicitly disable the interactive auth gate. */
  auth?: false
}

export interface InspectorHost extends InspectorBackend {
  hub: HubInstance
  nodeMiddleware: InspectorNodeMiddleware
  /** Detach this mount while a native host continues using the shared backend. */
  closeTransport(): Promise<void>
}

export function createInspectorBackend(options: InspectorBackendOptions): InspectorBackend {
  const base = normalizeBase(options.base ?? DEFAULT_INSPECTOR_BASE)
  const openEditor = options.openEditor ?? openEditorWithSystem
  const store = new InspectorReportStore({
    initialReport: options.report,
    getReport: options.getReport,
    run: options.run,
    source: {
      openEditor: request => openEditor({
        editor: request.editor,
        file: request.file,
        line: request.line,
        column: request.column
      })
    }
  })
  const definition = createVueDoctorDevframe({
    store,
    clientAssets: options.clientAssets
  })
  const createCompatibilityMiddleware = (mountBase: string) => createInspectorCompatibilityMiddleware({
    report: options.report,
    getReport: options.getReport,
    getCompletedReport: () => store.getReport(store.getSnapshot().snapshotId),
    openEditor,
    readClientAsset: options.readClientAsset,
    base: mountBase
  })
  const compatibilityMiddleware = createCompatibilityMiddleware(base)
  let closePromise: Promise<void> | undefined

  return {
    base,
    store,
    definition,
    compatibilityMiddleware,
    createCompatibilityMiddleware,
    close: () => closePromise ??= Promise.resolve().then(() => store.close())
  }
}

export async function createInspectorHost(options: InspectorHostOptions): Promise<InspectorHost> {
  const backend = options.backend ?? createInspectorBackend(assertBackendOptions(options))
  const base = normalizeBase(options.base ?? backend.base)
  const compatibilityMiddleware = base === backend.base ? backend.compatibilityMiddleware : backend.createCompatibilityMiddleware(base)
  let mountContext: DevframeNodeContext | undefined
  const mountedDefinition: DevframeDefinition = {
    ...backend.definition,
    async setup(context) {
      mountContext = context
      return backend.definition.setup(context)
    }
  }
  const hub = initHub({
    base,
    name: 'Vue Doctor',
    devframes: [{
      devframe: mountedDefinition,
      dock: {
        frameId: 'vue-doctor',
        clientScript: { importFrom: `${base}vue-doctor/hub-bootstrap.js?v=nav-2`, eager: true },
        subTabs: { protocol: 'postmessage', handshakeTimeoutMs: 3000 }
      }
    }],
    ui: options.hubUi,
    server: options.server,
    ...(serverOrigin(options.server) ? { origin: serverOrigin(options.server) } : {}),
    // Middleware-only and HTTP/2 hosts have no compatible Node upgrade event.
    // SSE keeps the connection on the same origin without creating a sidecar.
    ...(!options.server ? { ws: false as const } : {}),
    ...(options.auth === false ? { auth: false as const } : {}),
    mcp: 'auto',
    register: true,
    cwd: options.report?.project.root ?? backend.store.getSnapshot().project.root
  })

  try {
    await hub.ready
  } catch (error) {
    if (mountContext) disposeVueDoctorDevframeMount(backend.definition, mountContext)
    await hub.close().catch(() => {})
    if (!options.backend) await backend.close().catch(() => {})
    throw error
  }

  const nodeMiddleware: InspectorNodeMiddleware = (request, response, next) => {
    compatibilityMiddleware(request, response, (error) => {
      if (error) {
        next?.(error)
        return
      }
      hub.nodeMiddleware(request, response, next)
    })
  }
  let closePromise: Promise<void> | undefined
  let transportClosePromise: Promise<void> | undefined
  const closeTransport = () => transportClosePromise ??= (async () => {
    if (mountContext) disposeVueDoctorDevframeMount(backend.definition, mountContext)
    await hub.close()
  })()

  return {
    ...backend,
    base,
    compatibilityMiddleware,
    hub,
    nodeMiddleware,
    closeTransport,
    close: () => closePromise ??= closeTransport().finally(() => backend.close())
  }
}

function serverOrigin(server: Server | undefined): string | undefined {
  if (!server?.listening) return undefined
  const address = server.address()
  if (!address || typeof address === 'string') return undefined
  const host = loopbackHost(address)
  return `http://${host}:${address.port}`
}

function loopbackHost(address: AddressInfo): string {
  if (address.family === 'IPv6' || address.address.includes(':')) return '[::1]'
  return '127.0.0.1'
}

function assertBackendOptions(options: InspectorHostOptions): InspectorBackendOptions {
  if (!options.report) throw new TypeError('createInspectorHost requires a report or an existing backend.')
  if (!options.clientAssets) throw new TypeError('createInspectorHost requires clientAssets from its host package.')
  return {
    report: options.report,
    getReport: options.getReport,
    run: options.run,
    openEditor: options.openEditor,
    clientAssets: options.clientAssets,
    readClientAsset: options.readClientAsset,
    base: options.base
  }
}

function normalizeBase(base: string): string {
  return `/${base.replace(/^\/+|\/+$/gu, '')}/`
}

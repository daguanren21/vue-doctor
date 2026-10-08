import { connectDevframe, type DevframeConnectionStatus } from 'devframe/client'
import { DEVFRAME_EVENTS } from 'devframe/constants'
import {
  VUE_DOCTOR_DEVFRAME_ID,
  VUE_DOCTOR_RPC_METHODS,
  VUE_DOCTOR_SHARED_STATE_KEY,
  type ExportReportRequest,
  type ExportReportResult,
  type GetAuditRequest,
  type GetFindingRequest,
  type GetSnippetRequest,
  type InspectorActionResult,
  type InspectorAuditItem,
  type InspectorCoverageResult,
  type InspectorFindingDetail,
  type InspectorFindingSummary,
  type InspectorPage,
  type InspectorRuleItem,
  type InspectorSharedState,
  type InspectorSnapshot,
  type InspectorSnippet,
  type OpenEditorRequest,
  type QueryAuditRequest,
  type QueryCoverageRequest,
  type QueryFindingsRequest,
  type QueryRulesRequest,
  type RunInspectorRequest,
  type RunInspectorResult
} from '@vue-doctor/inspector-protocol'

export type InspectorStateListener = (state: Readonly<InspectorSharedState>) => void
export type InspectorStateErrorListener = (error: Error) => void
export interface InspectorConnectionEvent {
  status: DevframeConnectionStatus
  error?: Error
}
export type InspectorConnectionListener = (event: InspectorConnectionEvent) => void

export interface InspectorTransport {
  getSnapshot(): Promise<InspectorSnapshot>
  queryFindings(request: QueryFindingsRequest): Promise<InspectorPage<InspectorFindingSummary>>
  getFinding(request: GetFindingRequest): Promise<InspectorFindingDetail>
  getCoverage(request: QueryCoverageRequest): Promise<InspectorCoverageResult>
  queryRules(request: QueryRulesRequest): Promise<InspectorPage<InspectorRuleItem>>
  queryAudit(request: QueryAuditRequest): Promise<InspectorPage<InspectorAuditItem>>
  getAudit(request: GetAuditRequest): Promise<InspectorAuditItem>
  run(request?: RunInspectorRequest): Promise<RunInspectorResult>
  getSnippet(request: GetSnippetRequest): Promise<InspectorSnippet>
  openEditor(request: OpenEditorRequest): Promise<InspectorActionResult>
  exportReport(request: ExportReportRequest): Promise<ExportReportResult>
  subscribeConnection(listener: InspectorConnectionListener): () => void
  subscribe(listener: InspectorStateListener, onError?: InspectorStateErrorListener): Promise<() => void>
  close(): void
}

function invalidHostValue(name: string, detail: string): Error {
  return new Error(`The analysis host returned an invalid ${name}: ${detail}.`)
}

function assertSnapshot(value: unknown): InspectorSnapshot {
  if (!value || typeof value !== 'object') throw invalidHostValue('snapshot', 'expected an object')
  const candidate = value as Partial<InspectorSnapshot>
  if (!candidate.snapshotId || typeof candidate.snapshotId !== 'string') throw invalidHostValue('snapshot', 'missing snapshotId')
  if (!candidate.run || typeof candidate.run !== 'object') throw invalidHostValue('snapshot', 'missing run')
  if (!candidate.run.status || typeof candidate.run.status !== 'string') throw invalidHostValue('snapshot', 'missing run.status')
  if (!candidate.counts || typeof candidate.counts !== 'object') throw invalidHostValue('snapshot', 'missing counts')
  if (!candidate.facets || typeof candidate.facets !== 'object') throw invalidHostValue('snapshot', 'missing facets')
  return candidate as InspectorSnapshot
}

function assertSharedState(value: unknown): Readonly<InspectorSharedState> {
  if (!value || typeof value !== 'object') throw invalidHostValue('shared state', 'expected an object')
  const candidate = value as Partial<InspectorSharedState>
  if (!candidate.status || typeof candidate.status !== 'string') throw invalidHostValue('shared state', 'missing status')
  if (typeof candidate.revision !== 'number') throw invalidHostValue('shared state', 'missing revision')
  return candidate as Readonly<InspectorSharedState>
}

export async function createDevframeTransport(options: { baseURL?: string } = {}): Promise<InspectorTransport> {
  const client = await connectDevframe(options.baseURL ? { baseURL: options.baseURL } : undefined)
  const scoped = client.scope(VUE_DOCTOR_DEVFRAME_ID)
  const call = <T>(method: string, request?: unknown) => scoped.rpc.call(method, ...(request === undefined ? [] : [request])) as Promise<T>

  return {
    getSnapshot: async () => assertSnapshot(await call<unknown>(VUE_DOCTOR_RPC_METHODS.getSnapshot, {})),
    queryFindings: request => call(VUE_DOCTOR_RPC_METHODS.queryFindings, request),
    getFinding: request => call(VUE_DOCTOR_RPC_METHODS.getFinding, request),
    getCoverage: request => call(VUE_DOCTOR_RPC_METHODS.getCoverage, request),
    queryRules: request => call(VUE_DOCTOR_RPC_METHODS.queryRules, request),
    queryAudit: request => call(VUE_DOCTOR_RPC_METHODS.queryAudit, request),
    getAudit: request => call(VUE_DOCTOR_RPC_METHODS.getAudit, request),
    run: request => call(VUE_DOCTOR_RPC_METHODS.run, request),
    getSnippet: request => call(VUE_DOCTOR_RPC_METHODS.getSnippet, request),
    openEditor: request => call(VUE_DOCTOR_RPC_METHODS.openEditor, request),
    exportReport: request => call(VUE_DOCTOR_RPC_METHODS.exportReport, request),
    subscribeConnection(listener) {
      const stopStatus = client.events.on(DEVFRAME_EVENTS.client.connectionStatus, status => {
        listener({ status, ...(client.connectionError ? { error: client.connectionError } : {}) })
      })
      const stopError = client.events.on(DEVFRAME_EVENTS.client.connectionError, error => {
        listener({ status: client.status, error })
      })
      listener({ status: client.status, ...(client.connectionError ? { error: client.connectionError } : {}) })
      return () => {
        stopStatus()
        stopError()
      }
    },
    async subscribe(listener, onError) {
      const state = await scoped.rpc.sharedState<InspectorSharedState>(VUE_DOCTOR_SHARED_STATE_KEY)
      listener(assertSharedState(state.value()))
      return state.on('updated', next => {
        try {
          listener(assertSharedState(next))
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    close() {
      client.close?.()
    }
  }
}

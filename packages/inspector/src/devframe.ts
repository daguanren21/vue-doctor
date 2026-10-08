import { defineDevframe, defineRpcFunction } from 'devframe'
import type { DevframeDefinition, DevframeNodeContext, StaticAssetsSource } from 'devframe'
import type { RpcFunctionDefinitionAnyWithContext } from 'devframe/rpc'
import type {
  ExportReportRequest,
  ExportReportResult,
  GetFindingRequest,
  GetAuditRequest,
  GetSnippetRequest,
  InspectorActionResult,
  InspectorAuditItem,
  InspectorCoverageResult,
  InspectorFindingDetail,
  InspectorFindingSummary,
  InspectorPage,
  InspectorRuleItem,
  InspectorSharedState,
  InspectorSnapshot,
  InspectorSnippet,
  OpenEditorRequest,
  QueryAuditRequest,
  QueryCoverageRequest,
  QueryFindingsRequest,
  QueryRulesRequest,
  RunInspectorRequest,
  RunInspectorResult
} from './protocol.js'
import {
  assertGetSnapshotRequest,
  VUE_DOCTOR_DEVFRAME_ID,
  VUE_DOCTOR_RPC_METHODS,
  VUE_DOCTOR_SHARED_STATE_KEY
} from './protocol.js'
import type { InspectorReportStore } from './report-store.js'
import { registerVueDoctorAgent } from './agent.js'

export { VUE_DOCTOR_SHARED_STATE_KEY } from './protocol.js'
// Keep the host icon portable: Hub resolves dock icons against its own metadata
// base, so a data URL avoids coupling the icon to a particular mount path.
const VUE_DOCTOR_ICON = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M9.5%209.5%20L16%2023.5%20L22.5%209.5%22%20stroke%3D%22%2342b883%22%20stroke-width%3D%222.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M12%2015%20H20%22%20stroke%3D%22%2342b883%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20opacity%3D%220.9%22%2F%3E%3Ccircle%20cx%3D%2216%22%20cy%3D%2215%22%20r%3D%221.85%22%20fill%3D%22%2342b883%22%2F%3E%3C%2Fsvg%3E'
const mountDisposers = new WeakMap<DevframeDefinition, WeakMap<DevframeNodeContext, () => void>>()

export interface CreateVueDoctorDevframeOptions {
  store: InspectorReportStore
  /** Resolved by the host package that owns the browser UI dependency. */
  clientAssets?: StaticAssetsSource
  version?: string
}

declare module 'devframe' {
  interface DevframeRpcServerFunctions {
    'vue-doctor:getSnapshot': (request?: Record<string, never>) => InspectorSnapshot
    'vue-doctor:queryFindings': (request: QueryFindingsRequest) => InspectorPage<InspectorFindingSummary>
    'vue-doctor:getFinding': (request: GetFindingRequest) => InspectorFindingDetail
    'vue-doctor:getCoverage': (request: QueryCoverageRequest) => InspectorCoverageResult
    'vue-doctor:queryRules': (request: QueryRulesRequest) => InspectorPage<InspectorRuleItem>
    'vue-doctor:queryAudit': (request: QueryAuditRequest) => InspectorPage<InspectorAuditItem>
    'vue-doctor:getAudit': (request: GetAuditRequest) => InspectorAuditItem
    'vue-doctor:exportReport': (request: ExportReportRequest) => ExportReportResult
    'vue-doctor:run': (request?: RunInspectorRequest) => Promise<RunInspectorResult>
    'vue-doctor:getSnippet': (request: GetSnippetRequest) => Promise<InspectorSnippet>
    'vue-doctor:openEditor': (request: OpenEditorRequest) => Promise<InspectorActionResult>
  }

  interface DevframeRpcSharedStates {
    'vue-doctor:state': InspectorSharedState
  }
}

export function createVueDoctorDevframe(options: CreateVueDoctorDevframeOptions): DevframeDefinition {
  const clientAssets = options.clientAssets
  let definition!: DevframeDefinition
  definition = defineDevframe({
    id: VUE_DOCTOR_DEVFRAME_ID,
    name: 'Vue Doctor',
    version: options.version ?? '0.0.0',
    packageName: '@vue-doctor/inspector',
    importMetaUrl: import.meta.url,
    homepage: 'https://www.npmjs.com/package/vue-doctor',
    description: 'Inspect Vue diagnostics, evidence, coverage, rules, and suppression audits.',
    icon: VUE_DOCTOR_ICON,
    dock: {
      title: 'Vue Doctor',
      titleLocales: { 'zh-CN': 'Vue Doctor' },
      category: 'framework',
      defaultOrder: 20
    },
    capabilities: { dev: true, build: false },
    duplicationStrategy: 'warn',
    ...(clientAssets ? { clientAssets } : {}),
    async setup(context) {
      const scoped = context.scope(VUE_DOCTOR_DEVFRAME_ID)
      for (const definition of createVueDoctorRpcDefinitions(options.store)) scoped.rpc.register(definition)

      const shared = await scoped.rpc.sharedState(VUE_DOCTOR_SHARED_STATE_KEY, {
        initialValue: options.store.getSharedState()
      })
      const unsubscribe = options.store.onStateChange((next) => {
        shared.mutate((current) => replaceState(current, next))
      })
      const unregisterAgent = registerVueDoctorAgent(context, options.store)
      registerMountDisposer(definition, context, () => {
        unregisterAgent()
        unsubscribe()
      })
    }
  })
  return definition
}

/**
 * Release the store-to-shared-state bridge for one mounted context.
 * The host remains responsible for uninstalling RPC registrations and closing its own context.
 */
export function disposeVueDoctorDevframeMount(
  definition: DevframeDefinition,
  context: DevframeNodeContext
): boolean {
  const contexts = mountDisposers.get(definition)
  const dispose = contexts?.get(context)
  if (!dispose) return false
  contexts!.delete(context)
  dispose()
  return true
}

export function createVueDoctorRpcDefinitions(
  store: InspectorReportStore
): RpcFunctionDefinitionAnyWithContext<DevframeNodeContext>[] {
  return [
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.getSnapshot,
      type: 'query',
      jsonSerializable: true,
      handler: (request?: Record<string, never>) => {
        assertGetSnapshotRequest(request)
        return store.getSnapshot()
      }
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.queryFindings,
      type: 'query',
      jsonSerializable: true,
      handler: (request: QueryFindingsRequest) => store.queryFindings(request)
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.getFinding,
      type: 'query',
      jsonSerializable: true,
      handler: (request: GetFindingRequest) => store.getFinding(request)
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.getCoverage,
      type: 'query',
      jsonSerializable: true,
      handler: (request: QueryCoverageRequest) => store.getCoverage(request)
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.queryRules,
      type: 'query',
      jsonSerializable: true,
      handler: (request: QueryRulesRequest) => store.queryRules(request)
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.queryAudit,
      type: 'query',
      jsonSerializable: true,
      handler: (request: QueryAuditRequest) => store.queryAudit(request)
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.getAudit,
      type: 'query',
      jsonSerializable: true,
      handler: (request: GetAuditRequest) => store.getAudit(request)
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.exportReport,
      type: 'query',
      jsonSerializable: true,
      handler: (request: ExportReportRequest) => store.exportReport(request)
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.run,
      type: 'action',
      jsonSerializable: true,
      handler: (request?: RunInspectorRequest) => store.run(request)
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.getSnippet,
      type: 'query',
      jsonSerializable: true,
      handler: (request: GetSnippetRequest) => store.getSnippet(request)
    }),
    defineRpcFunction({
      name: VUE_DOCTOR_RPC_METHODS.openEditor,
      type: 'action',
      jsonSerializable: true,
      handler: (request: OpenEditorRequest) => store.openEditor(request)
    })
  ] as const
}

function registerMountDisposer(
  definition: DevframeDefinition,
  context: DevframeNodeContext,
  dispose: () => void
): void {
  let contexts = mountDisposers.get(definition)
  if (!contexts) {
    contexts = new WeakMap()
    mountDisposers.set(definition, contexts)
  }
  contexts.get(context)?.()
  contexts.set(context, dispose)
}

function replaceState(current: InspectorSharedState, next: InspectorSharedState): void {
  for (const key of Object.keys(current) as Array<keyof InspectorSharedState>) delete current[key]
  Object.assign(current, next)
}

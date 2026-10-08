import type { DoctorReport } from '@vue-doctor/core'
import type { DevframeNodeContext } from 'devframe'
import type { RpcFunctionDefinitionAnyWithContext } from 'devframe/rpc'
import { describe, expect, test } from 'vitest'
import {
  createVueDoctorDevframe,
  createVueDoctorRpcDefinitions,
  disposeVueDoctorDevframeMount,
  VUE_DOCTOR_SHARED_STATE_KEY
} from './devframe.js'
import { InspectorReportStore } from './report-store.js'

describe('Vue Doctor Devframe', () => {
  test('declares one portable namespaced frame with strict-json operations', () => {
    const store = new InspectorReportStore({ initialReport: report() })
    const definition = createVueDoctorDevframe({ store, clientAssets: '/fixture/inspector-ui' })
    const operations = createVueDoctorRpcDefinitions(store)

    expect(definition).toMatchObject({
      id: 'vue-doctor',
      name: 'Vue Doctor',
      packageName: '@vue-doctor/inspector',
      clientAssets: '/fixture/inspector-ui',
      capabilities: { dev: true, build: false }
    })
    expect(operations.map(operation => operation.name)).toEqual([
      'getSnapshot',
      'queryFindings',
      'getFinding',
      'getCoverage',
      'queryRules',
      'queryAudit',
      'getAudit',
      'exportReport',
      'run',
      'getSnippet',
      'openEditor'
    ])
    expect(operations.every(operation => operation.jsonSerializable === true)).toBe(true)
  })

  test('registers bare operations under the scope and mirrors only bounded shared state', async () => {
    const next = report('new finding')
    const store = new InspectorReportStore({ initialReport: report(), run: async () => next })
    const registered: RpcFunctionDefinitionAnyWithContext<DevframeNodeContext>[] = []
    const updates: unknown[] = []
    const agentTools: unknown[] = []
    const agentResources: unknown[] = []
    let sharedKey: string | undefined
    let initialState: unknown
    const definition = createVueDoctorDevframe({ store, clientAssets: '/fixture/inspector-ui' })
    const context = {
      agent: {
        registerTool(tool: unknown) {
          agentTools.push(tool)
          return { unregister: () => true }
        },
        registerResource(resource: unknown) {
          agentResources.push(resource)
          return { unregister: () => true }
        }
      },
      scope(namespace: string) {
        expect(namespace).toBe('vue-doctor')
        return {
          rpc: {
            register(operation: RpcFunctionDefinitionAnyWithContext<DevframeNodeContext>) {
              registered.push(operation)
            },
            async sharedState(key: string, options: { initialValue: unknown }) {
              sharedKey = key
              initialState = options.initialValue
              return {
                mutate(update: (draft: Record<string, unknown>) => void) {
                  const draft = { ...(updates.at(-1) as Record<string, unknown> | undefined ?? options.initialValue as Record<string, unknown>) }
                  update(draft)
                  updates.push(draft)
                }
              }
            }
          }
        }
      }
    } as unknown as DevframeNodeContext

    await definition.setup(context)
    expect(sharedKey).toBe(VUE_DOCTOR_SHARED_STATE_KEY)
    expect(initialState).toEqual({
      namespace: 'vue-doctor',
      protocolVersion: 1,
      revision: 1,
      snapshotId: store.getSnapshot().snapshotId,
      status: 'idle'
    })
    expect(initialState).not.toHaveProperty('diagnostics')
    expect(registered).toHaveLength(11)
    expect(agentTools).toHaveLength(11)
    expect(agentResources).toHaveLength(2)

    await store.run()
    expect(updates).toHaveLength(2)
    expect(updates.at(-1)).toMatchObject({ status: 'idle', revision: 3, snapshotId: store.getSnapshot().snapshotId })

    expect(disposeVueDoctorDevframeMount(definition, context)).toBe(true)
    expect(disposeVueDoctorDevframeMount(definition, context)).toBe(false)
    await store.run()
    expect(updates).toHaveLength(2)

    store.close()
    await expect(store.run()).rejects.toMatchObject({ code: 'closed' })
  })
})

function report(message?: string): DoctorReport {
  return {
    project: { root: '/workspace', vueFramework: 'vue3', uiLibraries: [] },
    inventory: { root: '/workspace', packages: {} },
    coverage: {
      status: 'complete',
      source: { status: 'complete', scannedFileCount: 1, failedFiles: [] },
      componentLibraries: []
    },
    diagnostics: message ? [{
      code: 'fixture/rule',
      severity: 'warning',
      message,
      evidence: [],
      fixes: [],
      confidence: 'high'
    }] : []
  }
}

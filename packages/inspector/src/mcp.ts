import { createMcpServer } from 'devframe/adapters/mcp'
import type { DevframeDefinition, DevframeNodeContext, McpServerHandle } from 'devframe'
import { createVueDoctorDevframe, disposeVueDoctorDevframeMount } from './devframe.js'
import type { InspectorReportStore } from './report-store.js'

export interface StartVueDoctorMcpOptions {
  store: InspectorReportStore
  version?: string
  onReady?: () => void
}

export async function startVueDoctorMcpServer(options: StartVueDoctorMcpOptions): Promise<McpServerHandle> {
  const baseDefinition = createVueDoctorDevframe({
    store: options.store,
    ...(options.version ? { version: options.version } : {})
  })
  let mountContext: DevframeNodeContext | undefined
  const definition: DevframeDefinition = {
    ...baseDefinition,
    async setup(context) {
      mountContext = context
      await baseDefinition.setup(context)
    }
  }
  let server: McpServerHandle | undefined
  try {
    server = await createMcpServer(definition, {
      transport: 'stdio',
      exposeSharedState: false,
      serverName: 'Vue Doctor',
      ...(options.version ? { serverVersion: options.version } : {}),
      onReady: options.onReady
    })
  } catch (error) {
    if (mountContext) disposeVueDoctorDevframeMount(baseDefinition, mountContext)
    throw error
  }

  let stopPromise: Promise<void> | undefined
  return {
    stop: () => stopPromise ??= server.stop().finally(() => {
      if (mountContext) disposeVueDoctorDevframeMount(baseDefinition, mountContext)
    })
  }
}

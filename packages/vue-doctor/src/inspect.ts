import type { InspectorServer, InspectorServerOptions } from './inspect-server.js'

/** Load the Inspector host only when a caller opens the workspace. */
export async function startInspectorServer(options: InspectorServerOptions): Promise<InspectorServer> {
  return (await import('./inspect-server.js')).startInspectorServer(options)
}

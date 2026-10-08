import { resolve } from 'node:path'
import { discoverSourceFiles } from './files.js'
import type { DiscoverTargetFilesOptions, TargetFiles } from './types.js'

/**
 * Resolve the effective diagnostic target once while retaining invalid scope/file
 * evidence. A valid empty allowlist is therefore distinct from failed discovery.
 */
export async function discoverTargetFiles(
  options: DiscoverTargetFilesOptions = {}
): Promise<TargetFiles> {
  const root = resolve(options.root ?? process.cwd())
  const discovery = await discoverSourceFiles(
    root,
    options.scope,
    options.extensions,
    options.files
  )
  return {
    root,
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.files !== undefined ? { requestedFiles: [...options.files] } : {}),
    files: discovery.files,
    issues: discovery.issues
  }
}

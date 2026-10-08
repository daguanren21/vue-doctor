import { access, readFile } from 'node:fs/promises'

export type PackageJson = {
  name?: string
  version?: string
  main?: string
  module?: string
  types?: string
  typings?: string
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  'web-types'?: string
  webTypes?: string
  vetur?: {
    tags?: string
    attributes?: string
  }
}

export async function readPackageJson(path: string): Promise<PackageJson | undefined> {
  try {
    await access(path)
  } catch {
    return undefined
  }

  return JSON.parse(await readFile(path, 'utf8')) as PackageJson
}

export function collectDeclaredDependencies(packageJson: PackageJson | undefined): Record<string, string> {
  if (!packageJson) {
    return {}
  }

  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
    ...packageJson.optionalDependencies
  }
}

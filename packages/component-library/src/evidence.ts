import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { collectArtifacts, listSearchableFiles } from './artifacts.js'
import { readPackageJson } from './package-json.js'
import type {
  ComponentLibraryEvidence,
  ComponentLibraryEvidenceOptions,
  FindPackageTextEvidenceOptions,
  PackageTextEvidence
} from './types.js'

export async function createComponentLibraryEvidence(
  options: ComponentLibraryEvidenceOptions
): Promise<ComponentLibraryEvidence> {
  const packageRoot = options.package.packageRoot
  const packageJsonPath = options.package.packageJsonPath
  const packageJson = packageJsonPath ? await readPackageJson(packageJsonPath) : undefined

  if (!packageRoot || !packageJson) {
    return {
      package: options.package,
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.cacheDirectory ? { cacheDirectory: options.cacheDirectory } : {}),
      artifacts: {
        declarationEntries: [],
        runtimeEntries: [],
        issues: []
      }
    }
  }

  return {
    package: options.package,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.cacheDirectory ? { cacheDirectory: options.cacheDirectory } : {}),
    artifacts: await collectArtifacts(packageRoot, packageJson, options.observedSubpaths)
  }
}

export async function findPackageTextEvidence(
  options: FindPackageTextEvidenceOptions
): Promise<PackageTextEvidence[]> {
  const evidence = await createComponentLibraryEvidence(options)
  const packageRoot = evidence.package.packageRoot
  if (!packageRoot) {
    return []
  }

  const files = await listSearchableFiles(packageRoot)
  const results: PackageTextEvidence[] = []

  for (const file of files) {
    const raw = await readFile(file.path, 'utf8')
    const lines = raw.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      const column = findColumn(line, options.query)
      if (column === -1) {
        continue
      }

      results.push({
        kind: 'package-text-match',
        packageName: evidence.package.canonicalName,
        path: file.path,
        relativePath: normalizeRelative(relative(packageRoot, file.path)),
        line: index + 1,
        column: column + 1,
        text: line.trim()
      })
    }
  }

  return results
}

function findColumn(line: string, query: string | RegExp) {
  if (typeof query === 'string') {
    return line.indexOf(query)
  }

  const match = line.match(query)
  return match?.index ?? -1
}

function normalizeRelative(path: string) {
  return path.split('\\').join('/')
}

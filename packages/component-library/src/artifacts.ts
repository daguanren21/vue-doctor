import { access, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { exports as resolveExports } from 'resolve.exports'
import type {
  ArtifactIssue,
  ComponentLibraryArtifacts,
  EvidenceFile
} from './types.js'
import type { PackageJson } from './package-json.js'

const runtimeExtensions = new Set(['.js', '.mjs', '.cjs'])
const searchableExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.json', '.d.ts'])
const ignoredDirectories = new Set(['node_modules', '.git', 'dist-storybook'])

export async function collectArtifacts(
  packageRoot: string,
  packageJson: PackageJson,
  observedSubpaths: string[] = []
): Promise<ComponentLibraryArtifacts> {
  const normalizedRoot = await normalizeRoot(packageRoot)
  const requests = uniqueRequests(observedSubpaths)
  const issues: ArtifactIssue[] = []
  const declarationEntries: EvidenceFile[] = []
  const runtimeEntries: EvidenceFile[] = []

  for (const entry of requests) {
    const resolved = await resolvePublicEntry(normalizedRoot, packageJson, entry)
    declarationEntries.push(...resolved.declarations)
    runtimeEntries.push(...resolved.runtime)

    if (entry !== '.' && resolved.declarations.length === 0 && resolved.runtime.length === 0) {
      issues.push({
        code: 'public-entry-unresolved',
        entry,
        message: `Observed public entry ${entry} resolves to no readable package file.`
      })
    }
  }

  const rootHasDeclarationTarget = hasRootExportDeclarationTarget(packageJson.exports)
  if (!rootHasDeclarationTarget && !declarationEntries.some((entry) => entry.entry === '.')) {
    const rootTypes = await createEvidenceFile(
      normalizedRoot,
      packageJson.types ?? packageJson.typings,
      'package-json',
      '.'
    )
    if (rootTypes) {
      declarationEntries.unshift(rootTypes)
    }
  }

  if (!hasRootExport(packageJson.exports)) {
    runtimeEntries.unshift(...await existingFiles(normalizedRoot, [
      packageJson.module,
      packageJson.main
    ], 'package-json', '.'))
  }

  const uniqueDeclarations = uniqueFiles(declarationEntries)
  const uniqueRuntime = uniqueFiles(runtimeEntries)
  const rootTypes = uniqueDeclarations.find((entry) => entry.entry === '.')

  return {
    types: rootTypes,
    declarationEntries: uniqueDeclarations,
    webTypes: await createEvidenceFile(
      normalizedRoot,
      packageJson['web-types'] ?? packageJson.webTypes,
      'package-json'
    ),
    veturTags: await createEvidenceFile(normalizedRoot, packageJson.vetur?.tags, 'package-json'),
    veturAttributes: await createEvidenceFile(
      normalizedRoot,
      packageJson.vetur?.attributes,
      'package-json'
    ),
    runtimeEntries: uniqueRuntime,
    issues
  }
}

type ResolvedEntry = {
  declarations: EvidenceFile[]
  runtime: EvidenceFile[]
}

async function resolvePublicEntry(
  packageRoot: string,
  packageJson: PackageJson,
  entry: string
): Promise<ResolvedEntry> {
  if (packageJson.exports === undefined) {
    return { declarations: [], runtime: [] }
  }

  const typeTargets = resolveConditionTargets(packageJson, entry, 'types')
  const importTargets = resolveConditionTargets(packageJson, entry, 'import')
  const requireTargets = resolveConditionTargets(packageJson, entry, 'require')
  const defaultTargets = resolveConditionTargets(packageJson, entry, 'default')
  const declarations = await resolveDeclarationFiles(
    packageRoot,
    [typeTargets, importTargets, requireTargets, defaultTargets],
    entry
  )
  const runtimeTargets = [...importTargets, ...requireTargets]
  if (runtimeTargets.length === 0) {
    runtimeTargets.push(...defaultTargets)
  }

  const runtime = await existingFiles(
    packageRoot,
    runtimeTargets.filter(isRuntimeEntry),
    'exports',
    entry
  )

  return {
    declarations: uniqueFiles(declarations),
    runtime: uniqueFiles(runtime)
  }
}

async function resolveDeclarationFiles(
  packageRoot: string,
  targetGroups: string[][],
  entry: string
) {
  for (const targets of targetGroups) {
    const declarations: EvidenceFile[] = []
    for (const target of targets) {
      const candidates = isDeclarationEntry(target) ? [target] : declarationCandidates(target)
      const file = await firstExistingFile(packageRoot, candidates, 'exports', entry)
      if (file) {
        declarations.push(file)
      }
    }

    if (declarations.length > 0) {
      return uniqueFiles(declarations)
    }
    if (targets.some(isDeclarationEntry)) {
      return []
    }
  }

  return []
}

function resolveTargets(
  packageJson: PackageJson,
  entry: string,
  options?: Parameters<typeof resolveExports>[2]
): string[] {
  try {
    return resolveExports(packageJson, entry, options) ?? []
  } catch {
    return []
  }
}

function resolveConditionTargets(
  packageJson: PackageJson,
  entry: string,
  condition: 'types' | 'import' | 'require' | 'default'
) {
  const projectedPackage = condition === 'default'
    ? packageJson
    : { ...packageJson, exports: disableDefaultCondition(packageJson.exports, condition) }
  const conditions = condition === 'default' ? [] : [condition, 'node']
  return resolveTargets(projectedPackage, entry, { conditions, unsafe: true })
}

function disableDefaultCondition(value: unknown, preferred: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => disableDefaultCondition(item, preferred))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const entries = Object.entries(value)
  const isSubpathMap = entries.some(([key]) => key.startsWith('.'))
  if (isSubpathMap) {
    return Object.fromEntries(
      entries.map(([key, item]) => [key, disableDefaultCondition(item, preferred)])
    )
  }

  return Object.fromEntries(
    entries
      .sort(([left], [right]) => conditionRank(left, preferred) - conditionRank(right, preferred))
      .map(([key, item]) => [
        key,
        key === 'default' ? null : disableDefaultCondition(item, preferred)
      ])
  )
}

function conditionRank(key: string, preferred: string) {
  if (key === preferred) {
    return 0
  }
  if (key === 'default') {
    return 2
  }
  return 1
}

function uniqueRequests(observedSubpaths: string[]) {
  const requests = ['.']
  const seen = new Set(requests)

  for (const observed of observedSubpaths) {
    const normalized = normalizeSubpath(observed)
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    requests.push(normalized)
  }

  return requests
}

function normalizeSubpath(subpath: string) {
  const trimmed = subpath.trim().replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
  if (!trimmed || trimmed.includes('*') || trimmed.split('/').includes('..')) {
    return undefined
  }
  return `./${trimmed}`
}

export async function listSearchableFiles(packageRoot: string): Promise<EvidenceFile[]> {
  const files: EvidenceFile[] = []
  await walk(packageRoot, files)
  return files
}

export function isSearchablePath(path: string) {
  if (path.endsWith('.d.ts')) {
    return true
  }

  const extension = path.slice(path.lastIndexOf('.'))
  return searchableExtensions.has(extension)
}

async function normalizeRoot(packageRoot: string) {
  const absoluteRoot = resolve(packageRoot)
  try {
    return await realpath(absoluteRoot)
  } catch {
    return absoluteRoot
  }
}

async function createEvidenceFile(
  packageRoot: string,
  value: string | undefined,
  source: EvidenceFile['source'],
  entry?: string
): Promise<EvidenceFile | undefined> {
  if (!value || value.includes('*')) {
    return undefined
  }

  const absolutePath = resolve(packageRoot, value)
  if (!isPathWithin(packageRoot, absolutePath)) {
    return undefined
  }

  try {
    await access(absolutePath)
    const stats = await stat(absolutePath)
    if (!stats.isFile()) {
      return undefined
    }
    const normalizedPath = await realpath(absolutePath)
    if (!isPathWithin(packageRoot, normalizedPath)) {
      return undefined
    }

    return {
      path: normalizedPath,
      relativePath: normalizeRelative(relative(packageRoot, normalizedPath)),
      source,
      ...(entry ? { entry } : {})
    }
  } catch {
    return undefined
  }
}

async function firstExistingFile(
  packageRoot: string,
  values: string[],
  source: EvidenceFile['source'],
  entry: string
) {
  for (const value of values) {
    const file = await createEvidenceFile(packageRoot, value, source, entry)
    if (file) {
      return file
    }
  }
  return undefined
}

async function existingFiles(
  packageRoot: string,
  values: Array<string | undefined>,
  source: EvidenceFile['source'],
  entry?: string
) {
  const files: EvidenceFile[] = []
  for (const value of values) {
    const file = await createEvidenceFile(packageRoot, value, source, entry)
    if (file) {
      files.push(file)
    }
  }
  return files
}

function declarationCandidates(path: string) {
  if (path.endsWith('.mjs')) {
    return [path.slice(0, -4) + '.d.mts', path.slice(0, -4) + '.d.ts']
  }
  if (path.endsWith('.cjs')) {
    return [path.slice(0, -4) + '.d.cts', path.slice(0, -4) + '.d.ts']
  }
  if (path.endsWith('.js')) {
    return [path.slice(0, -3) + '.d.ts', path.slice(0, -3) + '.d.mts', path.slice(0, -3) + '.d.cts']
  }
  return [`${path}.d.ts`, `${path}/index.d.ts`]
}

function isDeclarationEntry(path: string) {
  return /\.d\.(?:ts|mts|cts)$/.test(path)
}

function isRuntimeEntry(path: string) {
  const extension = path.slice(path.lastIndexOf('.'))
  return runtimeExtensions.has(extension)
}

function hasRootExport(exportsField: unknown) {
  if (exportsField === undefined) {
    return false
  }
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return true
  }
  if (!exportsField || typeof exportsField !== 'object') {
    return false
  }
  const keys = Object.keys(exportsField)
  return keys.some((key) => key.startsWith('.')) ? '.' in exportsField : true
}

function hasRootExportDeclarationTarget(exportsField: unknown) {
  if (!hasRootExport(exportsField)) {
    return false
  }
  const rootExport = rootExportValue(exportsField)
  return containsDeclarationTarget(rootExport)
}

function rootExportValue(exportsField: unknown): unknown {
  if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    return exportsField
  }
  const entries = Object.entries(exportsField)
  return entries.some(([key]) => key.startsWith('.'))
    ? (exportsField as Record<string, unknown>)['.']
    : exportsField
}

function containsDeclarationTarget(value: unknown, throughTypes = false): boolean {
  if (typeof value === 'string') {
    return throughTypes || isDeclarationEntry(value)
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsDeclarationTarget(item, throughTypes))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([condition, item]) => (
      containsDeclarationTarget(item, throughTypes || condition === 'types')
    ))
  }
  return false
}

function isPathWithin(root: string, path: string) {
  const relativePath = relative(root, path)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function uniqueFiles(files: Array<EvidenceFile | undefined>): EvidenceFile[] {
  const seen = new Set<string>()
  const result: EvidenceFile[] = []

  for (const file of files) {
    if (!file || seen.has(file.path)) {
      continue
    }

    seen.add(file.path)
    result.push(file)
  }

  return result
}

async function walk(directory: string, files: EvidenceFile[]) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.endsWith('.map')) {
      continue
    }

    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await walk(path, files)
      }
      continue
    }

    if (!entry.isFile() || !isSearchablePath(path)) {
      continue
    }

    const stats = await stat(path)
    if (stats.size > 512_000) {
      continue
    }

    files.push({
      path,
      relativePath: normalizeRelative(relative(directory, path)),
      source: 'discovered'
    })
  }
}

function normalizeRelative(path: string) {
  return path.split('\\').join('/')
}

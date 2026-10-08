import { createProjectInventory } from '@vue-doctor/core'
import type {
  ProjectApplicationContext,
  ProjectContext,
  ProjectContextIssue,
  ProjectInventory,
  ProjectPackageContext
} from '@vue-doctor/core'
import {
  analyzeProjectModuleContext,
  readProjectAliases,
  matchProjectAlias,
  type ProjectAlias,
  type SourceApplicationFact,
  type SourceGlobImport,
  type SourceModuleContext,
  type TargetFiles,
  type VueGlobalPluginUsage,
  type VueSourceUsageReport
} from '@vue-doctor/source'
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { escapePath, glob } from 'tinyglobby'

const moduleExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'] as const
const ignoredDirectories = new Set([
  '.git', '.nuxt', '.output', '.vite', 'coverage', 'dist', 'build', 'node_modules'
])

export interface BuildProjectContextOptions {
  root: string
  targetFiles: TargetFiles
  includePackages?: readonly string[]
}

export interface BuiltProjectContext {
  projectContext: ProjectContext
  /** Own properties are retained even when a package has no usable Vue version. */
  vueVersions: Record<string, string | undefined>
  applicationIds: Record<string, string | undefined>
  globalPlugins: VueGlobalPluginUsage[]
}

interface PackageGroup {
  root: string
  targets: string[]
  inventory: ProjectInventory
}

interface EntryGraph {
  files: Set<string>
  adjacency: Map<string, string[]>
  eagerAdjacency: Map<string, string[]>
  applications: SourceApplicationFact[]
  resolvedImports: Map<string, Map<string, string>>
  constructorPlugins: Map<string, NonNullable<SourceModuleContext['vueConstructorPlugins']>>
}

interface EntryCandidate {
  file: string
  trusted: boolean
}

export async function buildProjectContext(options: BuildProjectContextOptions): Promise<BuiltProjectContext> {
  const root = resolve(options.root)
  const issues: ProjectContextIssue[] = []
  const groupedTargets = await groupTargetsByPackage(root, options.targetFiles.files)
  const groups: PackageGroup[] = []

  for (const [packageRoot, targets] of [...groupedTargets].sort(([left], [right]) => compareText(left, right))) {
    let inventory: ProjectInventory
    try {
      inventory = await createProjectInventory({
        root: packageRoot,
        includePackages: [...(options.includePackages ?? [])]
      })
    } catch (error) {
      inventory = { root: packageRoot, packages: {} }
      issues.push({
        code: 'package-resolution-failed',
        file: join(packageRoot, 'package.json'),
        message: `Package inventory could not be resolved: ${errorMessage(error)}`,
        targetFiles: [...targets]
      })
    }
    groups.push({ root: packageRoot, targets: [...targets].sort(compareText), inventory })
  }

  const applications: ProjectApplicationContext[] = []
  const files = new Set<string>()
  const applicationIds: Record<string, string | undefined> = {}
  const vueVersions: Record<string, string | undefined> = {}

  for (const group of groups) {
    const vueVersion = group.inventory.vue?.installedVersion ?? group.inventory.vue?.declaredVersion
    for (const target of group.targets) vueVersions[target] = vueVersion
    const candidates = await discoverEntryCandidates(group.root, issues, group.targets)
    const graph = await readEntryGraph(group, candidates, issues)
    for (const file of graph.files) files.add(file)
    const packageApplications = materializeApplications(root, group, graph, issues)
    applications.push(...packageApplications)
    assignApplicationsToTargets(group.targets, packageApplications, applicationIds)
  }

  const packages: ProjectPackageContext[] = groups.map((group) => ({
    root: group.root,
    inventory: group.inventory,
    targetFiles: group.targets
  }))
  const stableApplications = applications.sort((left, right) => compareText(left.id, right.id))
  const globalPlugins = stableApplications.flatMap((application) => application.plugins.map((plugin) => ({
    ...plugin,
    applicationId: application.id
  })))

  return {
    projectContext: {
      root,
      packages,
      applications: stableApplications,
      files: [...files].sort(compareText),
      issues: stabilizeIssues(issues)
    },
    vueVersions,
    applicationIds,
    globalPlugins
  }
}

/** Attach app identity without widening the diagnostic target set. */
export function contextualizeSourceUsage(
  built: BuiltProjectContext,
  source: VueSourceUsageReport
): VueSourceUsageReport {
  const components = source.components.map((usage) => {
    const applicationId = built.applicationIds[usage.file]
    return applicationId ? { ...usage, applicationId } : usage
  })
  const relevantUnownedFiles = [...new Set(components
    .filter((usage) => usage.origin === undefined && usage.applicationId === undefined)
    .map((usage) => usage.file))]
  const ownershipIssues = relevantUnownedFiles.map((file): ProjectContextIssue => {
    const roots = built.projectContext.applications.filter((application) => application.rootComponentFiles.includes(file))
    const candidates = roots.length > 0
      ? roots
      : built.projectContext.applications.filter((application) => application.reachableFiles.includes(file))
    return candidates.length > 1
      ? {
          code: 'application-ownership-ambiguous',
          file,
          message: `Target belongs to multiple Vue applications: ${candidates.map((item) => item.id).sort(compareText).join(', ')}.`,
          targetFiles: [file]
        }
      : {
          code: 'application-ownership-unavailable',
          file,
          message: 'Global component usage could not be associated with a statically verified Vue application.',
          targetFiles: [file]
        }
  })
  built.projectContext.issues = stabilizeIssues([
    ...built.projectContext.issues,
    ...ownershipIssues
  ])
  return {
    ...source,
    components,
    globalPlugins: built.globalPlugins
  }
}

async function groupTargetsByPackage(root: string, targets: readonly string[]): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>()
  for (const target of targets) {
    const packageRoot = await findConsumingPackageRoot(root, target)
    const existing = groups.get(packageRoot)
    if (existing) existing.push(target)
    else groups.set(packageRoot, [target])
  }
  return groups
}

async function findConsumingPackageRoot(root: string, file: string): Promise<string> {
  let current = dirname(file)
  while (isInside(root, current)) {
    if (await exists(join(current, 'package.json'))) return current
    if (current === root) break
    current = dirname(current)
  }
  return root
}

async function discoverEntryCandidates(
  packageRoot: string,
  issues: ProjectContextIssue[],
  targets: readonly string[]
): Promise<EntryCandidate[]> {
  const candidates = new Map<string, boolean>()
  const addCandidate = (file: string, trusted: boolean) => {
    candidates.set(file, Boolean(candidates.get(file)) || trusted)
  }
  const htmlFiles: string[] = []
  const visit = async (directory: string): Promise<void> => {
    if (directory !== packageRoot && await exists(join(directory, 'package.json'))) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      issues.push({
        code: 'entry-discovery-failed',
        file: directory,
        message: `Entry directory could not be read: ${errorMessage(error)}`
      })
      return
    }
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith('.')) await visit(path)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (/^main\.(?:[cm]?[jt]sx?)$/i.test(entry.name)) {
          const parent = dirname(path)
          addCandidate(path, parent === packageRoot || parent === join(packageRoot, 'src'))
        }
        if (entry.name === 'index.html') htmlFiles.push(path)
      }
    }
  }
  await visit(packageRoot)

  for (const conventional of [
    ...moduleExtensions.flatMap((extension) => [
      join(packageRoot, `index${extension}`),
      join(packageRoot, 'src', `index${extension}`)
    ])
  ]) if (await isFile(conventional)) addCandidate(conventional, true)

  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    for (const field of ['source', 'module', 'main']) {
      const value = manifest[field]
      if (typeof value !== 'string' || !isProjectSpecifier(value)) continue
      const resolved = await resolveModuleSpecifier(join(packageRoot, 'package.json'), value, packageRoot)
      if (resolved) addCandidate(resolved, true)
    }
  } catch {
    // Inventory records malformed package manifests; missing manifests are valid roots.
  }

  for (const htmlFile of htmlFiles) {
    const trusted = htmlFile === join(packageRoot, 'index.html') || targets.includes(htmlFile)
    try {
      const html = await readFile(htmlFile, 'utf8')
      for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
        const attributes = match[1] ?? ''
        if (!/\btype\s*=\s*["']module["']/i.test(attributes)) continue
        const specifier = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]?.trim()
        if (!specifier || /^(?:https?:)?\/\//i.test(specifier)) continue
        const resolved = await resolveModuleSpecifier(htmlFile, specifier, packageRoot)
        if (resolved) addCandidate(resolved, trusted)
        else if (trusted) issues.push({
          code: 'entry-import-unresolved',
          file: htmlFile,
          message: `Vite module entry ${specifier} could not be resolved.`
        })
      }
    } catch (error) {
      if (trusted) issues.push({
        code: 'entry-discovery-failed',
        file: htmlFile,
        message: `Vite HTML entry could not be read: ${errorMessage(error)}`
      })
    }
  }
  return [...candidates]
    .map(([file, trusted]) => ({ file, trusted }))
    .sort((left, right) => compareText(left.file, right.file))
}

async function readEntryGraph(
  group: PackageGroup,
  candidates: readonly EntryCandidate[],
  issues: ProjectContextIssue[]
): Promise<EntryGraph> {
  let aliases: ProjectAlias[] = []
  try {
    aliases = await readProjectAliases(group.root, async (file) => {
      if (!await exists(file)) return undefined
      if (!await isSafeProjectPath(group.root, file)) throw new Error(`Alias configuration ${file} is outside its consuming package.`)
      return readFile(file, 'utf8')
    })
  } catch (error) {
    issues.push({ code: 'entry-import-unresolved', file: group.root, message: errorMessage(error) })
  }
  const graph: EntryGraph = {
    files: new Set(),
    adjacency: new Map(),
    eagerAdjacency: new Map(),
    applications: [],
    resolvedImports: new Map(),
    constructorPlugins: new Map()
  }
  for (const candidate of candidates) {
    const candidateIssues: ProjectContextIssue[] = []
    const candidateGraph = await readEntryCandidateGraph(group, candidate.file, candidateIssues, aliases)
    const relevant = candidate.trusted
      || candidateGraph.applications.length > 0
      || group.targets.some((target) => candidateGraph.files.has(target))
    if (!relevant) continue
    for (const file of candidateGraph.files) graph.files.add(file)
    for (const [file, imports] of candidateGraph.adjacency) {
      graph.adjacency.set(file, [...new Set([...(graph.adjacency.get(file) ?? []), ...imports])].sort(compareText))
    }
    graph.applications.push(...candidateGraph.applications)
    for (const [file, imports] of candidateGraph.resolvedImports) graph.resolvedImports.set(file, imports)
    for (const [file, plugins] of candidateGraph.constructorPlugins) graph.constructorPlugins.set(file, plugins)
    for (const [file, imports] of candidateGraph.eagerAdjacency) graph.eagerAdjacency.set(file, imports)
    issues.push(...candidateIssues)
  }
  return graph
}

async function readEntryCandidateGraph(
  group: PackageGroup,
  candidate: string,
  issues: ProjectContextIssue[],
  aliases: readonly ProjectAlias[]
): Promise<EntryGraph> {
  const files = new Set<string>()
  const adjacency = new Map<string, string[]>()
  const eagerAdjacency = new Map<string, string[]>()
  const applications: SourceApplicationFact[] = []
  const resolvedSpecifiers = new Map<string, Map<string, string>>()
  const constructorPlugins = new Map<string, NonNullable<SourceModuleContext['vueConstructorPlugins']>>()
  const pending = [candidate]
  const vueImportRoots = group.inventory.vue?.importRoots ?? ['vue']

  while (pending.length > 0) {
    const file = pending.shift()!
    if (files.has(file)) continue
    if (!await isSafeProjectPath(group.root, file)) {
      issues.push({
        code: 'entry-discovery-failed',
        file,
        message: 'Entry candidate resolves outside its consuming package.'
      })
      continue
    }
    files.add(file)
    let context: SourceModuleContext
    try {
      context = analyzeProjectModuleContext(file, await readFile(file, 'utf8'), { vueImportRoots })
    } catch (error) {
      issues.push({ code: 'entry-parse-failed', file, message: `Entry module could not be read: ${errorMessage(error)}` })
      continue
    }
    for (const error of context.errors) {
      issues.push({ code: 'entry-parse-failed', file, message: `Entry module could not be parsed: ${error}` })
    }
    for (const message of context.unresolvedImports) {
      issues.push({ code: 'entry-import-unresolved', file, message })
    }
    applications.push(...context.applications)
    constructorPlugins.set(file, context.vueConstructorPlugins ?? [])
    const importsBySpecifier = new Map<string, string>()
    resolvedSpecifiers.set(file, importsBySpecifier)
    const eagerImports = new Set(context.eagerImports ?? [])
    const resolvedEagerImports: string[] = []
    const resolvedImports: string[] = []
    for (const specifier of context.imports) {
      if (unsupportedContextExtension(specifier)) continue
      const aliasTargets = matchProjectAlias(stripQuery(specifier), aliases)
      if (aliasTargets === undefined && isUnknownAlias(specifier)) {
        issues.push({
          code: 'entry-import-unresolved',
          file,
          message: `Import alias ${specifier} has no explicit trusted resolution evidence.`
        })
        continue
      }
      if (aliasTargets === undefined && !isProjectSpecifier(specifier)) continue
      let resolved: string | undefined
      if (aliasTargets !== undefined) {
        for (const target of aliasTargets) {
          resolved = await resolveModuleBase(target, group.root)
          if (resolved) break
        }
      } else {
        resolved = await resolveModuleSpecifier(file, specifier, group.root)
      }
      if (!resolved) {
        issues.push({
          code: 'entry-import-unresolved',
          file,
          message: `Project import ${specifier} could not be resolved.`
        })
        continue
      }
      resolvedImports.push(resolved)
      importsBySpecifier.set(specifier, resolved)
      if (eagerImports.has(specifier)) resolvedEagerImports.push(resolved)
      if (!files.has(resolved)) pending.push(resolved)
    }
    for (const globImport of context.globImports ?? []) {
      try {
        const matches = await resolveGlobImport(file, globImport, group.root, aliases)
        for (const resolved of matches) {
          resolvedImports.push(resolved)
          if (globImport.eager) resolvedEagerImports.push(resolved)
          if (!files.has(resolved)) pending.push(resolved)
        }
      } catch (error) {
        issues.push({ code: 'entry-import-unresolved', file, message: errorMessage(error) })
      }
    }
    adjacency.set(file, [...new Set(resolvedImports)].sort(compareText))
    eagerAdjacency.set(file, [...new Set(resolvedEagerImports)].sort(compareText))
  }

  return { files, adjacency, eagerAdjacency, applications, resolvedImports: resolvedSpecifiers, constructorPlugins }
}

function materializeApplications(
  projectRoot: string,
  group: PackageGroup,
  graph: EntryGraph,
  issues: ProjectContextIssue[]
): ProjectApplicationContext[] {
  const applications = new Map<string, ProjectApplicationContext>()
  for (const fact of graph.applications) {
    const packageIdentity = relative(projectRoot, group.root).split(sep).join('/') || '.'
    const id = `${packageIdentity}:${relative(group.root, fact.file).split(sep).join('/')}#${fact.appLocalName}`
    const rootComponent = fact.rootComponentImport
      ? graph.resolvedImports.get(fact.file)?.get(fact.rootComponentImport)
      : undefined
    if (fact.rootComponentImport && !rootComponent) {
      issues.push({
        code: 'entry-import-unresolved',
        file: fact.file,
        message: `Vue root component ${fact.rootComponentImport} could not be associated with the entry graph.`
      })
    }
    const entryReachable = collectReachable(fact.file, graph.adjacency)
    const reachableFiles = rootComponent && fact.framework !== 'vue2.7'
      ? [...collectReachable(rootComponent, graph.adjacency), fact.file]
      : [...entryReachable]
    const constructorPlugins = fact.framework === 'vue2.7' && fact.vueConstructorImport
      ? [...collectReachable(fact.file, graph.eagerAdjacency)].flatMap((file) => (graph.constructorPlugins.get(file) ?? [])
        .filter((registration) => registration.constructorImport === fact.vueConstructorImport)
        .flatMap((registration) => registration.plugins))
      : []
    const next: ProjectApplicationContext = {
      id,
      entryFile: fact.file,
      packageRoot: group.root,
      framework: fact.framework,
      rootComponentFiles: rootComponent ? [rootComponent] : [],
      reachableFiles: [...new Set(reachableFiles)].sort(compareText),
      plugins: deduplicatePlugins([...fact.plugins, ...constructorPlugins])
    }
    const previous = applications.get(id)
    applications.set(id, previous ? {
      ...previous,
      rootComponentFiles: [...new Set([...previous.rootComponentFiles, ...next.rootComponentFiles])].sort(compareText),
      reachableFiles: [...new Set([...previous.reachableFiles, ...next.reachableFiles])].sort(compareText),
      plugins: deduplicatePlugins([...previous.plugins, ...next.plugins])
    } : next)
  }
  return [...applications.values()]
}

function assignApplicationsToTargets(
  targets: readonly string[],
  applications: readonly ProjectApplicationContext[],
  applicationIds: Record<string, string | undefined>
): void {
  for (const target of targets) {
    applicationIds[target] = undefined
    const roots = applications.filter((application) => application.rootComponentFiles.includes(target))
    const candidates = roots.length > 0
      ? roots
      : applications.filter((application) => application.reachableFiles.includes(target))
    if (candidates.length === 1) {
      applicationIds[target] = candidates[0]!.id
    }
  }
}

function collectReachable(start: string, adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
  const reachable = new Set<string>()
  const pending = [start]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (reachable.has(file)) continue
    reachable.add(file)
    pending.push(...(adjacency.get(file) ?? []))
  }
  return reachable
}

async function resolveGlobImport(
  importer: string,
  globImport: SourceGlobImport,
  packageRoot: string,
  aliases: readonly ProjectAlias[]
): Promise<string[]> {
  const patterns: string[] = []
  for (const raw of globImport.patterns) {
    const negative = raw.startsWith('!')
    const specifier = negative ? raw.slice(1) : raw
    if (!specifier || /[\\\0]/.test(specifier)) throw new Error(`Unsupported import.meta.glob pattern ${raw}.`)
    let dynamicDirectory = false
    for (const segment of specifier.split('/')) {
      if (dynamicDirectory && (segment === '.' || segment === '')) {
        throw new Error(`Glob pattern ${raw} requires mode-dependent dynamic-directory normalization.`)
      }
      if (/[*?[\]{}()!]/.test(segment)) dynamicDirectory = true
    }
    const targets = matchProjectAlias(specifier, aliases)
    // Ordered TS path fallbacks are not equivalent to a bundler glob alias.
    if (targets && targets.length !== 1) throw new Error(`Glob alias ${specifier} does not have one trusted target.`)
    if (!targets && !isProjectSpecifier(specifier)) throw new Error(`Glob alias ${specifier} has no explicit trusted resolution evidence.`)
    const target = targets?.[0] ?? (specifier.startsWith('/')
      ? join(packageRoot, specifier.slice(1))
      : join(dirname(importer), specifier))
    if (!isInside(packageRoot, target) || specifier.split('/').some((part, index, parts) => (
      part === '..' && parts.slice(0, index).some(segment => /[*?[\]{}()!]/.test(segment))
    ))) throw new Error(`Glob pattern ${raw} is outside its consuming package or traverses a dynamic directory.`)
    // Resolution adds literal directories; only the unchanged caller suffix is glob syntax.
    const normalizedTarget = target.split(sep).join('/')
    let suffixLength = 0
    while (suffixLength < Math.min(normalizedTarget.length, specifier.length)
      && normalizedTarget[normalizedTarget.length - suffixLength - 1] === specifier[specifier.length - suffixLength - 1]) suffixLength++
    const boundary = normalizedTarget.length - suffixLength
    const pattern = escapePath(normalizedTarget.slice(0, boundary)) + normalizedTarget.slice(boundary)
    patterns.push(`${negative ? '!' : ''}${pattern}`)
  }
  if (!patterns.some(pattern => !pattern.startsWith('!'))) return []
  const matches = await glob(patterns, {
    cwd: packageRoot,
    absolute: true,
    onlyFiles: true,
    expandDirectories: false,
    extglob: false,
    followSymbolicLinks: false,
    ignore: [...ignoredDirectories].map(directory => `**/${directory}/**`)
  })
  const resolved: string[] = []
  for (const file of matches.sort(compareText)) {
    if (unsupportedContextExtension(file) || /\.d\.[cm]?ts$/.test(file)) continue
    if (!await isSafeProjectPath(packageRoot, file)) continue
    resolved.push(file)
  }
  return resolved
}

async function resolveModuleSpecifier(fromFile: string, rawSpecifier: string, packageRoot: string): Promise<string | undefined> {
  const specifier = stripQuery(rawSpecifier)
  const base = isAbsolute(specifier)
    ? specifier.startsWith('/') && !specifier.startsWith(packageRoot)
      ? resolve(packageRoot, `.${specifier}`)
      : specifier
    : resolve(dirname(fromFile), specifier)
  return resolveModuleBase(base, packageRoot)
}

async function resolveModuleBase(base: string, packageRoot: string): Promise<string | undefined> {
  if (!isInside(packageRoot, base)) return undefined
  const candidates = extname(base)
    ? [base]
    : [base, ...moduleExtensions.map((extension) => `${base}${extension}`), ...moduleExtensions.map((extension) => join(base, `index${extension}`))]
  for (const candidate of candidates) {
    if (await isFile(candidate) && await isSafeProjectPath(packageRoot, candidate)) return candidate
  }
  return undefined
}


function isProjectSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/')
}

function isUnknownAlias(specifier: string): boolean {
  return specifier.startsWith('#') || specifier.startsWith('@/') || specifier.startsWith('~/')
}

function unsupportedContextExtension(specifier: string): boolean {
  const extension = extname(stripQuery(specifier)).toLowerCase()
  return Boolean(extension && !moduleExtensions.includes(extension as typeof moduleExtensions[number]))
}

function stripQuery(specifier: string): string {
  const queryStart = specifier.search(/[?]|(?!^)#/)
  return queryStart < 0 ? specifier : specifier.slice(0, queryStart)
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isSafeProjectPath(root: string, candidate: string): Promise<boolean> {
  if (!isInside(root, candidate)) return false
  try {
    const [physicalRoot, physicalCandidate] = await Promise.all([realpath(root), realpath(candidate)])
    if (!isInside(physicalRoot, physicalCandidate)) return false
    for (const [boundary, file] of [[root, candidate], [physicalRoot, physicalCandidate]] as const) {
      if (relative(boundary, file).split(sep).includes('node_modules')) return false
      let directory = dirname(file)
      while (directory !== boundary && isInside(boundary, directory)) {
        if (await exists(join(directory, 'package.json'))) return false
        directory = dirname(directory)
      }
    }
    return true
  } catch {
    return false
  }
}

function deduplicatePlugins(plugins: ProjectApplicationContext['plugins']): ProjectApplicationContext['plugins'] {
  const seen = new Set<string>()
  return plugins.filter((plugin) => {
    const key = `${plugin.file}\0${plugin.localName}\0${plugin.package.specifier}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function stabilizeIssues(issues: ProjectContextIssue[]): ProjectContextIssue[] {
  const seen = new Set<string>()
  return issues
    .sort((left, right) => (
      compareText(left.file ?? '', right.file ?? '')
      || compareText(left.code, right.code)
      || compareText(left.message, right.message)
    ))
    .filter((issue) => {
      const key = `${issue.code}\0${issue.file ?? ''}\0${issue.message}\0${issue.targetFiles?.join('\0') ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

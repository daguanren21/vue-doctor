import { createComponentLibraryEvidence } from '@vue-doctor/component-library'
import {
  applyDoctorConfigToDiagnostics,
  applyDoctorRuleMetadata,
  classifyVueFramework,
  createDoctorDomainCoverage,
  createDoctorRuleRegistry,
  createProjectInventory,
  isDoctorRuleEnabled,
  loadDoctorConfig,
  mergeDoctorConfig,
  resolveConfiguredUiLibraries,
  resolveDoctorRunOptions,
  validateConfiguredDoctorRuleCodes
} from '@vue-doctor/core'
import type {
  DoctorCoverage,
  DoctorConfig,
  DoctorReport,
  DoctorRuleCatalog,
  DoctorRuleDefinition,
  DoctorRunOptions,
  EvidenceLocation,
  Diagnostic,
  PackageResolution,
  ProjectInventory,
  RuleSeveritySetting,
  SkippedCheck,
  UiLibraryConfig
} from '@vue-doctor/core'
import {
  discoverProjectEslintRulePack,
  type DiscoveredProjectEslintRulePack,
  type ProjectEslintPackageRequest
} from '@vue-doctor/rule-pack-eslint'
import { diagnoseComponentLibraryUsageResult } from '@vue-doctor/rule-pack-component-library'
import { componentLibraryRuleDefinitions } from '@vue-doctor/rule-pack-component-library/rules'
import {
  discoverTargetFiles,
  extractDoctorSuppressions,
  readSourceDocuments,
  type TargetFiles
} from '@vue-doctor/source'
import { access, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { scanDoctorSource } from './source-analysis.js'
import { analyzeComponentLibraries } from './analysis.js'
import { enrichDiagnosticsWithGitAttribution } from './git-attribution.js'
import { runRulePacks, selectRulePackSourceExtensions } from './rule-packs.js'
import { createBuiltinDoctorChecks } from './builtin-checks.js'
import { createBuiltinRuleComposition } from './builtin-composition.js'
import { buildProjectContext, contextualizeSourceUsage } from './context.js'
import { finalizeDoctorReport } from './report-contract.js'
import {
  createDoctorAnalysisSession,
  type DoctorRunGenerationContext
} from './session.js'

export async function runDoctor(options: DoctorRunOptions = {}): Promise<DoctorReport> {
  const session = createDoctorAnalysisSession(options)
  try {
    return await session.run()
  } finally {
    await session.close()
  }
}

/** Execute one uncached generation for an analysis session. */
export async function runDoctorGeneration(
  options: DoctorRunOptions = {},
  generationContext: DoctorRunGenerationContext
): Promise<DoctorReport> {
  const root = resolve(options.root ?? process.cwd())
  const config = await measurePhase(generationContext, 'config', async () => {
    const loaded = await loadDoctorConfig({ root, configFile: options.configFile })
    const merged = mergeDoctorConfig(loaded.config, options.config)
    options.onConfigResolved?.(merged)
    return merged
  })
  const configuredRules = config.rules ?? {}
  const eslintMode = config.eslint?.mode ?? 'auto'
  const staticComposition = createBuiltinRuleComposition()
  const withoutStaticEslint = {
    catalogs: staticComposition.catalogs.filter(catalog => catalog.name !== 'eslint'),
    packs: staticComposition.packs.filter(pack => pack.name !== 'eslint')
  }
  const discoveryComposition = eslintMode === 'off' ? withoutStaticEslint : staticComposition
  const configuredUiLibraries = resolveConfiguredUiLibraries(config)
  const inventory = await measurePhase(generationContext, 'inventory', () => (
    createProjectInventory({
      root,
      includePackages: configuredUiLibraries.map((library) => library.package)
    })
  ))
  const resolved = resolveDoctorRunOptions(options, config)
  const vueVersion = inventory.vue?.installedVersion ?? inventory.vue?.declaredVersion
  let targetFiles = freezeTargetFiles(await measurePhase(
    generationContext,
    'targetDiscovery',
    () => discoverTargetFiles({
      root: inventory.root,
      scope: resolved.scope,
      files: resolved.files,
      extensions: [
        ...selectTargetSourceExtensions(
          [...discoveryComposition.packs, ...(config.rulePacks ?? [])],
          configuredRules
        )
      ]
    })
  ))
  let builtContext = await measurePhase(generationContext, 'projectContext', () => (
    buildProjectContext({
      root: inventory.root,
      targetFiles,
      includePackages: configuredUiLibraries.map((library) => library.package)
    })
  ))
  let projectEslint: DiscoveredProjectEslintRulePack | undefined
  try {
    if (eslintMode === 'auto' || eslintMode === 'project') {
      projectEslint = await discoverProjectEslintRulePack({
        root: inventory.root,
        configFile: config.eslint?.configFile,
        packages: await projectEslintPackageRequests(inventory.root, targetFiles, builtContext.projectContext.packages.map(item => item.root))
      })
      if (!projectEslint && eslintMode === 'project') {
        throw new Error('Doctor config eslint.mode "project" requires an eslint.config.* file in the project.')
      }
      if (projectEslint) {
        const mergedFiles = [...new Set([...targetFiles.files, ...projectEslint.files])].sort(compareText)
        if (mergedFiles.length !== targetFiles.files.length) {
          targetFiles = freezeTargetFiles({ ...targetFiles, files: mergedFiles })
          builtContext = await measurePhase(generationContext, 'projectContext', () => (
            buildProjectContext({
              root: inventory.root,
              targetFiles,
              includePackages: configuredUiLibraries.map((library) => library.package)
            })
          ))
          const preparedRoots = new Set(projectEslint.packageRoots.map(packageRoot => resolve(packageRoot)))
          const discoveredRoots = builtContext.projectContext.packages.map(item => resolve(item.root))
          if (discoveredRoots.some(packageRoot => !preparedRoots.has(packageRoot))) {
            await projectEslint.dispose()
            projectEslint = await discoverProjectEslintRulePack({
              root: inventory.root,
              configFile: config.eslint?.configFile,
              packages: await projectEslintPackageRequests(inventory.root, targetFiles, discoveredRoots)
            })
            if (!projectEslint && eslintMode === 'project') {
              throw new Error('Doctor config eslint.mode "project" requires an eslint.config.* file in the project.')
            }
            if (projectEslint) {
              const finalFiles = [...new Set([...targetFiles.files, ...projectEslint.files])].sort(compareText)
              if (finalFiles.length !== targetFiles.files.length) {
                targetFiles = freezeTargetFiles({ ...targetFiles, files: finalFiles })
                builtContext = await measurePhase(generationContext, 'projectContext', () => (
                  buildProjectContext({
                    root: inventory.root,
                    targetFiles,
                    includePackages: configuredUiLibraries.map(library => library.package)
                  })
                ))
              }
            }
          }
        }
      }
    }
    const sourcePacks = [
      ...(projectEslint || eslintMode === 'off' ? withoutStaticEslint : staticComposition).packs,
      ...(config.rulePacks ?? [])
    ]
    const scannedSource = await measurePhase(generationContext, 'sourceAnalysis', () => (
      scanDoctorSource({
        targetFiles,
        vueVersion,
        vueVersions: builtContext.vueVersions,
        analysisProfiles: sourcePacks.flatMap((pack) => (
          pack.rules.some((rule) => isDoctorRuleEnabled(rule, configuredRules))
            ? pack.sourceAnalysisProfiles ?? []
            : []
        )),
        workspace: generationContext.sourceWorkspace
      })
    ))
    const preparedEslint = await projectEslint?.prepare(scannedSource.sourceTexts)
    const composition = preparedEslint
      ? {
          catalogs: [...withoutStaticEslint.catalogs, { name: 'eslint', rules: preparedEslint.pack.rules }],
          packs: [...withoutStaticEslint.packs, preparedEslint.pack]
        }
      : eslintMode === 'off' ? withoutStaticEslint : staticComposition
    const executionPacks = [...composition.packs, ...(config.rulePacks ?? [])]
    const catalogs = [
      ...composition.catalogs,
      ...(config.rulePacks?.map((pack) => ({ name: pack.name, rules: pack.rules })) ?? [])
    ]
    const ruleRegistry = createDoctorRuleRegistry(catalogs.map((catalog) => catalog.rules))
    validateConfiguredDoctorRuleCodes(configuredRules, ruleRegistry)
    if (preparedEslint) validateProjectEslintOverrides(configuredRules, preparedEslint.hostDisabledRuleCodes)
    const source = contextualizeSourceUsage(builtContext, scannedSource.source)
    const allVueDiagnostics = scannedSource.diagnostics
    const observedPackageNames = new Set([
      ...source.components.flatMap((usage) => usage.origin?.package?.packageName
        ? [usage.origin.package.packageName]
        : []),
      ...source.globalPlugins.flatMap((plugin) => plugin.package.packageName
        ? [plugin.package.packageName]
        : [])
    ])
    const packageIdentities = selectComponentLibraryPackages(
      collectProjectPackages(inventory, builtContext.projectContext.packages.map((item) => item.inventory)),
      configuredUiLibraries,
      config.ui?.autoDetect !== false,
      observedPackageNames
    )
    const libraries = await measurePhase(generationContext, 'componentContracts', () => (
      Promise.all(packageIdentities.map((packageIdentity) => (
        createComponentLibraryEvidence({
          runtime: config.ui?.runtimeContracts === true,
          cache: true,
          package: packageIdentity,
          observedSubpaths: source.components
            .filter((usage) => usage.origin?.kind === 'direct-import'
              && usage.origin.package
              && packageIdentity.importRoots.includes(usage.origin.package.packageName))
            .map((usage) => usage.origin!.package!.subpath)
            .filter((subpath): subpath is string => subpath !== undefined)
        })
      )))
    ))
    const configuredNames = new Set(configuredUiLibraries.map((library) => library.package))
    const candidateLibraries = libraries.filter((library) => (
      library.package.source === 'installed'
      || configuredNames.has(library.package.dependencyName)
      || configuredNames.has(library.package.canonicalName)
    ))
    const analysis = await measurePhase(generationContext, 'componentAnalysis', () => (
      analyzeComponentLibraries({
        source,
        libraries: candidateLibraries,
        vueVersions: builtContext.vueVersions,
        projectContext: builtContext.projectContext,
        contextIssues: builtContext.projectContext.issues
      })
    ))
    for (const file of scannedSource.invalidEncodingFiles) {
      if (analysis.coverage.source.failedFiles.some(failure => failure.file === file)) continue
      analysis.coverage.source.failedFiles.push({
        file, block: 'document',
        message: 'Source file contains invalid UTF-8 encoding; analysis evidence is incomplete.'
      })
    }
    if (scannedSource.invalidEncodingFiles.size) {
      if (analysis.coverage.source.status === 'complete') analysis.coverage.source.status = 'partial'
      if (analysis.coverage.status === 'complete') analysis.coverage.status = 'partial'
    }
    const { componentResult, builtin } = await measurePhase(
      generationContext,
      'builtinRules',
      async () => {
        const componentResult = diagnoseComponentLibraryUsageResult({
          matches: analysis.matches,
          vueVersion,
          vueVersions: builtContext.vueVersions
        })
        const builtin = createBuiltinDoctorChecks({
          source,
          matches: analysis.matches,
          rules: configuredRules,
          vueVersion,
          vueVersions: builtContext.vueVersions,
          componentSkippedChecks: componentResult.skippedChecks
        })
        return { componentResult, builtin }
      }
    )
    const componentRuleCodes = new Set<string>(componentLibraryRuleDefinitions.map((rule) => rule.code))
    const componentSkippedChecks = builtin.skippedChecks.filter((skipped) => componentRuleCodes.has(skipped.ruleCode))
    applyRequiredComponentSkipCoverage(analysis.coverage, componentSkippedChecks)
    const componentDiagnostics = componentResult.diagnostics.filter((diagnostic) => isDoctorRuleEnabled(
        requireRegisteredRule(ruleRegistry, diagnostic.code),
        configuredRules
      ))
    const vueDiagnostics = allVueDiagnostics.filter((diagnostic) => isDoctorRuleEnabled(
      requireRegisteredRule(ruleRegistry, diagnostic.code),
      configuredRules
    ))
    const sourceExtensions = selectRulePackSourceExtensions(
      executionPacks,
      configuredRules,
      {
        vueVersion,
        vueVersions: builtContext.vueVersions,
        files: targetFiles.files
      }
    )
    const documents = await measurePhase(generationContext, 'documents', async () => (
      sourceExtensions.length || projectEslint?.files.length
        ? readSourceDocuments(inventory.root, {
            targetFiles,
            sourceTexts: scannedSource.sourceTexts,
            invalidEncodingFiles: scannedSource.invalidEncodingFiles,
            readFailures: scannedSource.readFailures,
            preparedDocuments: scannedSource.preparedDocuments
          })
        : undefined
    ))
    const packContext = {
            inventory,
            source,
            components: source.components.map((usage, index) => ({
              usage,
              ownership: analysis.ownership[index]!
            })),
            rules: configuredRules,
            projectContext: builtContext.projectContext,
            targetFiles,
            sourceFacts: scannedSource.sourceFacts,
            ...(documents ? { documents } : {})
          }
    const builtinExtra = await measurePhase(generationContext, 'builtinRules', () => runRulePacks(composition.packs, structuredClone(packContext)))
    const extra = config.rulePacks?.length
        ? await measurePhase(generationContext, 'externalRules', () => runRulePacks(config.rulePacks!, structuredClone(packContext)))
        : undefined
    if ([...builtinExtra.reports, ...(extra?.reports ?? [])].some(pack => pack.coverageStatus !== 'complete') && analysis.coverage.status === 'complete') {
      analysis.coverage.status = 'partial'
    }
    const configuredDiagnostics = applyDoctorRuleMetadata(applyDoctorConfigToDiagnostics(
      [...componentDiagnostics, ...vueDiagnostics, ...builtinExtra.diagnostics, ...(extra?.diagnostics ?? [])],
      config
    ), catalogs)
    const attributedDiagnostics = await measurePhase(generationContext, 'report', async () => (
      config.gitAttribution === false
        ? configuredDiagnostics
        : enrichDiagnosticsWithGitAttribution(inventory.root, configuredDiagnostics)
    ))
    const skippedChecks: SkippedCheck[] = [...builtin.skippedChecks, ...builtinExtra.skippedChecks]
    if (extra) skippedChecks.push(...extra.skippedChecks)
    const ruleOrder = new Map([...ruleRegistry.keys()].map((code, index) => [code, index]))
    const diagnostics = stabilizeDiagnostics(attributedDiagnostics, ruleOrder)
    const stableSkippedChecks = stabilizeSkippedChecks(skippedChecks, ruleOrder)
    const checks = [
      ...builtin.checks,
      ...builtinExtra.reports.flatMap(report => (report.checks ?? []).map(check => ({ ...check, rulePack: report.name }))),
      ...(extra?.reports.flatMap((report) => (report.checks ?? []).map((check) => ({
        ...check,
        rulePack: check.rulePack ?? report.name
      }))) ?? [])
    ]
    const domainCoverage = createDoctorDomainCoverage({
      catalogs,
      diagnostics,
      skippedChecks: stableSkippedChecks,
      checks,
      rulePacks: extra?.reports,
      sourceStatus: analysis.coverage.source.status
    })
    const viteVersion = inventory.vite?.installedVersion ?? inventory.vite?.declaredVersion
    const uiLibraries = [...new Set([
      ...configuredUiLibraries.map((library) => library.package),
      ...analysis.coverage.componentLibraries.map((library) => library.package.canonicalName)
    ])].sort(compareText)
    const stableInventory = {
      ...inventory,
      packages: Object.fromEntries(Object.entries(inventory.packages).sort(([left], [right]) => compareText(left, right)))
    }

    const report: DoctorReport = {
      project: {
        root: inventory.root,
        ...(vueVersion ? { vueVersion } : {}),
        ...(viteVersion ? { viteVersion } : {}),
        vueFramework: classifyVueFramework(vueVersion),
        uiLibraries
      },
      inventory: stableInventory,
      coverage: analysis.coverage,
      diagnostics,
      skippedChecks: stableSkippedChecks,
      checks,
      domainCoverage,
      projectContext: builtContext.projectContext,
      ...(preparedEslint ? { ruleCatalogs: [{ name: 'eslint', rules: preparedEslint.pack.rules }] } : {}),
      ...(extra ? { rulePacks: extra.reports } : {})
    }
    const suppressionScans = [...scannedSource.sourceTexts]
      .map(([file, text]) => {
        const scan = extractDoctorSuppressions(file, text)
        if (scannedSource.invalidEncodingFiles.has(file)) {
          scan.complete = false
          scan.issues.push({ message: 'Invalid UTF-8 encoding prevents safe suppression.' })
        }
        return scan
      })
    return await measurePhase(generationContext, 'report', async () => finalizeDoctorReport(report, {
      target: targetFiles,
      generation: generationContext.generation,
      suppression: {
        scans: suppressionScans,
        registeredRuleCodes: ruleRegistry.keys()
      }
    }))
  } finally {
    await projectEslint?.dispose()
  }
}

/** Resolve static and project-derived rule catalogs without executing a Doctor analysis. */
export async function resolveDoctorRuleCatalogs(options: DoctorRunOptions = {}): Promise<DoctorRuleCatalog[]> {
  const root = resolve(options.root ?? process.cwd())
  const loaded = await loadDoctorConfig({ root, configFile: options.configFile })
  const config = mergeDoctorConfig(loaded.config, options.config)
  options.onConfigResolved?.(config)
  const configuredRules = config.rules ?? {}
  const eslintMode = config.eslint?.mode ?? 'auto'
  const staticComposition = createBuiltinRuleComposition()
  const withoutStaticEslint = {
    catalogs: staticComposition.catalogs.filter(catalog => catalog.name !== 'eslint'),
    packs: staticComposition.packs.filter(pack => pack.name !== 'eslint')
  }
  const configuredUiLibraries = resolveConfiguredUiLibraries(config)
  const inventory = await createProjectInventory({
    root,
    includePackages: configuredUiLibraries.map(library => library.package)
  })
  const resolved = resolveDoctorRunOptions(options, config)
  const discoveryComposition = eslintMode === 'off' ? withoutStaticEslint : staticComposition
  let targetFiles = freezeTargetFiles(await discoverTargetFiles({
    root: inventory.root,
    scope: resolved.scope,
    files: resolved.files,
    extensions: [
      ...selectTargetSourceExtensions(
        [...discoveryComposition.packs, ...(config.rulePacks ?? [])],
        configuredRules
      )
    ]
  }))
  let builtContext = await buildProjectContext({
    root: inventory.root,
    targetFiles,
    includePackages: configuredUiLibraries.map(library => library.package)
  })
  let prepared: DiscoveredProjectEslintRulePack | undefined
  try {
    if (eslintMode === 'auto' || eslintMode === 'project') {
      prepared = await discoverProjectEslintRulePack({
        root: inventory.root,
        configFile: config.eslint?.configFile,
        packages: await projectEslintPackageRequests(
          inventory.root,
          targetFiles,
          builtContext.projectContext.packages.map(item => item.root)
        )
      })
      if (!prepared && eslintMode === 'project') {
        throw new Error('Doctor config eslint.mode "project" requires an eslint.config.* file in the project.')
      }
      if (prepared) {
        const mergedFiles = [...new Set([...targetFiles.files, ...prepared.files])].sort(compareText)
        if (mergedFiles.length !== targetFiles.files.length) {
          targetFiles = freezeTargetFiles({ ...targetFiles, files: mergedFiles })
          builtContext = await buildProjectContext({
            root: inventory.root,
            targetFiles,
            includePackages: configuredUiLibraries.map(library => library.package)
          })
          const preparedRoots = new Set(prepared.packageRoots.map(packageRoot => resolve(packageRoot)))
          const discoveredRoots = builtContext.projectContext.packages.map(item => resolve(item.root))
          if (discoveredRoots.some(packageRoot => !preparedRoots.has(packageRoot))) {
            await prepared.dispose()
            prepared = await discoverProjectEslintRulePack({
              root: inventory.root,
              configFile: config.eslint?.configFile,
              packages: await projectEslintPackageRequests(inventory.root, targetFiles, discoveredRoots)
            })
            if (!prepared && eslintMode === 'project') {
              throw new Error('Doctor config eslint.mode "project" requires an eslint.config.* file in the project.')
            }
          }
        }
      }
    }
    const documents = prepared ? await readSourceDocuments(inventory.root, {
      targetFiles: { ...targetFiles, files: [...prepared.files] }
    }) : []
    const projectRules = await prepared?.prepare(new Map(documents
      .filter(document => !document.textUnavailable)
      .map(document => [document.file, document.text])))
    const catalogs: DoctorRuleCatalog[] = [
      ...(projectRules
        ? [...withoutStaticEslint.catalogs, { name: 'eslint', rules: projectRules.pack.rules }]
        : eslintMode === 'off' ? withoutStaticEslint.catalogs : staticComposition.catalogs),
      ...(config.rulePacks?.map(pack => ({ name: pack.name, rules: pack.rules })) ?? [])
    ]
    const registry = createDoctorRuleRegistry(catalogs.map(catalog => catalog.rules))
    validateConfiguredDoctorRuleCodes(configuredRules, registry)
    if (projectRules) validateProjectEslintOverrides(configuredRules, projectRules.hostDisabledRuleCodes)
    return catalogs
  } finally {
    await prepared?.dispose()
  }
}

async function projectEslintPackageRequests(
  projectRoot: string,
  targetFiles: TargetFiles,
  packageRoots: readonly string[]
): Promise<ProjectEslintPackageRequest[]> {
  const safeTargets = await safeEslintTargets(projectRoot, targetFiles)
  const workspace = await discoverEslintWorkspace(projectRoot, safeTargets)
  const roots = [...new Set([
    resolve(projectRoot),
    ...packageRoots.map(root => resolve(root)),
    ...workspace.packageRoots
  ])]
    .filter(root => root === resolve(projectRoot) || safeTargets.some(target => (
      isPathInside(root, target) || isPathInside(target, root)
    )))
    .sort(compareText)
  return roots.map(root => ({
    root,
    patterns: eslintPatternsForPackage(root, safeTargets),
    configFiles: workspace.configFiles.filter(configFile => nearestOwnerRoot(configFile, roots) === root)
  }))
}

async function discoverEslintWorkspace(
  projectRoot: string,
  safeTargets: readonly string[]
): Promise<{ packageRoots: string[]; configFiles: string[] }> {
  const ignored = new Set(['node_modules', 'dist', '.git', '.worktrees', '.nuxt', '.output', 'coverage'])
  const packageRoots = new Set<string>()
  const configFiles = new Set<string>()
  const configNames = new Set(['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts'])
  const pending: string[] = []
  for (const target of safeTargets) {
    try {
      const information = await stat(target)
      if (information.isDirectory()) pending.push(target)
      else await inspectAncestors(resolve(target, '..'))
    } catch {
      // Safe-target validation already recorded or rejected this path.
    }
  }
  const visited = new Set<string>()
  while (pending.length > 0) {
    const directory = pending.pop()!
    if (visited.has(directory)) continue
    visited.add(directory)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) pending.push(resolve(directory, entry.name))
      } else if (entry.name === 'package.json') {
        if (directory !== resolve(projectRoot)) packageRoots.add(directory)
      } else if (configNames.has(entry.name)) {
        configFiles.add(resolve(directory, entry.name))
      }
    }
  }
  return {
    packageRoots: [...packageRoots].sort(compareText),
    configFiles: [...configFiles].sort(compareText)
  }

  async function inspectAncestors(start: string): Promise<void> {
    let directory = start
    while (isPathInside(projectRoot, directory)) {
      await inspectDirectory(directory)
      if (directory === resolve(projectRoot)) break
      directory = resolve(directory, '..')
    }
  }

  async function inspectDirectory(directory: string): Promise<void> {
    try {
      await access(resolve(directory, 'package.json'))
      if (directory !== resolve(projectRoot)) packageRoots.add(directory)
    } catch {}
    for (const name of configNames) {
      try {
        await access(resolve(directory, name))
        configFiles.add(resolve(directory, name))
      } catch {}
    }
  }
}

function nearestOwnerRoot(file: string, roots: readonly string[]): string | undefined {
  return [...roots].sort((left, right) => right.length - left.length).find(root => isPathInside(root, file))
}

function eslintPatternsForPackage(packageRoot: string, targets: readonly string[]): string[] {
  const patterns = targets.flatMap(target => {
    if (isPathInside(target, packageRoot)) return ['.']
    if (!isPathInside(packageRoot, target)) return []
    const path = relative(packageRoot, target).split(sep).join('/')
    return [path || '.']
  })
  return [...new Set(patterns)].sort(compareText)
}

async function safeEslintTargets(projectRoot: string, targetFiles: TargetFiles): Promise<string[]> {
  if (targetFiles.issues.some(issue => issue.kind === 'root-unavailable')) return []
  let physicalRoot: string
  try {
    physicalRoot = await realpath(projectRoot)
  } catch {
    return []
  }
  const rawScopes = targetFiles.scope === undefined
    ? [projectRoot]
    : Array.isArray(targetFiles.scope) ? targetFiles.scope : [targetFiles.scope]
  const scopes = await validateEntries(rawScopes, false)
  if (targetFiles.requestedFiles === undefined) {
    return scopes.map(scope => scope.path)
  }
  const requestedFiles = await validateEntries(targetFiles.requestedFiles, true)
  return requestedFiles
    .filter(file => scopes.some(scope => scope.file ? scope.path === file.path : isPathInside(scope.path, file.path)))
    .map(file => file.path)

  async function validateEntries(
    values: readonly string[],
    requireFile: boolean
  ): Promise<Array<{ path: string; file: boolean }>> {
    const entries: Array<{ path: string; file: boolean }> = []
    for (const value of values) {
      const supplied = isAbsolute(value) ? resolve(value) : resolve(projectRoot, value)
      if (!isPathInside(projectRoot, supplied) || isIgnoredDoctorPath(projectRoot, supplied)) continue
      try {
        const physical = await realpath(supplied)
        if (!isPathInside(physicalRoot, physical) || isIgnoredDoctorPath(physicalRoot, physical)) continue
        const information = await stat(physical)
        if (requireFile && !information.isFile()) continue
        if (!requireFile && !information.isFile() && !information.isDirectory()) continue
        entries.push({ path: supplied, file: information.isFile() })
      } catch {
        // Source discovery records the operational issue; ESLint must not widen the request.
      }
    }
    const stable = new Map(entries.map(entry => [entry.path, entry]))
    return [...stable.values()].sort((left, right) => compareText(left.path, right.path))
  }
}

function isIgnoredDoctorPath(root: string, file: string): boolean {
  const ignored = new Set(['node_modules', 'dist', '.git', '.worktrees', '.nuxt', '.output', 'coverage'])
  return relative(root, file).split(sep).some(segment => ignored.has(segment))
}

function validateProjectEslintOverrides(
  rules: Readonly<Record<string, RuleSeveritySetting>>,
  hostDisabledRuleCodes: ReadonlySet<string>
): void {
  const enabledOverrides = Object.entries(rules)
    .filter(([code, setting]) => code.startsWith('eslint/') && setting !== 'off' && hostDisabledRuleCodes.has(code))
    .map(([code]) => code)
    .sort(compareText)
  if (enabledOverrides.length > 0) {
    throw new Error(
      `Doctor config "rules" cannot enable project ESLint ${enabledOverrides.length === 1 ? 'rule' : 'rules'} disabled by eslint.config.*: ${enabledOverrides.join(', ')}.`
    )
  }
}

function isPathInside(root: string, file: string): boolean {
  const path = relative(root, file)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function selectTargetSourceExtensions(
  packs: readonly NonNullable<DoctorConfig['rulePacks']>[number][],
  rules: Readonly<Record<string, RuleSeveritySetting>>
): string[] {
  const extensions = new Set<string>()
  for (const pack of packs) {
    if (!pack.rules.some((rule) => isDoctorRuleEnabled(rule, rules))) continue
    for (const extension of pack.sourceExtensions ?? []) extensions.add(extension)
  }
  return [...extensions].sort(compareText)
}

function freezeTargetFiles(target: TargetFiles): TargetFiles {
  return Object.freeze({
    ...target,
    ...(Array.isArray(target.scope) ? { scope: Object.freeze([...target.scope]) } : {}),
    ...(target.requestedFiles
      ? { requestedFiles: Object.freeze([...target.requestedFiles]) }
      : {}),
    files: Object.freeze([...target.files]),
    issues: Object.freeze(target.issues.map((issue) => Object.freeze({ ...issue })))
  }) as TargetFiles
}

function selectComponentLibraryPackages(
  packages: readonly PackageResolution[],
  configuredLibraries: UiLibraryConfig[],
  autoDetect: boolean,
  observedPackageNames: Set<string>
): PackageResolution[] {
  const allPackages = [...packages]
  const discovered = autoDetect
    ? allPackages.filter((item) => item.importRoots.some((root) => observedPackageNames.has(root)))
    : []
  const configured = configuredLibraries.flatMap((configuration) => {
    const exact = allPackages.find((item) => item.dependencyName === configuration.package)
    const installedCanonical = allPackages.find((item) => (
      item.source === 'installed' && item.canonicalName === configuration.package
    ))
    const matched = exact?.source === 'installed'
      ? exact
      : installedCanonical ?? exact
    return matched ? [matched] : []
  })
  const candidates = [...discovered, ...configured]
  const selected = new Map<string, PackageResolution>()

  for (const candidate of candidates) {
    const configuration = configuredLibraries.find((item) => (
      item.package === candidate.dependencyName || item.package === candidate.canonicalName
    ))
    const identity = {
      ...candidate,
      importRoots: [...new Set([
        ...candidate.importRoots,
        ...(configuration?.aliases ?? [])
      ])]
    }
    const key = identity.packageJsonPath ?? identity.dependencyName
    const existing = selected.get(key)
    selected.set(key, existing
      ? {
          ...existing,
          importRoots: [...new Set([...existing.importRoots, ...identity.importRoots])]
        }
      : identity)
  }

  return [...selected.values()].sort((left, right) => (
    compareText(left.canonicalName, right.canonicalName)
    || compareText(left.dependencyName, right.dependencyName)
    || compareText(left.packageJsonPath ?? '', right.packageJsonPath ?? '')
  ))
}

function collectProjectPackages(
  rootInventory: ProjectInventory,
  packageInventories: readonly ProjectInventory[]
): PackageResolution[] {
  const packages = new Map<string, PackageResolution>()
  for (const inventory of [rootInventory, ...packageInventories]) {
    for (const identity of Object.values(inventory.packages)) {
      const key = identity.packageJsonPath
        ?? `${inventory.root}\0${identity.dependencyName}\0${identity.canonicalName}`
      const previous = packages.get(key)
      packages.set(key, previous ? {
        ...previous,
        importRoots: [...new Set([...previous.importRoots, ...identity.importRoots])]
      } : identity)
    }
  }
  return [...packages.values()]
}

function requireRegisteredRule(
  registry: ReadonlyMap<string, DoctorRuleDefinition>,
  code: string
): DoctorRuleDefinition {
  const definition = registry.get(code)
  if (!definition) throw new Error(`Diagnostic returned undeclared rule ${code}.`)
  return definition
}

function applyRequiredComponentSkipCoverage(
  coverage: DoctorCoverage,
  skippedChecks: readonly SkippedCheck[]
): void {
  const requiredChecks = skippedChecks.filter((check) => check.required)
  if (requiredChecks.length === 0) return

  for (const library of coverage.componentLibraries) {
    const libraryChecks = requiredChecks.filter((check) => (
      check.package && isSamePackage(check.package, library.package)
    ))
    if (libraryChecks.length === 0) continue

    if (library.status === 'complete') library.status = 'partial'
    const ruleCodes = [...new Set(libraryChecks.map((check) => check.ruleCode))].sort(compareText)
    library.problems.push({
      code: 'component-library-contracts-partial',
      message: `Required component checks could not run with the available source and installed contract evidence: ${ruleCodes.join(', ')}.`,
      evidence: stabilizeEvidence(libraryChecks.flatMap((check) => check.evidence.map((evidence) => (
        evidence.kind === 'component-contract'
          ? { ...evidence, message: 'Installed component contract evidence consulted for this check.' }
          : evidence
      ))))
    })
  }

  if (coverage.status === 'complete') coverage.status = 'partial'
}

function isSamePackage(left: PackageResolution, right: PackageResolution): boolean {
  if (left.packageJsonPath && right.packageJsonPath) {
    return left.packageJsonPath === right.packageJsonPath
  }
  return left.dependencyName === right.dependencyName
    && left.canonicalName === right.canonicalName
}

function stabilizeDiagnostics(
  diagnostics: readonly Diagnostic[],
  ruleOrder: ReadonlyMap<string, number>
): Diagnostic[] {
  return diagnostics
    .map((diagnostic) => ({
      ...diagnostic,
      evidence: stabilizeEvidence(diagnostic.evidence)
    }))
    .sort((left, right) => {
      const leftLocation = primaryDiagnosticLocation(left)
      const rightLocation = primaryDiagnosticLocation(right)
      return compareText(left.file ?? leftLocation.file ?? '', right.file ?? rightLocation.file ?? '')
        || (leftLocation.line ?? 0) - (rightLocation.line ?? 0)
        || (leftLocation.column ?? 0) - (rightLocation.column ?? 0)
        || (ruleOrder.get(left.code) ?? Number.MAX_SAFE_INTEGER)
          - (ruleOrder.get(right.code) ?? Number.MAX_SAFE_INTEGER)
        || compareText(left.code, right.code)
        || compareText(left.message, right.message)
        || compareText(left.severity, right.severity)
        || compareText(left.confidence, right.confidence)
        || compareText(stableSerialize(left.evidence), stableSerialize(right.evidence))
        || compareText(stableSerialize(left.fixes), stableSerialize(right.fixes))
        || compareText(left.domain ?? '', right.domain ?? '')
        || compareText(stableSerialize(left.tags ?? []), stableSerialize(right.tags ?? []))
        || compareText(left.rulePack ?? '', right.rulePack ?? '')
    })
}

function stabilizeSkippedChecks(
  checks: readonly SkippedCheck[],
  ruleOrder: ReadonlyMap<string, number>
): SkippedCheck[] {
  return checks
    .map((check) => ({ ...check, evidence: stabilizeEvidence(check.evidence) }))
    .sort((left, right) => (
      compareText(left.file ?? '', right.file ?? '')
      || compareText(left.package?.canonicalName ?? '', right.package?.canonicalName ?? '')
      || compareText(left.package?.dependencyName ?? '', right.package?.dependencyName ?? '')
      || compareText(stableSerialize(left.package ?? null), stableSerialize(right.package ?? null))
      || (ruleOrder.get(left.ruleCode) ?? Number.MAX_SAFE_INTEGER)
        - (ruleOrder.get(right.ruleCode) ?? Number.MAX_SAFE_INTEGER)
      || compareText(left.ruleCode, right.ruleCode)
      || Number(left.required) - Number(right.required)
      || compareText(left.reason, right.reason)
      || compareText(stableSerialize(left.evidence), stableSerialize(right.evidence))
    ))
}

function stabilizeEvidence(evidence: readonly EvidenceLocation[]): EvidenceLocation[] {
  return [...evidence].sort((left, right) => (
    compareText(left.kind, right.kind)
    || compareText(left.file ?? '', right.file ?? '')
    || (left.line ?? 0) - (right.line ?? 0)
    || (left.column ?? 0) - (right.column ?? 0)
    || compareText(left.message ?? '', right.message ?? '')
    || compareText(stableSerialize(left), stableSerialize(right))
  ))
}

function primaryDiagnosticLocation(diagnostic: Diagnostic): EvidenceLocation {
  return diagnostic.evidence.find((evidence) => evidence.file === diagnostic.file)
    ?? diagnostic.evidence[0]
    ?? {}
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function measurePhase<T>(
  context: DoctorRunGenerationContext,
  name: Parameters<NonNullable<DoctorRunGenerationContext['recordPhase']>>[0],
  run: () => T | Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  try {
    return await run()
  } finally {
    context.recordPhase?.(name, performance.now() - startedAt, process.memoryUsage().rss)
  }
}

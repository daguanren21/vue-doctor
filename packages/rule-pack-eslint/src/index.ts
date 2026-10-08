import { builtinRules } from 'eslint/use-at-your-own-risk'
import { defineRule, defineRules } from '@vue-doctor/rules'
import {
  createProjectEslintSession,
  findProjectEslintConfig,
  eslintRule,
  type ProjectEslintFilePlan,
  type ProjectEslintRuleState,
  type ProjectEslintSession
} from '@vue-doctor/rules-eslint'
import { extname, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import type {
  Diagnostic,
  DoctorRuleCheck,
  DoctorRulePack,
  DoctorRuleDefinition,
  DoctorRulePackResult,
  SkippedCheck
} from '@vue-doctor/core'

/** Official core delegates are built in, with opt-in selection to preserve scan defaults. */
export const eslintRulePack: DoctorRulePack = defineRules({
  name: 'eslint',
  rules: Object.fromEntries([...builtinRules].map(([name, module]) => [name, defineRule({
    meta: {
      title: module.meta?.docs?.description ?? name,
      description: module.meta?.docs?.description ?? `Evaluate the official ESLint ${name} rule.`,
      domain: 'conventions', verification: 'static', defaultEnabled: false, defaultSeverity: 'warning',
      tags: ['eslint'],
      help: {
        problem: module.meta?.docs?.description ?? `The source violates the official ESLint ${name} rule.`,
        remediation: `Review the finding in its source context.${module.meta?.docs?.url ? ` Rule documentation: ${module.meta.docs.url}` : ''}`
      }
    },
    check: eslintRule({ module })
  })]))
})

export const eslintRuleDefinitions: readonly DoctorRuleDefinition[] = eslintRulePack.rules

const projectAnalysisCode = 'eslint/project-analysis'

export interface ProjectEslintPackageRequest {
  root: string
  patterns: readonly string[]
  /** Configs observed inside safe target scopes; native ESLint still performs lookup. */
  configFiles?: readonly string[]
}

export interface DiscoveredProjectEslintRulePack {
  files: readonly string[]
  packageRoots: readonly string[]
  configFiles: readonly string[]
  eslintVersions: readonly string[]
  prepare(sourceTexts: ReadonlyMap<string, string>): Promise<PreparedProjectEslintRulePack>
  dispose(): Promise<void>
}

export interface PreparedProjectEslintRulePack {
  pack: DoctorRulePack
  /** Rules configured off in every applicable file remain catalogued but cannot be enabled by Doctor. */
  hostDisabledRuleCodes: ReadonlySet<string>
}

interface ProjectEslintPlan {
  session: ProjectEslintSession
  preparation: { files: ProjectEslintFilePlan[]; rules: ProjectEslintRuleState[] }
  root: string
}

/** Discover project targets first; rule preparation awaits the run's authoritative snapshot. */
export async function discoverProjectEslintRulePack(options: {
  root: string
  packages: readonly ProjectEslintPackageRequest[]
  configFile?: string
}): Promise<DiscoveredProjectEslintRulePack | undefined> {
  const projectRoot = resolve(options.root)
  const requests = deduplicatePackageRequests(options.packages, projectRoot)
  const sessions: ProjectEslintPlan[] = []
  try {
    for (const request of requests) {
      const configFile = await findProjectEslintConfig({
        root: request.root,
        searchStop: projectRoot,
        configFile: options.configFile
      }) ?? request.configFiles?.[0]
      if (!configFile) continue
      const session = await createProjectEslintSession({
        root: request.root,
        discoveredConfigFile: configFile,
        ...(options.configFile ? { configFile } : {})
      })
      if (!options.configFile && !isInside(projectRoot, session.configFile)) {
        await session.dispose()
        throw new Error(`Project ESLint config lookup escaped the Doctor root: ${session.configFile}`)
      }
      try {
        const files = await session.discover(request.patterns)
        sessions.push({
          session,
          preparation: { files: files.map(filePath => ({ filePath, rules: [] })), rules: [] },
          root: request.root
        })
      } catch (error) {
        await session.dispose()
        throw error
      }
    }
    if (sessions.length === 0) return undefined

    const packageRoots = sessions.map(item => item.root).sort((left, right) => right.length - left.length)
    const plans = [] as typeof sessions
    for (const item of sessions) {
      const files: ProjectEslintFilePlan[] = []
      for (const file of item.preparation.files) {
        if (ownerRoot(file.filePath, packageRoots) === item.root
          && await isSafeProjectFile(projectRoot, file.filePath)) files.push(file)
      }
      plans.push({ ...item, preparation: { files, rules: item.preparation.rules } })
    }
    return {
      files: [...new Set(plans.flatMap(item => item.preparation.files.map(file => file.filePath)))].sort(compareText),
      packageRoots: plans.map(item => item.root).sort(compareText),
      configFiles: [...new Set(sessions.map(item => item.session.configFile))].sort(compareText),
      eslintVersions: [...new Set(sessions.map(item => item.session.eslintVersion))].sort(compareText),
      prepare: sourceTexts => prepareProjectEslintRulePack(plans, sourceTexts),
      async dispose() {
        await Promise.allSettled(sessions.map(item => item.session.dispose()))
      }
    }
  } catch (error) {
    await Promise.allSettled(sessions.map(item => item.session.dispose()))
    throw error
  }
}

async function prepareProjectEslintRulePack(
  discovered: readonly ProjectEslintPlan[],
  sourceTexts: ReadonlyMap<string, string>
): Promise<PreparedProjectEslintRulePack> {
    const plans = await Promise.all(discovered.map(async item => ({
      ...item,
      preparation: await item.session.prepare(item.preparation.files.map(file => ({
        filePath: file.filePath,
        text: sourceTexts.get(file.filePath)
      })))
    })))
    const rules = new Map<string, { enabled: boolean; title?: string; description?: string; url?: string }>()
    for (const item of plans) {
      for (const rule of item.preparation.rules) {
        const code = doctorEslintCode(rule.ruleId)
        const previous = rules.get(code)
        rules.set(code, {
          ...previous,
          enabled: Boolean(previous?.enabled || rule.severity > 0),
          ...(rule.title ? { title: rule.title } : {}),
          ...(rule.description ? { description: rule.description } : {}),
          ...(rule.url ? { url: rule.url } : {})
        })
      }
    }
    const definitions = [...rules].sort(([left], [right]) => compareText(left, right)).map(([code, state]): DoctorRuleDefinition => ({
      code,
      title: state.title ?? code.slice('eslint/'.length),
      description: state.description ?? `Evaluate the ${code.slice('eslint/'.length)} rule from the consuming project's ESLint flat config.`,
      category: 'eslint',
      domain: 'conventions',
      verification: 'static',
      defaultEnabled: state.enabled,
      tags: ['eslint', 'project-config'],
      help: {
        problem: `The consuming project's ${code.slice('eslint/'.length)} rule reported this source.`,
        remediation: `Review the finding using the rule options and plugins from the project ESLint config.${state.url ? ` Rule documentation: ${state.url}` : ''}`
      }
    }))
    definitions.unshift({
      code: projectAnalysisCode,
      title: 'Project ESLint analysis',
      description: 'Load the consuming flat config and run its parsers, processors, and configured rules.',
      category: 'eslint',
      domain: 'conventions',
      verification: 'static',
      defaultEnabled: true,
      tags: ['eslint', 'project-config'],
      help: {
        problem: 'The consuming ESLint engine could not fully analyze a configured source file.',
        remediation: 'Review the project ESLint config, parser, processor, and inline directive reported by the finding.'
      }
    })
    const pack: DoctorRulePack = {
      name: 'eslint',
      rules: definitions,
      sourceExtensions: [...new Set(plans.flatMap(item => item.preparation.files.map(file => extname(file.filePath).toLowerCase())).filter(Boolean))].sort(compareText),
      run: context => runProjectEslintPack(context, plans)
    }
    return {
      pack,
      hostDisabledRuleCodes: new Set([...rules].filter(([, state]) => !state.enabled).map(([code]) => code))
    }
}

async function runProjectEslintPack(
  context: Parameters<DoctorRulePack['run']>[0],
  plans: readonly ProjectEslintPlan[]
): Promise<DoctorRulePackResult> {
  const diagnostics: Diagnostic[] = []
  const skippedChecks: SkippedCheck[] = []
  const documents = new Map((context.documents ?? []).map(document => [resolve(document.file), document]))
  const checkStates = new Map<string, { files: number; successful: number; failed: number }>()
  checkStates.set(projectAnalysisCode, { files: 0, successful: 0, failed: 0 })
  for (const definition of plans.flatMap(item => [
    ...item.preparation.rules.map(rule => doctorEslintCode(rule.ruleId)),
    ...item.preparation.files.flatMap(file => file.rules.map(rule => doctorEslintCode(rule.ruleId)))
  ])) {
    if (!checkStates.has(definition)) checkStates.set(definition, { files: 0, successful: 0, failed: 0 })
  }

  for (const item of plans) {
    const missingDocuments: ProjectEslintFilePlan[] = []
    const selectedFiles = item.preparation.files.flatMap(file => {
      const document = documents.get(resolve(file.filePath))
      if (!document || document.textUnavailable) {
        missingDocuments.push(file)
        return []
      }
      return [{ file, document }]
    })
    for (const file of missingDocuments) {
      const detail = documents.get(resolve(file.filePath))?.errors.map(error => error.message).join(' ')
      recordUnavailableFile(file, detail || 'The authoritative source snapshot could not be read safely.', 'missing-capability')
    }
    const results = await item.session.lint(selectedFiles.map(({ document }) => ({
      filePath: document.file,
      text: document.text
    })))
    const resultByFile = new Map(results.map(result => [resolve(result.filePath), result]))
    for (const { file } of selectedFiles) {
      const result = resultByFile.get(resolve(file.filePath))
      if (!result) continue
      const projectState = checkStates.get(projectAnalysisCode)!
      projectState.files += 1
      const fatal = result.messages.find(message => message.fatal)
      const effectiveRules = fatal ? mergeRuleStates(file.rules, result.rules) : result.rules
      const activeRules = effectiveRules.filter(rule => rule.severity > 0 && context.rules[doctorEslintCode(rule.ruleId)] !== 'off')
      for (const rule of activeRules) checkStates.get(doctorEslintCode(rule.ruleId))!.files += 1
      if (fatal) {
        projectState.failed += 1
        skippedChecks.push({
          ruleCode: projectAnalysisCode,
          file: reportFile(context.inventory.root, file.filePath),
          required: true,
          reason: 'parse-failed',
          evidence: [{
            kind: 'project-eslint',
            file: reportFile(context.inventory.root, file.filePath),
            ...(fatal.line === undefined ? {} : { line: fatal.line }),
            ...(fatal.column === undefined ? {} : { column: fatal.column }),
            message: fatal.message
          }]
        })
        for (const rule of activeRules) {
          const code = doctorEslintCode(rule.ruleId)
          checkStates.get(code)!.failed += 1
          skippedChecks.push({
            ruleCode: code,
            file: reportFile(context.inventory.root, file.filePath),
            required: true,
            reason: 'parse-failed',
            evidence: [{
              kind: 'project-eslint',
              file: reportFile(context.inventory.root, file.filePath),
              ...(fatal.line === undefined ? {} : { line: fatal.line }),
              ...(fatal.column === undefined ? {} : { column: fatal.column }),
              message: fatal.message
            }]
          })
        }
        continue
      }
      projectState.successful += 1
      for (const rule of activeRules) checkStates.get(doctorEslintCode(rule.ruleId))!.successful += 1
      for (const message of result.messages) {
        if (message.severity === 0) continue
        if (!message.ruleId) {
          diagnostics.push({
            code: projectAnalysisCode,
            severity: message.severity === 2 ? 'error' : 'warning',
            message: message.message,
            file: reportFile(context.inventory.root, result.filePath),
            confidence: 'high',
            fixes: [],
            evidence: [{
              kind: 'project-eslint',
              file: reportFile(context.inventory.root, result.filePath),
              ...(message.line === undefined ? {} : { line: message.line }),
              ...(message.column === undefined ? {} : { column: message.column }),
              ...(message.endLine === undefined ? {} : { endLine: message.endLine }),
              ...(message.endColumn === undefined ? {} : { endColumn: message.endColumn }),
              message: 'Project ESLint engine'
            }]
          })
          continue
        }
        const code = doctorEslintCode(message.ruleId)
        if (!checkStates.has(code)) throw new Error(`Project ESLint returned a rule that was absent from its prepared config: ${message.ruleId}`)
        if (context.rules[code] === 'off') continue
        diagnostics.push({
          code,
          severity: message.severity === 2 ? 'error' : 'warning',
          message: message.message,
          file: reportFile(context.inventory.root, result.filePath),
          confidence: 'high',
          fixes: [],
          evidence: [{
            kind: 'project-eslint',
            file: reportFile(context.inventory.root, result.filePath),
            ...(message.line === undefined ? {} : { line: message.line }),
            ...(message.column === undefined ? {} : { column: message.column }),
            ...(message.endLine === undefined ? {} : { endLine: message.endLine }),
            ...(message.endColumn === undefined ? {} : { endColumn: message.endColumn }),
            message: message.ruleId
          }]
        })
      }
    }
    for (const { file } of selectedFiles) {
      if (!resultByFile.has(resolve(file.filePath))) {
        recordUnavailableFile(file, 'Project ESLint did not return a result for this configured target.', 'missing-capability')
      }
    }

    function recordUnavailableFile(
      file: ProjectEslintFilePlan,
      message: string,
      reason: SkippedCheck['reason']
    ): void {
      const projectState = checkStates.get(projectAnalysisCode)!
      projectState.files += 1
      projectState.failed += 1
      skippedChecks.push({
        ruleCode: projectAnalysisCode,
        file: reportFile(context.inventory.root, file.filePath),
        required: true,
        reason,
        evidence: [{ kind: 'project-eslint', file: reportFile(context.inventory.root, file.filePath), message }]
      })
      for (const rule of file.rules.filter(rule => rule.severity > 0 && context.rules[doctorEslintCode(rule.ruleId)] !== 'off')) {
        const code = doctorEslintCode(rule.ruleId)
        const state = checkStates.get(code)!
        state.files += 1
        state.failed += 1
        skippedChecks.push({
          ruleCode: code,
          file: reportFile(context.inventory.root, file.filePath),
          required: true,
          reason,
          evidence: [{ kind: 'project-eslint', file: reportFile(context.inventory.root, file.filePath), message }]
        })
      }
    }
  }
  const checks: DoctorRuleCheck[] = [...checkStates].map(([ruleCode, state]) => ({
    ruleCode,
    files: state.files,
    status: state.failed > 0
      ? state.successful > 0 ? 'partial' : 'unavailable'
      : state.files > 0 ? 'checked' : 'not-applicable',
    ...(state.failed > 0 ? { reason: 'Project ESLint could not parse every applicable source file.' } : {})
  }))
  return { diagnostics, skippedChecks, checks }
}

function deduplicatePackageRequests(
  requests: readonly ProjectEslintPackageRequest[],
  projectRoot: string
): ProjectEslintPackageRequest[] {
  const byRoot = new Map<string, { patterns: Set<string>; configFiles: Set<string> }>()
  for (const request of requests.length > 0 ? requests : [{ root: projectRoot, patterns: [] as readonly string[] }]) {
    const root = resolve(request.root)
    const entry = byRoot.get(root) ?? { patterns: new Set<string>(), configFiles: new Set<string>() }
    for (const pattern of request.patterns) entry.patterns.add(pattern)
    for (const configFile of request.configFiles ?? []) entry.configFiles.add(resolve(configFile))
    byRoot.set(root, entry)
  }
  return [...byRoot].sort(([left], [right]) => compareText(left, right)).map(([root, entry]) => ({
    root,
    patterns: [...entry.patterns].sort(compareText),
    configFiles: [...entry.configFiles].sort(compareText)
  }))
}

async function isSafeProjectFile(projectRoot: string, file: string): Promise<boolean> {
  if (!isInside(projectRoot, file)) return false
  const ignored = new Set(['node_modules', 'dist', '.git', '.worktrees', '.nuxt', '.output', 'coverage'])
  if (relative(projectRoot, file).split(sep).some(segment => ignored.has(segment))) return false
  try {
    const [physicalRoot, physicalFile] = await Promise.all([realpath(projectRoot), realpath(file)])
    return isInside(physicalRoot, physicalFile)
      && !relative(physicalRoot, physicalFile).split(sep).some(segment => ignored.has(segment))
  } catch {
    return false
  }
}

function ownerRoot(file: string, packageRoots: readonly string[]): string | undefined {
  return packageRoots.find(root => isInside(root, file))
}

function isInside(root: string, file: string): boolean {
  const path = relative(root, file)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith('/'))
}

function doctorEslintCode(ruleId: string): string {
  return `eslint/${ruleId}`
}

function mergeRuleStates(
  ...groups: Array<readonly ProjectEslintRuleState[]>
): ProjectEslintRuleState[] {
  const rules = new Map<string, ProjectEslintRuleState>()
  for (const group of groups) {
    for (const rule of group) {
      const previous = rules.get(rule.ruleId)
      rules.set(rule.ruleId, {
        ...previous,
        ...rule,
        severity: Math.max(previous?.severity ?? 0, rule.severity) as 0 | 1 | 2
      })
    }
  }
  return [...rules.values()]
}

function reportFile(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

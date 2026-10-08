import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { Linter, type Rule } from 'eslint'
import * as typescriptParser from '@typescript-eslint/parser'
import * as vueParser from 'vue-eslint-parser'
import type { Diagnostic, DoctorRuleCheck, DoctorRulePackContext, DoctorRulePackResult } from '@vue-doctor/core'
import type { SourceDocument, SourceDocumentBlock } from '@vue-doctor/source'
import { defineRuleEngine, engineRule, type EngineRuleCheck, type RuleEngine, type RuleEngineEntry } from '@vue-doctor/rules'

const extensions = ['.vue', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'] as const
const scriptLanguages = new Set(['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx'])

export interface EslintDocumentKind {
  sfc: boolean
  scripts: readonly SourceDocumentBlock[]
  typed: boolean
  hasScript: boolean
}

/** Native ESTree/scope/template services come from the configured ESLint parsers. */
export interface EslintDocumentContext<Services = undefined> {
  context: DoctorRulePackContext
  document: SourceDocument
  definition: RuleEngineEntry<EslintRuleConfig<Services>>['definition']
  kind: EslintDocumentKind
  filename: string
  suppliedFilename: string
  root: string
  suppliedRoot: string
  project?: string
  services: Services
}

export type EslintRuleSelection = boolean | {
  status: 'disabled' | 'not-applicable' | 'policy-pending' | 'unavailable'
  reason?: string
}

export type EslintMessageResult = Diagnostic | { unavailable: string; parse?: boolean } | { defer: true } | null

export interface EslintRuleConfig<Services = undefined> {
  /** A real ESLint RuleModule, preserving its selectors, scope and parser services. */
  module: Rule.RuleModule | ((context: EslintDocumentContext<Services> & { unavailable(reason: string): void }) => Rule.RuleModule)
  options?: readonly unknown[] | ((context: EslintDocumentContext<Services>) => readonly unknown[])
  typed?: boolean
  select?(context: EslintDocumentContext<Services>): EslintRuleSelection
  /** A typed second stage requested only by an explicit defer message. */
  deferred?: EslintRuleConfig<Services>
  onMessage?(message: Linter.LintMessage, context: EslintDocumentContext<Services>): EslintMessageResult
  failures?(context: EslintDocumentContext<Services>): string | undefined
  prerequisiteEvidenceKind?: string
  scriptPrerequisites?: 'script' | 'template' | 'none'
  requiresTemplate?: boolean
}

export interface EslintEngineOptions<Services = undefined> {
  name?: string
  prepare?(context: DoctorRulePackContext, documents: readonly SourceDocument[]): Services | Promise<Services>
  settings?(services: Services): Linter.Config['settings']
  dispose?(services: Services): void | Promise<void>
}

/** One ordinary parse and, when requested, one real type-program parse per document. */
export function createEslintRuleEngine<Services = undefined>(options: EslintEngineOptions<Services> = {}): RuleEngine<EslintRuleConfig<Services>> {
  return defineRuleEngine({
    name: options.name ?? 'eslint',
    sourceExtensions: extensions,
    async runBatch(context, entries) {
      const result: DoctorRulePackResult = { diagnostics: [], skippedChecks: [], checks: [] }
      const states = new Map(entries.map(entry => [entry.definition.code, {
        ruleCode: entry.definition.code, status: 'not-applicable', files: 0
      } as DoctorRuleCheck]))
      function unavailable(entry: RuleEngineEntry<EslintRuleConfig<Services>>, file: string | undefined, reason: string, parse = false) {
        const code = entry.definition.code
        Object.assign(states.get(code)!, { status: 'unavailable', reason })
        if (!result.skippedChecks.some(skip => skip.ruleCode === code && skip.file === file)) result.skippedChecks.push({
          ruleCode: code, file, required: true, reason: parse ? 'parse-failed' : 'missing-capability',
          evidence: [{ kind: entry.config.prerequisiteEvidenceKind ?? 'eslint-prerequisite', file, message: reason }]
        })
      }
      if (!context.documents) {
        for (const entry of entries) unavailable(entry, undefined, 'Source documents were not supplied to the script checker.')
        result.checks = [...states.values()]
        return result
      }
      const documents = context.documents.filter(document => extensions.some(extension => document.file.toLowerCase().endsWith(extension)))
      if (!documents.length) { result.checks = [...states.values()]; return result }
      const suppliedRoot = path.resolve(context.inventory.root)
      const root = existsSync(suppliedRoot) ? realpathSync(suppliedRoot) : suppliedRoot
      const linter = new Linter({ cwd: root, configType: 'flat' })
      // Touch the process-global project service only if this run enters a typed pass.
      let typedServiceUsed = false
      let services!: Services
      let prepared = false
      try {
        services = options.prepare ? await options.prepare(context, documents) : undefined as Services
        prepared = true
        for (const document of documents) {
          const sfc = document.file.endsWith('.vue')
          const scripts = document.blocks.filter(block => block.kind === 'script')
          const kind: EslintDocumentKind = {
            sfc, scripts, hasScript: !sfc || scripts.length > 0,
            typed: /\.(?:[cm]?ts|tsx)$/i.test(document.file) || scripts.some(block => ['ts', 'tsx', 'typescript'].includes(block.lang))
          }
          const suppliedFilename = path.resolve(suppliedRoot, document.file)
          const filename = existsSync(suppliedFilename) ? realpathSync(suppliedFilename) : suppliedFilename
          const project = nearestProject(filename, root)
          const documentContext = (entry: RuleEngineEntry<EslintRuleConfig<Services>>): EslintDocumentContext<Services> => ({
            context, document, definition: entry.definition, kind, filename, suppliedFilename, root, suppliedRoot, project, services
          })
          const externalScript = scripts.find(block => block.attributes.src)
          const unsupportedScript = scripts.find(block => !scriptLanguages.has(block.lang))
          const unavailableTemplate = document.blocks.find(block => block.kind === 'template' && (block.attributes.src || !['html', 'vue'].includes(block.lang)))
          const applicable: RuleEngineEntry<EslintRuleConfig<Services>>[] = []
          for (const entry of entries) {
            const selected = entry.config.select?.(documentContext(entry)) ?? kind.hasScript
            if (selected === false) continue
            if (typeof selected === 'object') {
              if (selected.status === 'unavailable') unavailable(entry, document.file, selected.reason ?? 'Rule prerequisites are unavailable.')
              else {
                const state = states.get(entry.definition.code)!
                // A later inactive file cannot erase execution evidence from earlier files.
                if (state.status !== 'unavailable' && (selected.status === 'policy-pending' || !state.files)) Object.assign(state, selected)
              }
              continue
            }
            if ((externalScript || unsupportedScript) && (entry.config.scriptPrerequisites ?? 'script') === 'script') {
              unavailable(entry, document.file, externalScript
                ? 'External SFC script blocks require their separately resolved source; inline analysis cannot claim that contract.'
                : `Unsupported SFC script language: ${unsupportedScript!.lang}.`)
              continue
            }
            if (unavailableTemplate && (entry.config.requiresTemplate || entry.config.scriptPrerequisites === 'template')) {
              unavailable(entry, document.file, unavailableTemplate.attributes.src
                ? 'External SFC templates require their resolved source and source map; an empty inline template is not evidence of compliance.'
                : `The ${unavailableTemplate.lang} template requires its compiler/preprocessor source map.`)
              continue
            }
            applicable.push(entry)
          }
          const deferred: RuleEngineEntry<EslintRuleConfig<Services>>[] = []
          const evaluated = new Set<string>()
          for (const typed of [false, true]) {
            const batch = [...applicable.filter(entry => Boolean(entry.config.typed) === typed), ...(typed ? deferred : [])]
            if (!batch.length) continue
            if (typed && !project) {
              for (const entry of batch) unavailable(entry, document.file, 'No consumer tsconfig.json or jsconfig.json is available for a real type program.')
              continue
            }
            if (typed && !typedServiceUsed) {
              typescriptParser.clearCaches()
              typedServiceUsed = true
            }
            const modules: Record<string, Rule.RuleModule> = {}
            const rules: NonNullable<Linter.Config['rules']> = {}
            const byId = new Map<string, RuleEngineEntry<EslintRuleConfig<Services>>>()
            const diagnosticStart = result.diagnostics.length
            try {
              for (const entry of batch) {
                // Stable across disabled selections and conditional type-stage batches.
                const key = encodeURIComponent(entry.definition.code)
                const dc = documentContext(entry)
                modules[key] = typeof entry.config.module === 'function'
                  ? entry.config.module({ ...dc, unavailable: reason => unavailable(entry, document.file, reason) })
                  : entry.config.module
                const arguments_ = typeof entry.config.options === 'function' ? entry.config.options(dc) : entry.config.options ?? []
                const id = `doctor/${key}`
                rules[id] = ['warn', ...arguments_] as Linter.RuleEntry
                byId.set(id, entry)
              }
              const config: Linter.Config = {
                files: ['**/*.{vue,js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
                languageOptions: {
                  parser: (sfc ? vueParser : typescriptParser) as unknown as NonNullable<Linter.Config['languageOptions']>['parser'],
                  parserOptions: {
                    ecmaVersion: 'latest', sourceType: filename.endsWith('.cjs') ? 'commonjs' : 'module', ecmaFeatures: { jsx: true },
                    parser: externalScript || unsupportedScript ? false : typescriptParser,
                    ...(sfc ? { vueFeatures: { filter: true } } : {}),
                    ...(typed ? { projectService: true, tsconfigRootDir: root, extraFileExtensions: ['.vue'] } : {})
                  },
                  globals: { defineProps: 'readonly', defineEmits: 'readonly', defineExpose: 'readonly', defineOptions: 'readonly', defineModel: 'readonly', withDefaults: 'readonly' }
                },
                linterOptions: { noInlineConfig: true },
                plugins: { doctor: { rules: modules } },
                settings: options.settings?.(services) ?? {}, rules
              }
              const messages = linter.verify(document.text, [config], { filename, allowInlineConfig: false })
              const fatal = messages.find(message => message.fatal || !message.ruleId)
              if (fatal) {
                const reason = stableEngineMessage(fatal.message, root, filename, byId)
                for (const entry of batch) unavailable(entry, document.file, reason, !typed || !typeProgramFailure(fatal.message))
                continue
              }
              for (const entry of batch) {
                const state = states.get(entry.definition.code)!
                if (!evaluated.has(entry.definition.code)) state.files = (state.files ?? 0) + 1
                evaluated.add(entry.definition.code)
                if (!['unavailable', 'policy-pending'].includes(state.status)) {
                  if (state.status !== 'checked') delete state.reason
                  state.status = 'checked'
                }
              }
              for (const message of messages) {
                const entry = byId.get(message.ruleId!)
                if (!entry) continue
                const dc = documentContext(entry)
                const output = entry.config.onMessage ? entry.config.onMessage(message, dc) : diagnosticFromMessage(message, dc)
                if (!output) continue
                if ('unavailable' in output) unavailable(entry, document.file, output.unavailable, output.parse)
                else if ('defer' in output) {
                  if (!typed && entry.config.deferred && !deferred.some(item => item.definition.code === entry.definition.code)) deferred.push({ definition: entry.definition, config: entry.config.deferred })
                  else unavailable(entry, document.file, 'The rule requested a type stage that is not available.')
                } else result.diagnostics.push(output)
              }
            } catch (error) {
              // A throwing adapter cannot leave half of this document's batch in the report.
              result.diagnostics.splice(diagnosticStart)
              const reason = stableEngineMessage(error instanceof Error ? error.message : String(error), root, filename, byId)
              for (const entry of batch) unavailable(entry, document.file, `The isolated script engine could not evaluate this file: ${reason}`)
            }
          }
          for (const entry of applicable) {
            const failure = entry.config.failures?.(documentContext(entry))
            if (failure) unavailable(entry, document.file, failure)
          }
        }
      } finally {
        try { if (prepared) await options.dispose?.(services) }
        finally { if (typedServiceUsed) typescriptParser.clearCaches() }
      }
      result.checks = [...states.values()]
      return result
    }
  })
}

function nearestProject(filename: string, root: string): string | undefined {
  let directory = path.dirname(filename)
  const relative = path.relative(root, directory)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  while (true) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = path.join(directory, name)
      if (existsSync(candidate)) return candidate
    }
    if (directory === root) return undefined
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function typeProgramFailure(message: string): boolean {
  return /project service|projectService|tsconfig|jsconfig|was not found by the project|does not include this file|parserOptions\.project|not part of the project|maximum number of files/i.test(message)
}

function stableEngineMessage<Services>(message: string, root: string, filename: string, byId: ReadonlyMap<string, RuleEngineEntry<EslintRuleConfig<Services>>>): string {
  let normalized = message.replaceAll(filename, path.relative(root, filename).split(path.sep).join('/')).replaceAll(root, '.')
  for (const [id, entry] of byId) normalized = normalized.replaceAll(id, entry.definition.code)
  return normalized
}

function diagnosticFromMessage<Services>(message: Linter.LintMessage, dc: EslintDocumentContext<Services>): Diagnostic {
  const severity = dc.context.rules[dc.definition.code]
  return {
    code: dc.definition.code, file: dc.document.file,
    severity: severity && severity !== 'off' ? severity : dc.definition.defaultSeverity ?? 'warning',
    message: message.message, confidence: 'high', fixes: [],
    evidence: [{ kind: 'eslint-ast', file: dc.document.file, line: message.line, column: message.column, message: dc.definition.title }]
  }
}

/** Shared default provider for independently authored ESTree checks and official delegates. */
export const eslintEngine = createEslintRuleEngine()

export function eslintRule(config: EslintRuleConfig): EngineRuleCheck<EslintRuleConfig> {
  return engineRule(eslintEngine, config)
}

/** Author a native ESLint visitor with selectors, comments, scope and parser services. */
export function estreeRule(module: Rule.RuleModule, options?: readonly unknown[]): EngineRuleCheck<EslintRuleConfig> {
  return eslintRule({ module, options })
}

export type { Rule } from 'eslint'
export {
  createProjectEslintSession,
  findProjectEslintConfig
} from './project.js'
export type {
  ProjectEslintFilePlan,
  ProjectEslintLintFile,
  ProjectEslintLintResult,
  ProjectEslintMessage,
  ProjectEslintPreparation,
  ProjectEslintRuleState,
  ProjectEslintSession
} from './project.js'

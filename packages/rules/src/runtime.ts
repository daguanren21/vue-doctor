import {
  isDoctorRuleApplicable,
  isDoctorRuleEnabled,
  resolveDoctorRuleSeverity,
  type DoctorRuleCheck,
  type DoctorRuleDefinition,
  type DoctorRulePackContext,
  type DoctorRulePackResult,
  type EvidenceLocation,
  type SkippedCheckReason
} from '@vue-doctor/core'
import type { SourceDocument, SourceDocumentBlock } from '@vue-doctor/source'
import type { File as BabelFile, Node as BabelNode } from '@babel/types'
import type { ParserOptions as BabelParserOptions } from '@babel/parser'
import type { Node as OxcNode, ParserOptions as OxcParserOptions, Program as OxcProgram } from 'oxc-parser'
import { isAbsolute, resolve } from 'node:path'
import { fillEvidenceLocation, sourceLocation, sourceRange } from './location.js'
import type {
  BabelRuleContext,
  BabelScriptRuleCheck,
  OxcRuleContext,
  OxcScriptRuleCheck,
  RuleCheck,
  RuleDefinition,
  RuleEngine,
  RuleEngineEntry,
  RuleReportInput,
  RuleSourceRange,
  SafeBabelParserOptions,
  ScriptBackendCapabilities,
  ScriptRuleCapabilities,
  ScriptRuleCheck
} from './types.js'

interface ExecutableRule {
  definition: DoctorRuleDefinition
  authored: RuleDefinition<RuleCheck>
}

interface ExecutableScriptRule extends ExecutableRule {
  authored: RuleDefinition<ScriptRuleCheck>
}

type ParsedBlock =
  | { status: 'parsed'; ast: OxcProgram | BabelFile }
  | { status: 'parse-failed'; message: string; range?: RuleSourceRange }
  | { status: 'unavailable'; message: string }

interface BlockFailure {
  document: Readonly<SourceDocument>
  block?: Readonly<SourceDocumentBlock>
  message: string
  reason: SkippedCheckReason
  range?: RuleSourceRange
  evidence?: EvidenceLocation
}

interface RuleState {
  successfulBlocks: number
  successfulFiles: Set<string>
  failures: BlockFailure[]
}

const SCRIPT_LANGUAGES = new Map<string, 'js' | 'jsx' | 'ts' | 'tsx'>([
  ['js', 'js'],
  ['javascript', 'js'],
  ['mjs', 'js'],
  ['cjs', 'js'],
  ['jsx', 'jsx'],
  ['ts', 'ts'],
  ['typescript', 'ts'],
  ['mts', 'ts'],
  ['cts', 'ts'],
  ['tsx', 'tsx']
])

const OXC_CAPABILITIES = Object.freeze({ syntax: true, scope: false, types: false })
const BABEL_CAPABILITIES = Object.freeze({ syntax: true, scope: true, types: false })

let oxcModulesPromise: Promise<typeof import('oxc-parser')> | undefined
let babelModulesPromise: Promise<{
  parser: typeof import('@babel/parser')
  traverse: typeof import('@babel/traverse').default
}> | undefined

export async function runDefinedRules(
  packName: string,
  rules: readonly ExecutableRule[],
  context: DoctorRulePackContext
): Promise<DoctorRulePackResult> {
  const result: DoctorRulePackResult = { diagnostics: [], skippedChecks: [], checks: [] }
  const parseCache = new Map<Readonly<SourceDocumentBlock>, Map<string, Promise<ParsedBlock>>>()
  const outcomes = new Map<ExecutableRule, DoctorRuleCheck>()
  const engineGroups = new Map<RuleEngine<unknown>, ExecutableRule[]>()
  for (const rule of rules) {
    if (rule.authored.check.kind === 'engine') {
      const preliminary = enginePreliminaryCheck(packName, rule.definition, context)
      if (preliminary) {
        outcomes.set(rule, preliminary)
        continue
      }
      const engine = rule.authored.check.engine
      const group = engineGroups.get(engine)
      if (group) group.push(rule)
      else engineGroups.set(engine, [rule])
      continue
    }
    outcomes.set(rule, await runRule(packName, rule as ExecutableScriptRule, context, result, parseCache))
  }
  for (const [engine, groupedRules] of engineGroups) {
    const batch = await runEngineBatch(packName, engine, groupedRules, context)
    result.diagnostics.push(...batch.result.diagnostics)
    result.skippedChecks.push(...batch.result.skippedChecks)
    for (const rule of groupedRules) outcomes.set(rule, batch.checks.get(rule.definition.code)!)
  }
  for (const rule of rules) {
    const outcome = outcomes.get(rule)
    if (!outcome) {
      throw new Error(`Rule ${rule.definition.code} did not receive an execution outcome.`)
    }
    result.checks!.push(outcome)
  }
  return result
}

function enginePreliminaryCheck(
  packName: string,
  definition: DoctorRuleDefinition,
  context: DoctorRulePackContext
): DoctorRuleCheck | undefined {
  if (!isDoctorRuleEnabled(definition, context.rules)) {
    return { ruleCode: definition.code, rulePack: packName, status: 'disabled' }
  }
  if (definition.verification && definition.verification !== 'static') {
    return {
      ruleCode: definition.code,
      rulePack: packName,
      status: definition.verification,
      reason: definition.description
    }
  }
  return undefined
}

async function runEngineBatch(
  packName: string,
  engine: RuleEngine<unknown>,
  rules: readonly ExecutableRule[],
  context: DoctorRulePackContext
): Promise<{ result: DoctorRulePackResult; checks: Map<string, DoctorRuleCheck> }> {
  const entries: RuleEngineEntry<unknown>[] = rules.map(({ definition, authored }) => ({
    definition,
    config: authored.check.kind === 'engine' ? authored.check.config : undefined
  }))
  let provided: DoctorRulePackResult
  try {
    provided = await engine.runBatch(context, entries)
    return normalizeEngineResult(packName, engine, rules, provided)
  } catch (error) {
    return failedEngineResult(packName, engine, rules, `Rule engine failed: ${errorMessage(error)}`)
  }
}

function normalizeEngineResult(
  packName: string,
  engine: RuleEngine<unknown>,
  rules: readonly ExecutableRule[],
  provided: DoctorRulePackResult
): { result: DoctorRulePackResult; checks: Map<string, DoctorRuleCheck> } {
  if (!provided || typeof provided !== 'object'
    || !Array.isArray(provided.diagnostics)
    || !Array.isArray(provided.skippedChecks)
    || (provided.checks !== undefined && !Array.isArray(provided.checks))) {
    throw new Error('runBatch must return diagnostics and skippedChecks arrays, with an optional checks array.')
  }

  const activeCodes = new Set(rules.map((rule) => rule.definition.code))
  const outputCodes = [
    ...provided.diagnostics.map((diagnostic) => diagnostic.code),
    ...provided.skippedChecks.map((skipped) => skipped.ruleCode),
    ...(provided.checks ?? []).map((check) => check.ruleCode)
  ]
  const unknownCode = outputCodes.find((code) => !activeCodes.has(code))
  if (unknownCode) {
    throw new Error(`runBatch returned output for undeclared or disabled rule ${JSON.stringify(unknownCode)}.`)
  }

  const checks = new Map<string, DoctorRuleCheck>()
  const staticStatuses = new Set<DoctorRuleCheck['status']>([
    'checked', 'partial', 'not-applicable', 'unavailable', 'disabled', 'policy-pending'
  ])
  for (const check of provided.checks ?? []) {
    if (checks.has(check.ruleCode)) {
      throw new Error(`runBatch returned duplicate execution records for ${JSON.stringify(check.ruleCode)}.`)
    }
    if (!staticStatuses.has(check.status)) {
      throw new Error(
        `runBatch returned invalid static status ${JSON.stringify(check.status)} for ${JSON.stringify(check.ruleCode)}.`
      )
    }
    checks.set(check.ruleCode, { ...check, rulePack: packName })
  }

  const missingCodes = new Set<string>()
  for (const rule of rules) {
    if (!checks.has(rule.definition.code)) missingCodes.add(rule.definition.code)
  }
  const result: DoctorRulePackResult = {
    diagnostics: provided.diagnostics
      .filter((diagnostic) => !missingCodes.has(diagnostic.code))
      .map((diagnostic) => ({ ...diagnostic, rulePack: packName })),
    skippedChecks: provided.skippedChecks.filter((skipped) => !missingCodes.has(skipped.ruleCode)),
    checks: []
  }
  for (const code of missingCodes) {
    const message = `Rule engine ${JSON.stringify(engine.name)} did not return an execution record for ${JSON.stringify(code)}.`
    result.skippedChecks.push(engineSkip(code, engine.name, message))
    checks.set(code, {
      ruleCode: code,
      rulePack: packName,
      status: 'unavailable',
      reason: message
    })
  }
  return { result, checks }
}

function failedEngineResult(
  packName: string,
  engine: RuleEngine<unknown>,
  rules: readonly ExecutableRule[],
  failure: string
): { result: DoctorRulePackResult; checks: Map<string, DoctorRuleCheck> } {
  const message = `${failure} (${engine.name}).`
  const checks = new Map<string, DoctorRuleCheck>()
  const result: DoctorRulePackResult = { diagnostics: [], skippedChecks: [], checks: [] }
  for (const rule of rules) {
    result.skippedChecks.push(engineSkip(rule.definition.code, engine.name, message))
    checks.set(rule.definition.code, {
      ruleCode: rule.definition.code,
      rulePack: packName,
      status: 'unavailable',
      reason: message
    })
  }
  return { result, checks }
}

function engineSkip(ruleCode: string, engineName: string, message: string) {
  return {
    ruleCode,
    required: true,
    reason: 'missing-capability' as const,
    evidence: [{ kind: 'custom-rule-engine-prerequisite', message: `${engineName}: ${message}` }]
  }
}

async function runRule(
  packName: string,
  rule: ExecutableScriptRule,
  packContext: DoctorRulePackContext,
  result: DoctorRulePackResult,
  parseCache: Map<Readonly<SourceDocumentBlock>, Map<string, Promise<ParsedBlock>>>
): Promise<DoctorRuleCheck> {
  const { definition, authored } = rule
  if (!isDoctorRuleEnabled(definition, packContext.rules)) {
    return { ruleCode: definition.code, rulePack: packName, status: 'disabled' }
  }
  if (packContext.documents?.length === 0) {
    return { ruleCode: definition.code, rulePack: packName, status: 'not-applicable', files: 0 }
  }
  if (definition.verification && definition.verification !== 'static') {
    return {
      ruleCode: definition.code,
      rulePack: packName,
      status: definition.verification,
      reason: definition.description
    }
  }

  const missingMetadata = unavailableMetadataRequirement(definition)
  if (missingMetadata) {
    addSkip(result, definition.code, {
      document: undefined,
      message: missingMetadata,
      reason: 'missing-capability'
    }, authored.check.parser)
    return { ruleCode: definition.code, rulePack: packName, status: 'unavailable', reason: missingMetadata }
  }

  const missingCapability = unavailableCapability(authored.check) ?? invalidParserOptions(authored.check)
  if (missingCapability) {
    addSkip(result, definition.code, {
      document: undefined,
      message: missingCapability,
      reason: 'missing-capability'
    }, authored.check.parser)
    return { ruleCode: definition.code, rulePack: packName, status: 'unavailable', reason: missingCapability }
  }

  if (packContext.documents === undefined) {
    const message = 'Source documents are unavailable; this script rule requires the current Doctor run documents.'
    addSkip(result, definition.code, { document: undefined, message, reason: 'missing-capability' }, authored.check.parser)
    return { ruleCode: definition.code, rulePack: packName, status: 'unavailable', reason: message }
  }

  const state: RuleState = { successfulBlocks: 0, successfulFiles: new Set(), failures: [] }
  for (const document of packContext.documents) {
    const vueVersion = vueVersionForDocument(packContext, document.file)
    if (!isDoctorRuleApplicable(definition, { vueVersion, assumeLatestVueVersion: false })) {
      if (vueVersion === undefined && hasVueRequirement(definition)) {
        state.failures.push({
          document,
          message: 'Vue version evidence is unavailable; rule applicability could not be determined.',
          reason: 'missing-capability'
        })
      }
      continue
    }
    if (definition.requires?.vueVersion === 'known' && vueVersion === undefined) {
      state.failures.push({
        document,
        message: 'An installed or declared Vue version is required by this rule but is unavailable.',
        reason: 'missing-capability'
      })
      continue
    }
    const { blocks, failures } = scriptBlocks(document, definition)
    state.failures.push(...failures)
    if (blocks.length > 0) {
      const companionFailures = await allSourceBlockFailures(
        packContext,
        document,
        definition,
        authored.check,
        parseCache
      )
      if (companionFailures.length > 0) {
        state.failures.push(...companionFailures)
        continue
      }
    }
    for (const block of blocks) {
      const parsed = await cachedParse(parseCache, document, block, authored.check)
      if (parsed.status !== 'parsed') {
        state.failures.push({
          document,
          block,
          message: parsed.message,
          reason: parsed.status === 'parse-failed' ? 'parse-failed' : 'missing-capability',
          ...(parsed.status === 'parse-failed' && parsed.range ? { range: parsed.range } : {})
        })
        continue
      }

      const bufferedDiagnostics: DoctorRulePackResult['diagnostics'] = []
      try {
        if (authored.check.parser === 'oxc') {
          await runOxcRule(packName, definition, authored.check, packContext, document, block, parsed.ast as OxcProgram, bufferedDiagnostics)
        } else {
          await runBabelRule(packName, definition, authored.check, packContext, document, block, parsed.ast as BabelFile, bufferedDiagnostics)
        }
        result.diagnostics.push(...bufferedDiagnostics)
        state.successfulBlocks += 1
        state.successfulFiles.add(document.file)
      } catch (error) {
        state.failures.push({
          document,
          block,
          message: `Rule callback failed: ${errorMessage(error)}`,
          reason: 'missing-capability'
        })
      }
    }
  }

  for (const failure of state.failures) addSkip(result, definition.code, failure, authored.check.parser)
  if (state.failures.length > 0) {
    const reason = state.failures.length === 1
      ? state.failures[0]!.message
      : `${state.failures.length} script blocks could not be checked.`
    return {
      ruleCode: definition.code,
      rulePack: packName,
      status: state.successfulBlocks > 0 ? 'partial' : 'unavailable',
      reason,
      files: state.successfulFiles.size
    }
  }
  if (state.successfulBlocks === 0) {
    return { ruleCode: definition.code, rulePack: packName, status: 'not-applicable', files: 0 }
  }
  return { ruleCode: definition.code, rulePack: packName, status: 'checked', files: state.successfulFiles.size }
}

async function runOxcRule(
  packName: string,
  definition: DoctorRuleDefinition,
  check: OxcScriptRuleCheck,
  packContext: DoctorRulePackContext,
  document: Readonly<SourceDocument>,
  block: Readonly<SourceDocumentBlock>,
  pristineAst: OxcProgram,
  diagnostics: DoctorRulePackResult['diagnostics']
): Promise<void> {
  const modules = await loadOxcModules()
  const context = createRuleContext<OxcNode>(packName, definition, check.parser, OXC_CAPABILITIES, packContext, document, block, diagnostics)
  const visitor = check.create(context as OxcRuleContext)
  new modules.Visitor(visitor).visit(structuredClone(pristineAst))
}

async function runBabelRule(
  packName: string,
  definition: DoctorRuleDefinition,
  check: BabelScriptRuleCheck,
  packContext: DoctorRulePackContext,
  document: Readonly<SourceDocument>,
  block: Readonly<SourceDocumentBlock>,
  pristineAst: BabelFile,
  diagnostics: DoctorRulePackResult['diagnostics']
): Promise<void> {
  const modules = await loadBabelModules()
  const context = createRuleContext<BabelNode>(packName, definition, check.parser, BABEL_CAPABILITIES, packContext, document, block, diagnostics)
  modules.traverse(structuredClone(pristineAst), check.create(context as BabelRuleContext))
}

function createRuleContext<Node extends { start?: number | null; end?: number | null }>(
  packName: string,
  definition: DoctorRuleDefinition,
  backend: 'oxc' | 'babel',
  capabilities: Readonly<ScriptBackendCapabilities>,
  packContext: DoctorRulePackContext,
  document: Readonly<SourceDocument>,
  block: Readonly<SourceDocumentBlock>,
  diagnostics: DoctorRulePackResult['diagnostics']
) {
  const wholeBlock = { start: 0, end: block.content.length }
  return {
    backend,
    capabilities,
    document,
    block,
    source: block.content,
    location(nodeOrRange: Node | RuleSourceRange) {
      return sourceLocation(document, block, nodeOrRange)
    },
    text(nodeOrRange: Node | RuleSourceRange) {
      const range = sourceRange(nodeOrRange, block)
      return block.content.slice(range.start, range.end)
    },
    report(input: RuleReportInput<Node>) {
      const target = input.node ?? input.range ?? wholeBlock
      const location = sourceLocation(document, block, target)
      const evidence = input.evidence?.length
        ? input.evidence.map((item) => fillEvidenceLocation(item, location))
        : [{
            kind: `custom-rule-${backend}-ast`,
            file: document.file,
            line: location.start.line,
            column: location.start.column,
            endLine: location.end.line,
            endColumn: location.end.column,
            message: `${backend} syntax evidence for ${definition.title}.`
          } satisfies EvidenceLocation]
      diagnostics.push({
        code: definition.code,
        severity: input.severity ?? resolveDoctorRuleSeverity(definition, packContext.rules) ?? 'warning',
        message: input.message,
        file: document.file,
        evidence,
        fixes: input.fixes ? [...input.fixes] : [],
        confidence: input.confidence ?? 'high',
        ...(definition.domain ? { domain: definition.domain } : {}),
        ...(definition.tags ? { tags: definition.tags } : {}),
        rulePack: packName,
        primaryLocation: {
          file: document.file,
          start: { line: location.start.line, column: location.start.column },
          end: { line: location.end.line, column: location.end.column },
          precision: location.start.offset === location.end.offset ? 'point' : 'range'
        }
      })
    }
  }
}

function scriptBlocks(document: Readonly<SourceDocument>, definition: DoctorRuleDefinition): {
  blocks: Readonly<SourceDocumentBlock>[]
  failures: BlockFailure[]
} {
  const blocks: Readonly<SourceDocumentBlock>[] = []
  const failures: BlockFailure[] = []
  const structuralFailures = structuralFailuresForKinds(document, primaryBlockKinds(definition))
  if (structuralFailures.length > 0) return { blocks, failures: structuralFailures }
  if (document.blocks.length === 0) {
    if (SCRIPT_LANGUAGES.has(document.language.toLowerCase()) || (document.text.length === 0 && document.errors.length > 0)) {
      failures.push({
        document,
        message: document.errors[0]?.message ?? 'The source document has no readable source blocks.',
        reason: 'missing-capability'
      })
    }
    return { blocks, failures }
  }

  for (const block of document.blocks) {
    if (block.kind !== 'script' && block.kind !== 'document') continue
    const normalizedLanguage = SCRIPT_LANGUAGES.get(block.lang.toLowerCase())
    if (block.kind === 'document' && normalizedLanguage === undefined) continue
    if (!matchesRequiredPrimaryBlock(block, definition)) continue
    if (block.attributes.src) {
      failures.push({
        document,
        block,
        message: 'External script blocks require their separately resolved source and source map.',
        reason: 'missing-capability'
      })
      continue
    }
    if (normalizedLanguage === undefined) {
      failures.push({
        document,
        block,
        message: `Unsupported script language: ${block.lang}.`,
        reason: 'missing-capability'
      })
      continue
    }
    if (!validBlockStructure(document, block)) {
      failures.push({
        document,
        block,
        message: 'The script block offsets do not match the current source document.',
        reason: 'missing-capability'
      })
      continue
    }
    blocks.push(block)
  }
  return { blocks, failures }
}

function structuralFailuresForKinds(
  document: Readonly<SourceDocument>,
  kinds: ReadonlySet<'template' | 'script' | 'script-setup'>
): BlockFailure[] {
  const structuralFailures = document.structuralFailures
  if (!structuralFailures) return []
  return structuralFailures
    .filter((failure) => failure.block === undefined || kinds.has(failure.block))
    .map((failure): BlockFailure => ({
      document,
      message: failure.message,
      reason: 'parse-failed',
      evidence: {
        kind: 'custom-rule-source-structure',
        file: document.file,
        ...(failure.line === undefined ? {} : { line: failure.line }),
        ...(failure.column === undefined ? {} : { column: failure.column }),
        message: failure.message
      }
    }))
}

function primaryBlockKinds(definition: DoctorRuleDefinition): ReadonlySet<'template' | 'script' | 'script-setup'> {
  const required = definition.requires?.sourceBlocks
  return new Set(required?.length
    ? required.filter((kind): kind is 'script' | 'script-setup' => kind === 'script' || kind === 'script-setup')
    : ['script', 'script-setup'])
}

function matchesRequiredPrimaryBlock(
  block: Readonly<SourceDocumentBlock>,
  definition: DoctorRuleDefinition
): boolean {
  const required = definition.requires?.sourceBlocks
  if (!required?.length) return true
  if (block.kind === 'document') return required.includes('script')
  return required.includes(block.attributes.setup ? 'script-setup' : 'script')
}

async function allSourceBlockFailures(
  context: DoctorRulePackContext,
  document: Readonly<SourceDocument>,
  definition: DoctorRuleDefinition,
  check: ScriptRuleCheck,
  parseCache: Map<Readonly<SourceDocumentBlock>, Map<string, Promise<ParsedBlock>>>
): Promise<BlockFailure[]> {
  const failures: BlockFailure[] = []
  for (const kind of definition.requires?.allSourceBlocks ?? []) {
    const structuralFailures = structuralFailuresForKinds(document, new Set([kind]))
    if (structuralFailures.length > 0) {
      failures.push(...structuralFailures)
      continue
    }
    const block = document.blocks.find((candidate) => kind === 'template'
      ? candidate.kind === 'template'
      : candidate.kind === 'script' && Boolean(candidate.attributes.setup) === (kind === 'script-setup'))
    if (!block) {
      failures.push({
        document,
        message: `Required ${kind} source block is unavailable.`,
        reason: 'missing-capability'
      })
      continue
    }
    if (block.attributes.src) {
      failures.push({
        document,
        block,
        message: `Required external ${kind} source is unresolved.`,
        reason: 'missing-capability'
      })
      continue
    }
    if (!validBlockStructure(document, block)) {
      failures.push({
        document,
        block,
        message: `Required ${kind} block offsets do not match the current source document.`,
        reason: 'missing-capability'
      })
      continue
    }
    if (kind === 'template' && !['html', 'vue'].includes(block.lang.toLowerCase())) {
      failures.push({
        document,
        block,
        message: `Required ${kind} source language ${block.lang} is unreadable without a preprocessor source map.`,
        reason: 'missing-capability'
      })
      continue
    }
    if (kind !== 'template' && !SCRIPT_LANGUAGES.has(block.lang.toLowerCase())) {
      failures.push({
        document,
        block,
        message: `Required ${kind} source language ${block.lang} is unsupported.`,
        reason: 'missing-capability'
      })
      continue
    }
    if (kind === 'template') {
      const templateFailure = templateCapabilityFailure(context, document, block)
      if (templateFailure) failures.push(templateFailure)
      continue
    }
    const parsed = await cachedParse(parseCache, document, block, check)
    if (parsed.status !== 'parsed') {
      failures.push({
        document,
        block,
        message: parsed.message,
        reason: parsed.status === 'parse-failed' ? 'parse-failed' : 'missing-capability',
        ...(parsed.status === 'parse-failed' && parsed.range ? { range: parsed.range } : {})
      })
    }
  }
  return failures
}

function templateCapabilityFailure(
  context: DoctorRulePackContext,
  document: Readonly<SourceDocument>,
  block: Readonly<SourceDocumentBlock>
): BlockFailure | undefined {
  const fileResult = context.source.fileResults.find((candidate) => sameFile(
    context.source.root,
    candidate.file,
    document.file
  ))
  const template = fileResult?.blocks.find((candidate) => candidate.kind === 'template')
  if (!template) {
    return {
      document,
      block,
      message: 'Required template parser capability evidence is unavailable for this document.',
      reason: 'missing-capability'
    }
  }
  if (template.status === 'available') return undefined
  return {
    document,
    block,
    message: template.message ?? (template.status === 'failed'
      ? 'Required template parsing failed.'
      : 'Required template source block is unavailable.'),
    reason: template.status === 'failed' ? 'parse-failed' : 'missing-capability'
  }
}

function sameFile(root: string, left: string, right: string): boolean {
  const absoluteLeft = isAbsolute(left) ? resolve(left) : resolve(root, left)
  const absoluteRight = isAbsolute(right) ? resolve(right) : resolve(root, right)
  return absoluteLeft === absoluteRight
}

function validBlockStructure(document: Readonly<SourceDocument>, block: Readonly<SourceDocumentBlock>): boolean {
  return Number.isInteger(block.start)
    && Number.isInteger(block.end)
    && block.start >= 0
    && block.end >= block.start
    && block.end <= document.text.length
    && document.text.slice(block.start, block.end) === block.content
}

async function cachedParse(
  cache: Map<Readonly<SourceDocumentBlock>, Map<string, Promise<ParsedBlock>>>,
  document: Readonly<SourceDocument>,
  block: Readonly<SourceDocumentBlock>,
  check: ScriptRuleCheck
): Promise<ParsedBlock> {
  const normalizedLanguage = SCRIPT_LANGUAGES.get(block.lang.toLowerCase())!
  const effectiveOptions = check.parser === 'oxc'
    ? oxcOptions(document, normalizedLanguage, check.parserOptions)
    : babelOptions(document, normalizedLanguage, check.parserOptions)
  const key = `${check.parser}:${stableStringify(effectiveOptions)}`
  let byOptions = cache.get(block)
  if (!byOptions) {
    byOptions = new Map()
    cache.set(block, byOptions)
  }
  let parsed = byOptions.get(key)
  if (!parsed) {
    parsed = check.parser === 'oxc'
      ? parseOxcBlock(document, block, effectiveOptions as OxcParserOptions)
      : parseBabelBlock(document, block, effectiveOptions as BabelParserOptions)
    byOptions.set(key, parsed)
  }
  return parsed
}

async function parseOxcBlock(
  document: Readonly<SourceDocument>,
  block: Readonly<SourceDocumentBlock>,
  options: OxcParserOptions
): Promise<ParsedBlock> {
  let modules: typeof import('oxc-parser')
  try {
    modules = await loadOxcModules()
  } catch (error) {
    return { status: 'unavailable', message: `The Oxc backend is unavailable: ${errorMessage(error)}` }
  }
  try {
    const parsed = modules.parseSync(document.file, block.content, options)
    const error = parsed.errors[0]
    if (error) {
      const label = error.labels[0]
      return {
        status: 'parse-failed',
        message: error.message,
        ...(label ? { range: safeRange(label.start, label.end, block.content.length) } : {})
      }
    }
    return { status: 'parsed', ast: parsed.program }
  } catch (error) {
    return { status: 'parse-failed', message: errorMessage(error) }
  }
}

async function parseBabelBlock(
  _document: Readonly<SourceDocument>,
  block: Readonly<SourceDocumentBlock>,
  options: BabelParserOptions
): Promise<ParsedBlock> {
  if (!supportsBabelRuntime()) {
    return {
      status: 'unavailable',
      message: `The Babel backend requires Node ^22.18.0 or >=24.11.0; current runtime is ${process.versions.node}.`
    }
  }
  let modules: Awaited<ReturnType<typeof loadBabelModules>>
  try {
    modules = await loadBabelModules()
  } catch (error) {
    return { status: 'unavailable', message: `The Babel backend is unavailable: ${errorMessage(error)}` }
  }
  try {
    const parsed = modules.parser.parse(block.content, options)
    const recoveredError = parsed.errors?.[0]
    if (recoveredError) {
      return {
        status: 'parse-failed',
        message: recoveredError.message,
        range: safeRange(recoveredError.loc.index, recoveredError.loc.index + 1, block.content.length)
      }
    }
    return { status: 'parsed', ast: parsed }
  } catch (error) {
    const offset = parserErrorOffset(error)
    return {
      status: 'parse-failed',
      message: errorMessage(error),
      ...(offset === undefined ? {} : { range: safeRange(offset, offset + 1, block.content.length) })
    }
  }
}

function oxcOptions(
  document: Readonly<SourceDocument>,
  language: 'js' | 'jsx' | 'ts' | 'tsx',
  options: Omit<OxcParserOptions, 'lang'> | undefined
): OxcParserOptions {
  return {
    sourceType: defaultSourceType(document),
    ...options,
    lang: language
  }
}

function babelOptions(
  document: Readonly<SourceDocument>,
  language: 'js' | 'jsx' | 'ts' | 'tsx',
  options: SafeBabelParserOptions | undefined
): BabelParserOptions {
  const plugins = [...(options?.plugins ?? [])]
  if ((language === 'ts' || language === 'tsx') && !hasBabelPlugin(plugins, 'typescript')) plugins.push('typescript')
  if ((language === 'jsx' || language === 'tsx') && !hasBabelPlugin(plugins, 'jsx')) plugins.push('jsx')
  return {
    sourceType: defaultSourceType(document),
    ...options,
    plugins
  }
}

function defaultSourceType(document: Readonly<SourceDocument>): 'module' | 'commonjs' {
  return /\.(?:cjs|cts)$/i.test(document.file) ? 'commonjs' : 'module'
}

function hasBabelPlugin(plugins: NonNullable<BabelParserOptions['plugins']>, name: string): boolean {
  return plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name)
}

function unavailableCapability(check: ScriptRuleCheck): string | undefined {
  const capabilities = check.parser === 'babel' ? BABEL_CAPABILITIES : OXC_CAPABILITIES
  const missing = (['syntax', 'scope', 'types'] as const).filter((name) => check.requires?.[name] && !capabilities[name])
  if (missing.length === 0) return undefined
  return `The ${check.parser} backend does not provide required ${missing.join(' and ')} capability.`
}

function invalidParserOptions(check: ScriptRuleCheck): string | undefined {
  if (check.parser !== 'babel' || !check.parserOptions) return undefined
  const unsafe = check.parserOptions as BabelParserOptions & {
    startColumn?: unknown
    startIndex?: unknown
    startLine?: unknown
  }
  if (unsafe.startColumn !== undefined || unsafe.startIndex !== undefined || unsafe.startLine !== undefined) {
    return 'Babel startColumn/startIndex/startLine options are unavailable because custom-rule nodes must remain block-relative.'
  }
  if (unsafe.plugins?.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === 'estree')) {
    return 'The Babel estree plugin is unavailable because rules receive native Babel NodePath visitors.'
  }
  return undefined
}

function unavailableMetadataRequirement(
  definition: DoctorRuleDefinition
): string | undefined {
  const requires = definition.requires
  if (!requires) return undefined
  if (requires.ownership !== undefined) {
    return `Component ownership (${requires.ownership}) is not provided to script rules.`
  }
  if (requires.contractDimensions?.length) {
    return `Component contract dimensions (${requires.contractDimensions.join(', ')}) are not provided to script rules.`
  }
  if (requires.acceptance !== undefined) {
    return `Component acceptance evidence (${requires.acceptance}) is not provided to script rules.`
  }
  if (requires.signature !== undefined) {
    return `Component signature evidence (${requires.signature}) is not provided to script rules.`
  }
  const primaryBlocks = requires.sourceBlocks ?? []
  if (primaryBlocks.length > 0 && !primaryBlocks.some((kind) => kind === 'script' || kind === 'script-setup')) {
    return `Primary ${primaryBlocks.join(' or ')} source blocks cannot be checked by a script rule.`
  }
  return undefined
}

function vueVersionForDocument(context: DoctorRulePackContext, file: string): string | undefined {
  const absoluteFile = isAbsolute(file) ? resolve(file) : resolve(context.inventory.root, file)
  const owner = context.projectContext?.packages
    .filter((packageContext) => packageContext.targetFiles.some((target) => {
      const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(packageContext.root, target)
      return absoluteTarget === absoluteFile
    }))
    .sort((left, right) => right.root.length - left.root.length)[0]
  if (owner) {
    return owner.inventory.vue?.installedVersion ?? owner.inventory.vue?.declaredVersion
  }
  return context.inventory.vue?.installedVersion ?? context.inventory.vue?.declaredVersion
}

function addSkip(
  result: DoctorRulePackResult,
  ruleCode: string,
  failure: Omit<BlockFailure, 'document'> & { document?: Readonly<SourceDocument> },
  backend: 'oxc' | 'babel'
): void {
  const { document, block } = failure
  let evidence: EvidenceLocation = {
    kind: `custom-rule-${backend}-prerequisite`,
    ...(document ? { file: document.file } : {}),
    message: failure.message,
    ...failure.evidence
  }
  if (document && block) {
    const location = sourceLocation(document, block, failure.range ?? { start: 0, end: block.content.length })
    evidence = fillEvidenceLocation(evidence, location)
  }
  result.skippedChecks.push({
    ruleCode,
    required: true,
    reason: failure.reason,
    ...(document ? { file: document.file } : {}),
    evidence: [evidence]
  })
}

function hasVueRequirement(definition: DoctorRuleDefinition): boolean {
  const vue = definition.applicability?.vue
  return definition.requires?.vueVersion === 'known'
    || vue?.only !== undefined
    || vue?.minimumMinor !== undefined
}

function supportsBabelRuntime(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major === 22 && minor >= 18 || major === 24 && minor >= 11 || major >= 25
}

async function loadBabelModules() {
  if (!supportsBabelRuntime()) {
    throw new Error(`The Babel backend requires Node ^22.18.0 or >=24.11.0; current runtime is ${process.versions.node}.`)
  }
  babelModulesPromise ??= Promise.all([
    import('@babel/parser'),
    import('@babel/traverse')
  ]).then(([parser, traverse]) => ({ parser, traverse: traverse.default }))
  return babelModulesPromise
}

async function loadOxcModules() {
  oxcModulesPromise ??= import('oxc-parser')
  return oxcModulesPromise
}

function parserErrorOffset(error: unknown): number | undefined {
  const offset = (error as { loc?: { index?: unknown }; pos?: unknown } | undefined)?.loc?.index
    ?? (error as { pos?: unknown } | undefined)?.pos
  return typeof offset === 'number' ? offset : undefined
}

function safeRange(start: number, end: number, length: number): RuleSourceRange {
  const safeStart = Math.max(0, Math.min(length, start))
  return { start: safeStart, end: Math.max(safeStart, Math.min(length, end)) }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { ExecutableRule }

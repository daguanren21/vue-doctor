import type { AnalyzeSourceTextOptions, SourceAnalysisFact, SourceDocument, TargetFiles, VueComponentUsage, VueSourceUsageReport } from '@vue-doctor/source'
import type {
  ComponentOwnership,
  CoverageStatus,
  Diagnostic,
  DiagnosticSeverity,
  ProjectInventory,
  ProjectContext,
  RuleCapabilityRequirement,
  RuleSeveritySetting,
  SkippedCheck
} from './types.js'
import { resolveVueVersion } from './project.js'
import { isDoctorDiagnosticDomain } from './domains.js'
import type { DoctorDiagnosticDomain } from './domains.js'

export type DoctorVerification = 'static' | 'manual' | 'runtime' | 'policy-pending'

export interface DoctorRuleCheck {
  ruleCode: string
  rulePack?: string
  status: 'checked' | 'partial' | 'not-applicable' | 'unavailable' | 'manual' | 'runtime' | 'policy-pending' | 'disabled'
  reason?: string
  files?: number
}

export interface DoctorRuleDefinition {
  code: string
  title: string
  description: string
  category?: string
  /** Primary problem domain. Independent of a pack's execution-group category. */
  domain?: DoctorDiagnosticDomain
  tags?: readonly string[]
  verification?: DoctorVerification
  standards?: readonly string[]
  /** Whether the rule runs without an explicit per-code setting. Existing external packs default to true. */
  defaultEnabled?: boolean
  /** Documentation/authoring default. Runners do not rewrite emitted diagnostic severity from this field. */
  defaultSeverity?: DiagnosticSeverity
  /** Known evidence requirements. Omission means the requirements are not declared, not that none exist. */
  requires?: RuleCapabilityRequirement
  applicability?: DoctorRuleApplicability
  help?: DoctorRuleHelp
}

export interface DoctorRuleApplicability {
  vue?: {
    only?: 2 | 3
    minimumMinor?: number
  }
}

export interface DoctorRuleHelp {
  problem: string
  remediation: string
}

export interface DoctorRuleSelectionOptions {
  /** Compatibility fallback for definitions created before defaultEnabled existed. Default true. */
  defaultEnabled?: boolean
}

export interface DoctorRulePackContext {
  inventory: ProjectInventory
  /** Consuming package and application evidence, independent of diagnostic scope. */
  projectContext?: ProjectContext
  /** Effective diagnostic selection including discovery failures. */
  targetFiles?: TargetFiles
  /** Additional source profiles prepared from the same target text and parser facts. */
  sourceFacts?: readonly SourceAnalysisFact[]
  source: VueSourceUsageReport
  components: ReadonlyArray<{ usage: VueComponentUsage; ownership: ComponentOwnership }>
  rules: Readonly<Record<string, RuleSeveritySetting>>
  /** Opt-in documents requested by a pack; absent for component-only callers. */
  documents?: readonly SourceDocument[]
}

export interface DoctorRulePackResult {
  diagnostics: Diagnostic[]
  skippedChecks: SkippedCheck[]
  /** At most one execution record per declared rule. Omitted records are not proof of execution. */
  checks?: DoctorRuleCheck[]
}

/** Executable, explicitly trusted project configuration. Not a JSON module loader. */
export interface DoctorRulePack {
  name: string
  rules: readonly DoctorRuleDefinition[]
  /** Additional source languages required by this pack, without changing the default scan. */
  sourceExtensions?: readonly string[]
  /** Optional extraction profiles requested without executing the pack during discovery. */
  sourceAnalysisProfiles?: readonly AnalyzeSourceTextOptions[]
  run(context: DoctorRulePackContext): DoctorRulePackResult | Promise<DoctorRulePackResult>
}

export interface DoctorRulePackReport {
  name: string
  rules: readonly DoctorRuleDefinition[]
  coverageStatus: CoverageStatus
  checks?: DoctorRuleCheck[]
}

export function createDoctorRuleRegistry(
  groups: readonly (readonly DoctorRuleDefinition[])[]
): ReadonlyMap<string, DoctorRuleDefinition> {
  const registry = new Map<string, DoctorRuleDefinition>()
  for (const definitions of groups) {
    for (const definition of definitions) {
      if (registry.has(definition.code)) {
        throw new Error(`Duplicate Doctor rule code: ${definition.code}`)
      }
      registry.set(definition.code, definition)
    }
  }
  return registry
}

export function validateConfiguredDoctorRuleCodes(
  rules: Readonly<Record<string, RuleSeveritySetting>>,
  registry: ReadonlyMap<string, DoctorRuleDefinition>
): void {
  const unknownCodes = Object.keys(rules)
    .filter((code) => !registry.has(code))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (unknownCodes.length === 0) return

  throw new Error(
    `Unknown Doctor rule ${unknownCodes.length === 1 ? 'code' : 'codes'} in config "rules": ${unknownCodes.join(', ')}.`
  )
}

export function isDoctorRuleEnabled(
  definition: DoctorRuleDefinition,
  rules: Readonly<Record<string, RuleSeveritySetting>>,
  options: DoctorRuleSelectionOptions = {}
): boolean {
  const configured = rules[definition.code]
  if (configured === 'off') return false
  if (configured !== undefined) return true
  return definition.defaultEnabled ?? options.defaultEnabled ?? true
}

export function resolveDoctorRuleSeverity(
  definition: DoctorRuleDefinition,
  rules: Readonly<Record<string, RuleSeveritySetting>>
): DiagnosticSeverity | undefined {
  const configured = rules[definition.code]
  return configured === 'off' ? undefined : configured ?? definition.defaultSeverity
}

export function isDoctorRuleApplicable(
  definition: DoctorRuleDefinition,
  context: { vueVersion?: string; assumeLatestVueVersion?: boolean }
): boolean {
  const vue = definition.applicability?.vue
  if (!vue || (vue.only === undefined && vue.minimumMinor === undefined)) return true

  const resolvedVersion = resolveVueVersion(context.vueVersion)
  if (!resolvedVersion && context.assumeLatestVueVersion === false) return false

  const major = resolvedVersion?.major ?? 3
  const minor = resolvedVersion?.minor ?? Number.POSITIVE_INFINITY

  if (vue.only !== undefined && major !== vue.only) return false
  if (vue.minimumMinor !== undefined && (major !== 3 || minor < vue.minimumMinor)) return false
  return true
}

export function validateDoctorRulePacks(value: unknown): asserts value is DoctorRulePack[] {
  if (!Array.isArray(value)) throw new Error('Doctor config "rulePacks" must be an array of rule pack objects.')
  const names = new Set<string>()
  for (const pack of value) {
    if (!pack || typeof pack !== 'object' || typeof pack.name !== 'string'
      || !/^[a-z][a-z0-9-]*$/.test(pack.name) || typeof pack.run !== 'function' || !Array.isArray(pack.rules)) {
      throw new Error('Each Doctor rule pack must have a name, rules array, and run function.')
    }
    if (names.has(pack.name)) throw new Error(`Duplicate Doctor rule pack: ${pack.name}`)
    names.add(pack.name)
    if (pack.sourceExtensions !== undefined && (!Array.isArray(pack.sourceExtensions)
      || pack.sourceExtensions.some((extension: unknown) => typeof extension !== 'string'
        || !/^\.[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(extension)))) {
      throw new Error(`Rule pack ${pack.name} must use dot-prefixed source extensions such as ".css".`)
    }
    if (pack.sourceAnalysisProfiles !== undefined && (!Array.isArray(pack.sourceAnalysisProfiles)
      || pack.sourceAnalysisProfiles.some((profile: unknown) => !isRecord(profile)
        || (profile.includeNativeElements !== undefined && typeof profile.includeNativeElements !== 'boolean')
        || (profile.resolveConstants !== undefined && typeof profile.resolveConstants !== 'boolean')))) {
      throw new Error(`Rule pack ${pack.name} contains invalid source analysis profiles.`)
    }
    const codes = new Set<string>()
    for (const rule of pack.rules) {
      if (!rule || typeof rule.code !== 'string' || !rule.code.startsWith(`${pack.name}/`)
        || rule.code.length === pack.name.length + 1 || typeof rule.title !== 'string'
        || typeof rule.description !== 'string') {
        throw new Error(`Rule definitions in ${pack.name} must use the "${pack.name}/" namespace and include a title and description.`)
      }
      if (codes.has(rule.code)) throw new Error(`Duplicate Doctor rule code: ${rule.code}`)
      codes.add(rule.code)
      validateDoctorRuleMetadata(rule, pack.name)
    }
  }
}

function validateDoctorRuleMetadata(rule: DoctorRuleDefinition, packName: string): void {
  if (rule.category !== undefined && typeof rule.category !== 'string') {
    throw new Error(`Rule definitions in ${packName} must use a string category.`)
  }
  if (rule.verification !== undefined && !['static', 'manual', 'runtime', 'policy-pending'].includes(rule.verification)) {
    throw new Error(`Rule definitions in ${packName} contain invalid verification metadata.`)
  }
  if (rule.standards !== undefined && (!Array.isArray(rule.standards)
    || rule.standards.some(standard => typeof standard !== 'string' || !standard.trim()))) {
    throw new Error(`Rule definitions in ${packName} must use non-empty strings for standards.`)
  }
  if (rule.domain !== undefined && !isDoctorDiagnosticDomain(rule.domain)) {
    throw new Error(`Rule definitions in ${packName} contain an invalid diagnostic domain.`)
  }
  if (rule.tags !== undefined && (!Array.isArray(rule.tags) || rule.tags.some((tag) => typeof tag !== 'string' || !tag.trim()))) {
    throw new Error(`Rule definitions in ${packName} must use non-empty strings for tags.`)
  }
  if (rule.defaultEnabled !== undefined && typeof rule.defaultEnabled !== 'boolean') {
    throw new Error(`Rule definitions in ${packName} must use a boolean defaultEnabled value.`)
  }
  if (rule.defaultSeverity !== undefined && !['info', 'warning', 'error'].includes(rule.defaultSeverity)) {
    throw new Error(`Rule definitions in ${packName} must use an info|warning|error defaultSeverity value.`)
  }
  if (rule.help !== undefined) {
    if (!isRecord(rule.help)
      || typeof rule.help.problem !== 'string'
      || typeof rule.help.remediation !== 'string') {
      throw new Error(`Rule definitions in ${packName} must use help with problem and remediation strings.`)
    }
  }
  if (rule.requires !== undefined) {
    if (!isRecord(rule.requires)
      || !isOptionalStringArray(rule.requires.sourceBlocks, ['template', 'script', 'script-setup'])
      || !isOptionalStringArray(rule.requires.allSourceBlocks, ['template', 'script', 'script-setup'])
      || !isOptionalValue(rule.requires.vueVersion, ['known'])
      || !isOptionalValue(rule.requires.ownership, ['matched', 'unambiguous'])
      || !isOptionalStringArray(rule.requires.contractDimensions, ['props', 'events', 'models', 'slots'])
      || !isOptionalValue(rule.requires.acceptance, ['closed', 'open-or-unknown', 'known'])
      || !isOptionalValue(rule.requires.signature, ['exact'])) {
      throw new Error(`Rule definitions in ${packName} contain invalid requires metadata.`)
    }
  }
  if (rule.applicability !== undefined) {
    if (!isRecord(rule.applicability)) {
      throw new Error(`Rule definitions in ${packName} must use an applicability object.`)
    }
    const vue = rule.applicability.vue
    if (vue !== undefined) {
      if (!isRecord(vue)) {
        throw new Error(`Rule definitions in ${packName} contain invalid Vue applicability metadata.`)
      }
      const minimumMinor = vue.minimumMinor
      if (!isOptionalValue(vue.only, [2, 3])
        || (minimumMinor !== undefined
          && (typeof minimumMinor !== 'number' || !Number.isInteger(minimumMinor) || minimumMinor < 0))
        || (vue.only === 2 && minimumMinor !== undefined)) {
        throw new Error(`Rule definitions in ${packName} contain invalid Vue applicability metadata.`)
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalValue<T>(value: unknown, allowed: readonly T[]): value is T | undefined {
  return value === undefined || allowed.includes(value as T)
}

function isOptionalStringArray<T extends string>(value: unknown, allowed: readonly T[]): value is T[] | undefined {
  return value === undefined
    || (Array.isArray(value) && value.every((item) => allowed.includes(item as T)))
}

import type {
  DoctorRuleCheck,
  DoctorRuleDefinition,
  DoctorRulePack,
  DoctorRulePackContext,
  DoctorRulePackReport,
  DoctorRulePackResult,
  RuleSeveritySetting
} from '@vue-doctor/core'
import {
  isDoctorRuleApplicable,
  isDoctorRuleEnabled,
  resolveVueVersion
} from '@vue-doctor/core'
import { isAbsolute, relative, resolve, sep } from 'node:path'

type RuleSelection =
  | { status: 'runnable'; incompleteReason?: string }
  | { status: 'disabled' }
  | { status: 'not-applicable' }
  | { status: 'unavailable'; reason: string }

const UNKNOWN_VUE_VERSION_REASON = 'Vue version evidence is unavailable; rule applicability could not be determined.'
const PARTIAL_VUE_VERSION_REASON = 'Vue version evidence is unavailable for some target files; per-file applicability could not be fully determined.'

export interface RulePackVersionContext {
  vueVersion?: string
  /** Own properties with `undefined` preserve explicit missing evidence for a target. */
  vueVersions?: Readonly<Record<string, string | undefined>>
  files?: readonly string[]
}

interface InternalRulePackVersionContext extends RulePackVersionContext {
  root?: string
  packageVersions?: ReadonlyArray<{ root: string; vueVersion?: string }>
}

export function selectRulePackSourceExtensions(
  packs: readonly DoctorRulePack[],
  rules: Readonly<Record<string, RuleSeveritySetting>>,
  version: string | undefined | RulePackVersionContext
): string[] {
  const versionContext = normalizeVersionContext(version)
  const extensions = new Set<string>()
  for (const pack of packs) {
    if (!pack.rules.some((rule) => selectRule(rule, rules, versionContext).status === 'runnable')) continue
    for (const extension of pack.sourceExtensions ?? []) extensions.add(extension)
  }
  return [...extensions]
}

export async function runRulePacks(
  packs: readonly DoctorRulePack[],
  context: DoctorRulePackContext
): Promise<DoctorRulePackResult & { reports: DoctorRulePackReport[] }> {
  const diagnostics: DoctorRulePackResult['diagnostics'] = []
  const skippedChecks: DoctorRulePackResult['skippedChecks'] = []
  const reports: DoctorRulePackReport[] = []
  const versionContext = createRulePackVersionContext(context)
  for (const pack of packs) {
    const selections = new Map(pack.rules.map((rule) => [
      rule.code,
      selectRule(rule, context.rules, versionContext)
    ]))
    const selection = (rule: DoctorRuleDefinition) => selections.get(rule.code)!
    const definitions = pack.rules.filter((rule) => selection(rule).status === 'runnable')
    if (definitions.length === 0) {
      const checks = pack.rules.map((rule) => {
        const selected = selection(rule)
        if (selected.status === 'runnable') throw new Error(`Rule pack ${pack.name} selection changed during execution.`)
        return inactiveCheck(rule, selected)
      })
      reports.push({
        name: pack.name,
        rules: pack.rules,
        coverageStatus: checks.some((check) => check.status === 'unavailable') ? 'partial' : 'complete',
        checks
      })
      continue
    }
    const declared = new Set(pack.rules.map((rule) => rule.code))
    const definitionsByCode = new Map(pack.rules.map((rule) => [rule.code, rule]))
    const effectiveRules = { ...context.rules }
    for (const rule of pack.rules) {
      if (selection(rule).status !== 'runnable') effectiveRules[rule.code] = 'off'
    }
    const result = await pack.run(structuredClone({ ...context, rules: effectiveRules }))
    for (const diagnostic of result.diagnostics) {
      if (!declared.has(diagnostic.code)) throw new Error(`Rule pack ${pack.name} returned undeclared rule ${diagnostic.code}.`)
      const definition = definitionsByCode.get(diagnostic.code)!
      const selected = diagnostic.file
        ? selectRule(definition, context.rules, versionContextForFile(versionContext, diagnostic.file))
        : selection(definition)
      if (selected.status === 'runnable') diagnostics.push(diagnostic)
    }
    let incomplete = false
    const acceptedSkips = result.skippedChecks.filter((skipped) => {
      if (!declared.has(skipped.ruleCode)) throw new Error(`Rule pack ${pack.name} skipped undeclared rule ${skipped.ruleCode}.`)
      const definition = definitionsByCode.get(skipped.ruleCode)!
      const selected = skipped.file
        ? selectRule(definition, context.rules, versionContextForFile(versionContext, skipped.file))
        : selection(definition)
      return selected.status === 'runnable'
    })
    for (const skipped of acceptedSkips) {
      skippedChecks.push(skipped)
      incomplete ||= skipped.required
    }
    let checks: DoctorRuleCheck[] | undefined
    const hasSelectionMetadata = pack.rules.some((rule) => (
      rule.defaultEnabled === false || hasVueVersionConstraint(rule)
    ))
    if (result.checks || pack.rules.some((rule) => rule.verification) || hasSelectionMetadata) {
      const byCode = new Map<string, DoctorRuleCheck>()
      for (const check of result.checks ?? []) {
        if (!declared.has(check.ruleCode)) throw new Error(`Rule pack ${pack.name} checked undeclared rule ${check.ruleCode}.`)
        if (byCode.has(check.ruleCode)) throw new Error(`Rule pack ${pack.name} repeated check status for ${check.ruleCode}.`)
        byCode.set(check.ruleCode, check)
      }
      const requiredSkips = new Map(acceptedSkips.filter((skip) => skip.required).map((skip) => [skip.ruleCode, skip]))
      checks = pack.rules.map((rule): DoctorRuleCheck => {
        const selected = selection(rule)
        if (selected.status !== 'runnable') {
          incomplete ||= selected.status === 'unavailable'
          return inactiveCheck(rule, selected)
        }
        const skipped = requiredSkips.get(rule.code)
        const recorded = byCode.get(rule.code)
        let check: DoctorRuleCheck = skipped
          ? { ruleCode: rule.code, status: 'unavailable', reason: skipped.evidence[0]?.message ?? skipped.reason }
          : recorded ?? {
              ruleCode: rule.code,
              status: rule.verification && rule.verification !== 'static' ? rule.verification : 'unavailable',
              reason: rule.verification && rule.verification !== 'static' ? rule.description : 'No per-rule execution evidence was reported.'
            }
        if (selected.incompleteReason) {
          incomplete = true
          if (check.status === 'checked' || check.status === 'partial') {
            check = { ...check, status: 'partial', reason: check.reason ?? selected.incompleteReason }
          }
        }
        incomplete ||= !['checked', 'not-applicable', 'disabled'].includes(check.status)
        return check
      })
    }
    reports.push({
      name: pack.name,
      rules: pack.rules,
      coverageStatus: incomplete ? 'partial' : 'complete',
      ...(checks ? { checks } : {})
    })
  }
  return { diagnostics, skippedChecks, reports }
}

function selectRule(
  rule: DoctorRuleDefinition,
  rules: Readonly<Record<string, RuleSeveritySetting>>,
  versionContext: InternalRulePackVersionContext
): RuleSelection {
  if (!isDoctorRuleEnabled(rule, rules)) return { status: 'disabled' }
  if (!hasVueVersionConstraint(rule)) return { status: 'runnable' }

  const versions = relevantVueVersions(versionContext)
  const resolvedVersions = versions.filter((version): version is string => Boolean(resolveVueVersion(version)))
  const hasUnknown = resolvedVersions.length !== versions.length
  if (hasVueApplicabilityConstraint(rule)) {
    const applicable = resolvedVersions.some((vueVersion) => (
      isDoctorRuleApplicable(rule, { vueVersion, assumeLatestVueVersion: false })
    ))
    if (applicable) {
      return hasUnknown
        ? { status: 'runnable', incompleteReason: PARTIAL_VUE_VERSION_REASON }
        : { status: 'runnable' }
    }
    if (resolvedVersions.length > 0 && !hasUnknown) return { status: 'not-applicable' }
  } else if (resolvedVersions.length > 0) {
    return hasUnknown
      ? { status: 'runnable', incompleteReason: PARTIAL_VUE_VERSION_REASON }
      : { status: 'runnable' }
  }

  if (hasUnknown || versions.length === 0) {
    return { status: 'unavailable', reason: UNKNOWN_VUE_VERSION_REASON }
  }
  return { status: 'not-applicable' }
}

function hasVueApplicabilityConstraint(rule: DoctorRuleDefinition): boolean {
  const vue = rule.applicability?.vue
  return vue?.only !== undefined || vue?.minimumMinor !== undefined
}

function hasVueVersionConstraint(rule: DoctorRuleDefinition): boolean {
  return hasVueApplicabilityConstraint(rule) || rule.requires?.vueVersion === 'known'
}

function normalizeVersionContext(
  version: string | undefined | RulePackVersionContext
): InternalRulePackVersionContext {
  return typeof version === 'object' && version !== null
    ? version
    : { vueVersion: version }
}

function createRulePackVersionContext(context: DoctorRulePackContext): InternalRulePackVersionContext {
  const vueVersion = context.inventory.vue?.installedVersion ?? context.inventory.vue?.declaredVersion
  const targetFiles = context.targetFiles?.files ?? context.source.files
  const files = targetFiles.length > 0 ? targetFiles : undefined
  const vueVersions: Record<string, string | undefined> = {}
  for (const file of targetFiles) vueVersions[file] = vueVersion
  const packageVersions = context.projectContext?.packages.map((packageContext) => {
    const packageVueVersion = packageContext.inventory.vue?.installedVersion
      ?? packageContext.inventory.vue?.declaredVersion
    for (const file of packageContext.targetFiles) vueVersions[file] = packageVueVersion
    return { root: packageContext.root, vueVersion: packageVueVersion }
  })
  return { root: context.inventory.root, vueVersion, vueVersions, files, packageVersions }
}

function relevantVueVersions(context: InternalRulePackVersionContext): Array<string | undefined> {
  if (!context.files) return [context.vueVersion]
  return context.files.map((file) => versionForFile(context, file))
}

function versionContextForFile(
  context: InternalRulePackVersionContext,
  file: string
): InternalRulePackVersionContext {
  return { ...context, files: [file] }
}

function versionForFile(context: InternalRulePackVersionContext, file: string): string | undefined {
  if (context.root) file = resolve(context.root, file)
  if (context.vueVersions && Object.prototype.hasOwnProperty.call(context.vueVersions, file)) {
    return context.vueVersions[file]
  }
  const owner = context.packageVersions
    ?.filter((candidate) => isPathInside(candidate.root, file))
    .sort((left, right) => right.root.length - left.root.length)[0]
  return owner ? owner.vueVersion : context.vueVersion
}

function isPathInside(root: string, file: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(file)) return false
  const path = relative(root, file)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function inactiveCheck(rule: DoctorRuleDefinition, selection: Exclude<RuleSelection, { status: 'runnable' }>): DoctorRuleCheck {
  return {
    ruleCode: rule.code,
    status: selection.status,
    ...(selection.status === 'unavailable' ? { reason: selection.reason } : {})
  }
}

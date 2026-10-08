import {
  classifyComponentPropSupport,
  hasUnresolvedRequiredPropSpread,
  isComponentEventListener,
  type ComponentUsageContractMatch
} from '@vue-doctor/rule-pack-component-library'
import { componentLibraryRuleDefinitions } from '@vue-doctor/rule-pack-component-library/rules'
import { vueRuleDefinitions } from '@vue-doctor/rule-pack-vue/rules'
import type { SourceBlockKind, VueSourceFileResult, VueSourceUsageReport } from '@vue-doctor/source'
import {
  isDoctorRuleApplicable,
  isDoctorRuleEnabled,
  resolveVueVersion,
  type DoctorRuleCheck,
  type DoctorRuleDefinition,
  type RuleSeveritySetting,
  type SkippedCheck
} from '@vue-doctor/core'

export interface CreateBuiltinDoctorChecksOptions {
  source: VueSourceUsageReport
  matches: readonly ComponentUsageContractMatch[]
  rules: Readonly<Record<string, RuleSeveritySetting>>
  /** Root-project fallback when a file has no explicit package-scoped version entry. */
  vueVersion?: string
  /** Own entries, including `undefined`, override the root-project fallback. */
  vueVersions?: Readonly<Record<string, string | undefined>>
  componentSkippedChecks?: readonly SkippedCheck[]
}

export interface BuiltinDoctorChecksResult {
  checks: DoctorRuleCheck[]
  /** Enabled built-in skips, including source/version skips synthesized by this helper. */
  skippedChecks: SkippedCheck[]
}

interface CheckTarget {
  file: string
  line?: number
  checked: boolean
  skip?: SkippedCheck
}

const UNKNOWN_VUE_VERSION_REASON = 'Vue version evidence is unavailable for an applicable source target.'

export function createBuiltinDoctorChecks(
  options: CreateBuiltinDoctorChecksOptions
): BuiltinDoctorChecksResult {
  const skippedChecks: SkippedCheck[] = []
  const checks: DoctorRuleCheck[] = []

  for (const rule of vueRuleDefinitions) {
    const result = createVueRuleCheck(rule, options)
    checks.push(result.check)
    skippedChecks.push(...result.skippedChecks)
  }

  const enabledComponentSkips = (options.componentSkippedChecks ?? []).filter((skip) => {
    const definition = componentLibraryRuleDefinitions.find((rule) => rule.code === skip.ruleCode)
    return Boolean(definition && isDoctorRuleEnabled(definition, options.rules))
  })
  const componentTargets = createComponentTargets(options, enabledComponentSkips)
  for (const rule of componentLibraryRuleDefinitions) {
    if (!isDoctorRuleEnabled(rule, options.rules)) {
      checks.push({ ruleCode: rule.code, rulePack: 'component-library', status: 'disabled' })
      continue
    }

    const targets = componentTargets.get(rule.code) ?? []
    checks.push(aggregateTargets(rule.code, 'component-library', targets))
  }

  skippedChecks.push(...enabledComponentSkips)
  for (const [ruleCode, targets] of componentTargets) {
    const definition = componentLibraryRuleDefinitions.find((rule) => rule.code === ruleCode)
    if (!definition || !isDoctorRuleEnabled(definition, options.rules)) continue
    for (const target of targets) {
      if (target.skip && !enabledComponentSkips.includes(target.skip)) skippedChecks.push(target.skip)
    }
  }

  return {
    checks,
    skippedChecks: dedupeSkippedChecks(skippedChecks)
  }
}

function createVueRuleCheck(
  rule: DoctorRuleDefinition,
  options: CreateBuiltinDoctorChecksOptions
): { check: DoctorRuleCheck; skippedChecks: SkippedCheck[] } {
  if (!isDoctorRuleEnabled(rule, options.rules)) {
    return {
      check: { ruleCode: rule.code, rulePack: 'vue', status: 'disabled' },
      skippedChecks: []
    }
  }

  const targets = options.source.fileResults.flatMap<CheckTarget>((result) => {
    const capability = sourceCapabilityTarget(rule, result)
    if (!capability) return []

    const version = resolveTargetVueVersion(result.file, options)
    const requiresVersion = hasVueApplicabilityConstraint(rule) || rule.requires?.vueVersion === 'known'
    const resolvedVersion = resolveVueVersion(version)
    if (resolvedVersion && hasVueApplicabilityConstraint(rule) && !isDoctorRuleApplicable(rule, {
      vueVersion: version,
      assumeLatestVueVersion: false
    })) {
      return []
    }
    if (requiresVersion && !isSupportedVueVersion(resolvedVersion)) {
      return [{
        file: result.file,
        checked: false,
        skip: createVueCapabilitySkip(
          rule.code,
          result.file,
          capability.failures,
          resolvedVersion ? 'unsupported' : 'missing'
        )
      } satisfies CheckTarget]
    }

    if (capability.failures.length > 0) {
      return [{
        file: result.file,
        checked: capability.available,
        skip: createVueCapabilitySkip(rule.code, result.file, capability.failures)
      } satisfies CheckTarget]
    }

    return [{ file: result.file, checked: capability.available } satisfies CheckTarget]
  })

  return {
    check: aggregateTargets(rule.code, 'vue', targets),
    skippedChecks: targets.flatMap((target) => target.skip ? [target.skip] : [])
  }
}

function sourceCapabilityTarget(
  rule: DoctorRuleDefinition,
  result: VueSourceFileResult
): { available: boolean; failures: Array<{ kind: SourceBlockKind; message?: string }> } | undefined {
  const primary = rule.requires?.sourceBlocks ?? []
  const additional = rule.requires?.allSourceBlocks ?? []
  if (primary.length === 0) return undefined

  const byKind = new Map(result.blocks.map((block) => [block.kind, block]))
  const primaryBlocks = primary
    .map((kind) => byKind.get(kind))
    .filter((block): block is NonNullable<typeof block> => block !== undefined && block.status !== 'absent')
  if (primaryBlocks.length === 0) return undefined

  const additionalBlocks = additional.map((kind) => byKind.get(kind))
  // A genuinely absent companion block means the rule has no target in this file. A failed
  // companion block is a target with unavailable evidence and must remain auditable.
  if (additionalBlocks.some((block) => !block || block.status === 'absent')) return undefined

  const relevant = [...primaryBlocks, ...additionalBlocks]
  const failures = relevant.flatMap((block) => block?.status === 'failed'
    ? [{ kind: block.kind, ...(block.message ? { message: block.message } : {}) }]
    : [])
  return {
    available: primaryBlocks.some((block) => block?.status === 'available')
      && additionalBlocks.every((block) => block?.status === 'available'),
    failures
  }
}

function resolveTargetVueVersion(
  file: string,
  options: CreateBuiltinDoctorChecksOptions
): string | undefined {
  return options.vueVersions && Object.prototype.hasOwnProperty.call(options.vueVersions, file)
    ? options.vueVersions[file]
    : options.vueVersion
}

function hasVueApplicabilityConstraint(rule: DoctorRuleDefinition): boolean {
  const vue = rule.applicability?.vue
  return vue?.only !== undefined || vue?.minimumMinor !== undefined
}

function isSupportedVueVersion(
  version: ReturnType<typeof resolveVueVersion>
): boolean {
  return Boolean(version && (version.major === 3 || (version.major === 2 && version.minor >= 7)))
}

function createVueCapabilitySkip(
  ruleCode: string,
  file: string,
  failures: Array<{ kind: SourceBlockKind; message?: string }>,
  versionIssue?: 'missing' | 'unsupported'
): SkippedCheck {
  const parseFailures = failures.map((failure) => ({
    kind: 'source-coverage',
    file,
    message: `${failure.kind} block: ${failure.message ?? 'parse failed'}`
  }))
  return {
    ruleCode,
    required: true,
    reason: parseFailures.length > 0
      ? 'parse-failed'
      : versionIssue === 'unsupported'
        ? 'unsupported-framework'
        : 'missing-capability',
    file,
    evidence: [
      ...parseFailures,
      ...(versionIssue ? [{
        kind: 'source-coverage',
        file,
        message: versionIssue === 'unsupported'
          ? 'The resolved Vue version is outside Vue Doctor\'s supported Vue 2.7 / Vue 3 runtime range.'
          : UNKNOWN_VUE_VERSION_REASON
      }] : [])
    ]
  }
}

function createComponentTargets(
  options: CreateBuiltinDoctorChecksOptions,
  skippedChecks: readonly SkippedCheck[]
): Map<string, CheckTarget[]> {
  const targets: Map<string, CheckTarget[]> = new Map(
    componentLibraryRuleDefinitions.map((rule) => [rule.code, []])
  )

  const add = (ruleCode: string, target: Omit<CheckTarget, 'checked'>): void => {
    const skip = target.skip ?? findComponentSkip(skippedChecks, ruleCode, target.file, target.line)
    targets.get(ruleCode)!.push({ ...target, checked: !skip, ...(skip ? { skip } : {}) })
  }

  for (const match of options.matches) {
    const { usage, contract } = match
    const version = options.vueVersions && Object.prototype.hasOwnProperty.call(options.vueVersions, usage.file)
      ? options.vueVersions[usage.file]
      : options.vueVersion
    const vueMajor = resolveVueVersion(version)?.major
    for (const model of usage.models) {
      add('component-model-unsupported', { file: usage.file, line: model.loc.line })
    }
    for (const prop of usage.props) {
      if (isDirectiveCompanionAttribute(match, prop.name)) continue
      const propSupport = classifyComponentPropSupport(contract, prop.name, match.contracts)
      const unsupportedPropSkip = propSupport === 'unknown'
        ? createComponentCapabilitySkip(match, 'component-prop-unsupported', prop.loc.line, 'props')
        : undefined
      add('component-prop-unsupported', {
        file: usage.file,
        line: prop.loc.line,
        ...(unsupportedPropSkip ? { skip: unsupportedPropSkip } : {})
      })
      add('component-attribute-unverified', { file: usage.file, line: prop.loc.line })
      if (hasNamedEntry(contract.props.entries, prop.name)) {
        const skip = contract.props.knowledge === 'known'
          ? undefined
          : createComponentCapabilitySkip(match, 'component-prop-type-mismatch', prop.loc.line, 'props')
        add('component-prop-type-mismatch', { file: usage.file, line: prop.loc.line, ...(skip ? { skip } : {}) })
      }
    }

    for (const spread of usage.propSpreads ?? []) {
      if (contract.props.acceptance === 'open' || contract.fallthrough.attributes === 'open') continue
      const unsupportedSpreadSkip = createComponentCapabilitySkip(
        match,
        'component-prop-unsupported',
        spread.loc.line,
        'props',
        'A dynamic v-bind object may contain prop names that static source evidence cannot enumerate.'
      )
      add('component-prop-unsupported', {
        file: usage.file,
        line: spread.loc.line,
        skip: unsupportedSpreadSkip
      })
      if (!hasClosedAttributeBoundary(match)) {
        add('component-attribute-unverified', {
          file: usage.file,
          line: spread.loc.line,
          skip: createComponentCapabilitySkip(
            match,
            'component-attribute-unverified',
            spread.loc.line,
            'props',
            'A dynamic v-bind object may contain attribute names that static source evidence cannot enumerate.'
          )
        })
      }
    }

    const unresolvedRequiredSpread = hasUnresolvedRequiredPropSpread(match, vueMajor)
    const requiredPropSkip = contract.props.knowledge !== 'known' || unresolvedRequiredSpread
      ? createComponentCapabilitySkip(
          match,
          'component-prop-required-missing',
          unresolvedRequiredSpread ? usage.propSpreads[0]!.loc.line : usage.loc.line,
          'props',
          unresolvedRequiredSpread
            ? 'A dynamic v-bind object prevents static proof that every required prop is present.'
            : undefined
        )
      : undefined
    add('component-prop-required-missing', {
      file: usage.file,
      line: usage.loc.line,
      ...(requiredPropSkip ? { skip: requiredPropSkip } : {})
    })

    for (const slot of usage.slots) {
      add('component-slot-unsupported', { file: usage.file, line: slot.loc.line })
    }
    for (const event of usage.events) {
      if (!isComponentEventListener(event, vueMajor)) continue
      add('component-event-unsupported', { file: usage.file, line: event.loc.line })
      if (hasNamedEntry(contract.events.entries, event.name)) {
        add('component-event-payload-changed', { file: usage.file, line: event.loc.line })
      }
    }
  }

  return targets
}

function isDirectiveCompanionAttribute(match: ComponentUsageContractMatch, propName: string): boolean {
  return propName.startsWith('element-loading-')
    && match.usage.directives.some((directive) => directive.name === 'loading')
}

function hasNamedEntry(entries: ReadonlyMap<string, unknown>, name: string): boolean {
  const normalized = normalizeContractName(name)
  return [...entries.keys()].some((entry) => normalizeContractName(entry) === normalized)
}

function normalizeContractName(name: string): string {
  return name.replace(/[-_:]/g, '').toLowerCase()
}

function hasClosedAttributeBoundary(match: ComponentUsageContractMatch): boolean {
  return match.contract.props.knowledge === 'known'
    && match.contract.props.acceptance === 'closed'
    && match.contract.props.issues.length === 0
    && match.contract.fallthrough.attributes === 'closed'
}

function findComponentSkip(
  skippedChecks: readonly SkippedCheck[],
  ruleCode: string,
  file: string,
  line: number | undefined
): SkippedCheck | undefined {
  return skippedChecks.find((skip) => (
    skip.ruleCode === ruleCode
    && skip.file === file
    && (line === undefined || skip.evidence.some((evidence) => evidence.file === file && evidence.line === line))
  ))
}

function createComponentCapabilitySkip(
  match: ComponentUsageContractMatch,
  ruleCode: string,
  line: number,
  dimension: 'props' | 'events' | 'models' | 'slots',
  sourceMessage?: string
): SkippedCheck {
  const contractDimension = dimension === 'models' ? match.contract.events : match.contract[dimension]
  const reason = contractDimension.knowledge === 'partial' || contractDimension.issues.length > 0
    ? 'partial-contract'
    : 'missing-capability'
  return {
    ruleCode,
    required: true,
    reason,
    file: match.usage.file,
    package: match.library.package,
    evidence: [
      {
        kind: 'source-component-usage',
        file: match.usage.file,
        line,
        message: sourceMessage ?? `Template uses <${match.usage.tag}>.`
      },
      {
        kind: 'component-contract',
        file: match.contract.sources[0]?.path ?? match.library.package.packageJsonPath,
        message: `Installed component contract ${dimension} evidence is incomplete for this check.`
      }
    ]
  }
}

function aggregateTargets(
  ruleCode: string,
  rulePack: 'vue' | 'component-library',
  targets: readonly CheckTarget[]
): DoctorRuleCheck {
  if (targets.length === 0) {
    return {
      ruleCode,
      rulePack,
      status: 'not-applicable',
      reason: 'No applicable source target was found.'
    }
  }

  const checkedFiles = new Set(targets.filter((target) => target.checked).map((target) => target.file))
  const blockedFiles = new Set(targets.filter((target) => target.skip).map((target) => target.file))
  if (checkedFiles.size > 0 && blockedFiles.size > 0) {
    return {
      ruleCode,
      rulePack,
      status: 'partial',
      files: checkedFiles.size,
      reason: `${checkedFiles.size} file(s) checked; ${blockedFiles.size} applicable file(s) lacked required evidence.`
    }
  }
  if (checkedFiles.size > 0) {
    return { ruleCode, rulePack, status: 'checked', files: checkedFiles.size }
  }

  return {
    ruleCode,
    rulePack,
    status: 'unavailable',
    reason: targets.find((target) => target.skip)?.skip?.evidence[0]?.message
      ?? 'Required evidence was unavailable.'
  }
}

function dedupeSkippedChecks(skippedChecks: readonly SkippedCheck[]): SkippedCheck[] {
  const seen = new Set<string>()
  return skippedChecks.filter((skip) => {
    const evidence = skip.evidence.map((item) => (
      `${item.kind}:${item.file ?? ''}:${item.line ?? ''}:${item.column ?? ''}:${item.message}`
    )).join('|')
    const key = `${skip.ruleCode}:${skip.reason}:${skip.file ?? ''}:${evidence}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

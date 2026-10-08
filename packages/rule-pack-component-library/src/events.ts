import type {
  AttributeForwardTarget,
  ComponentContract,
  ComponentContractMap,
  ComponentLibraryEvidence,
  ContractDimension,
  EventContract,
  EventSignature,
  PropContract,
  PropTypeDescriptor
} from '@vue-doctor/component-library'
import { resolveVueVersion } from '@vue-doctor/core'
import type { StaticValue, VueEventUsage, VueModelUsage, VuePropUsage, VueSlotUsage } from '@vue-doctor/source'
import type {
  ComponentLibraryUsageDiagnostic,
  ComponentLibraryUsageResult,
  ComponentUsageContractMatch,
  DiagnoseComponentLibraryUsageOptions
} from './types.js'
import { getComponentLibraryRuleDefaultSeverity } from './rules.js'

export function diagnoseComponentLibraryUsage(
  options: DiagnoseComponentLibraryUsageOptions
): ComponentLibraryUsageDiagnostic[] {
  return diagnoseComponentLibraryUsageResult(options).diagnostics
}

export function diagnoseComponentLibraryUsageResult(
  options: DiagnoseComponentLibraryUsageOptions
): ComponentLibraryUsageResult {
  const diagnostics: ComponentLibraryUsageDiagnostic[] = []
  const skippedChecks: ComponentLibraryUsageResult['skippedChecks'] = []

  for (const match of options.matches) {
    const { contract, usage } = match
    const version = options.vueVersions && Object.prototype.hasOwnProperty.call(options.vueVersions, usage.file)
      ? options.vueVersions[usage.file]
      : options.vueVersion
    const vueMajor = resolveVueVersion(version)?.major

    for (const model of usage.models) {
      const names = getModelContractNames(model, contract, vueMajor)
      const support = names ? classifyComponentEventSupport(contract, names.eventName) : 'unknown'
      if (support === 'unsupported' && names) {
        diagnostics.push(createUnsupportedModelDiagnostic(match, model, names))
      } else if (support === 'unknown') {
        skippedChecks.push(createContractSkip(
          match,
          'component-model-unsupported',
          model.loc.line,
          'source-model-binding',
          `Installed contract evidence does not prove whether ${formatModelName(model)} is supported.`,
          names ? getDimensionGapReason(contract.events) : 'missing-capability'
        ))
      }
    }

    for (const prop of usage.props) {
      if (isDirectiveCompanionAttribute(usage, prop.name)) {
        continue
      }
      const support = classifyComponentPropSupport(contract, prop.name, match.contracts)
      if (support === 'unsupported') {
        diagnostics.push(createUnsupportedPropDiagnostic(match, prop))
        continue
      }
      if (support === 'unknown') {
        diagnostics.push(createUnverifiedAttributeDiagnostic(match, prop))
        continue
      }
      if (support === 'declared' && contract.props.knowledge === 'known') {
        const propContract = getPropContract(contract.props.entries, prop.name)
        if (propContract && hasIncompatiblePropType(prop, propContract)) {
          diagnostics.push(createInvalidPropTypeDiagnostic(match, prop, propContract))
        }
      }
    }

    if (contract.props.knowledge === 'known') {
      let skippedRequiredModel = false
      for (const propContract of contract.props.entries.values()) {
        if (!isMissingRequiredProp(propContract, usage, contract, vueMajor)) {
          continue
        }
        if (usage.models.some(model => !getModelContractNames(model, contract, vueMajor))) {
          if (!skippedRequiredModel) {
            skippedChecks.push(createContractSkip(
              match,
              'component-prop-required-missing',
              usage.loc.line,
              'source-model-binding',
              'The consuming Vue version or installed model prop mapping is unresolved.',
              'missing-capability'
            ))
            skippedRequiredModel = true
          }
          continue
        }
        if (usage.propSpreads.length > 0) continue
        diagnostics.push(createMissingRequiredPropDiagnostic(match, propContract))
      }
    }

    for (const slot of usage.slots) {
      const support = classifyComponentSlotSupport(contract, slot.name)
      if (support === 'unsupported') {
        diagnostics.push(createUnsupportedSlotDiagnostic(match, slot))
      } else if (support === 'unknown') {
        skippedChecks.push(createContractSkip(
          match,
          'component-slot-unsupported',
          slot.loc.line,
          'source-slot-template',
          `Installed contract evidence does not prove whether slot "${slot.name}" is supported.`,
          getDimensionGapReason(contract.slots)
        ))
      }
    }

    for (const event of usage.events) {
      if (!isComponentEventListener(event, vueMajor)) continue
      const support = classifyComponentEventSupport(contract, event.name)
      if (support === 'unsupported') {
        diagnostics.push(createUnsupportedEventDiagnostic(match, event.name))
        continue
      }
      if (support === 'unknown') {
        skippedChecks.push(createContractSkip(
          match,
          'component-event-unsupported',
          event.loc.line,
          'source-event-listener',
          `Installed contract evidence does not prove whether event "${event.name}" is supported.`,
          getDimensionGapReason(contract.events)
        ))
        continue
      }
      if (support !== 'declared') continue

      const eventContract = getEventContract(contract.events.entries, event.name)
      if (!eventContract) continue
      const payload = classifyEventPayloadCompatibility(event, contract.events, eventContract)
      if (payload === 'incompatible') {
        diagnostics.push(createEventPayloadChangedDiagnostic(match, event, eventContract))
      } else if (payload === 'unknown') {
        skippedChecks.push(createContractSkip(
          match,
          'component-event-payload-changed',
          event.loc.line,
          'source-event-listener',
          `The handler or payload signature for event "${event.name}" could not be resolved.`,
          event.handler ? getDimensionGapReason(contract.events) : 'missing-capability'
        ))
      }
    }
  }

  return { diagnostics, skippedChecks }
}

/** Vue 2 `.native` listeners attach to the root DOM node, not to component emits. */
export function isComponentEventListener(event: VueEventUsage, vueMajor: number | undefined): boolean {
  return vueMajor !== 2 || !event.modifiers.includes('native')
}

export function hasUnresolvedRequiredPropSpread(
  match: ComponentUsageContractMatch,
  vueMajor: number | undefined
): boolean {
  const { usage, contract } = match
  return usage.propSpreads.length > 0
    && [...contract.props.entries.values()].some((prop) => isMissingRequiredProp(prop, usage, contract, vueMajor))
}

function isDirectiveCompanionAttribute(
  usage: ComponentUsageContractMatch['usage'],
  propName: string
): boolean {
  return propName.startsWith('element-loading-')
    && usage.directives.some((directive) => directive.name === 'loading')
}

function createUnsupportedModelDiagnostic(
  match: ComponentUsageContractMatch,
  model: VueModelUsage,
  names: ModelContractNames
): ComponentLibraryUsageDiagnostic {
  const { library, usage } = match
  const { packageName, version } = getLibraryIdentity(library)
  const modelName = formatModelName(model)
  const { propName, eventName } = names

  return {
    code: 'component-model-unsupported',
    severity: getComponentLibraryRuleDefaultSeverity('component-model-unsupported'),
    message: `${usage.componentName} from ${packageName}@${version} does not declare ${modelName}.`,
    file: usage.file,
    evidence: [
      {
        kind: 'source-model-binding',
        file: usage.file,
        line: model.loc.line,
        message: `Template uses ${modelName}.`
      },
      {
        kind: 'component-contract',
        file: getContractFile(match),
        message: `The model maps to prop "${propName}" and event "${eventName}"; installed evidence does not support that event.`
      }
    ],
    fixes: [
      {
        title: 'Use v-model or a model argument declared by the installed component version.'
      }
    ],
    confidence: 'high'
  }
}

function classifyComponentEventSupport(
  contract: ComponentContract,
  eventName: string
): ComponentPropSupport {
  if (hasEventContract(contract.events.entries, eventName)) {
    return 'declared'
  }
  if (contract.events.acceptance === 'open' || contract.fallthrough.listeners === 'open') {
    return 'accepted'
  }
  if (
    contract.events.knowledge !== 'known'
    || contract.events.acceptance !== 'closed'
    || contract.fallthrough.listeners !== 'closed'
    || contract.events.issues.length > 0
  ) {
    return 'unknown'
  }
  return 'unsupported'
}

interface ModelContractNames {
  propName: string
  eventName: string
}

function getModelContractNames(
  model: VueModelUsage,
  contract: ComponentContract,
  vueMajor: number | undefined
): ModelContractNames | undefined {
  if (vueMajor === 2) {
    return !model.argument && contract.vue2Model
      ? { propName: contract.vue2Model.prop, eventName: contract.vue2Model.event }
      : undefined
  }
  if (vueMajor !== 3) return undefined
  return model.argument
    ? { propName: model.argument, eventName: `update:${model.argument}` }
    : { propName: 'model-value', eventName: 'update:modelValue' }
}

function formatModelName(model: VueModelUsage): string {
  return model.argument ? `v-model:${model.argument}` : 'v-model'
}

function createUnsupportedPropDiagnostic(
  match: ComponentUsageContractMatch,
  prop: VuePropUsage
): ComponentLibraryUsageDiagnostic {
  const { library, usage } = match
  const { packageName, version } = getLibraryIdentity(library)

  return {
    code: 'component-prop-unsupported',
    severity: getComponentLibraryRuleDefaultSeverity('component-prop-unsupported'),
    message: `${usage.componentName} from ${packageName}@${version} does not declare prop "${prop.name}".`,
    file: usage.file,
    evidence: [
      {
        kind: 'source-prop-binding',
        file: usage.file,
        line: prop.loc.line,
        message: `Template passes prop "${prop.name}".`
      },
      {
        kind: 'component-contract',
        file: getContractFile(match),
        message: 'Installed component metadata does not declare this prop.'
      }
    ],
    fixes: [
      {
        title: `Remove "${prop.name}" or use a prop declared by the installed component version.`
      }
    ],
    confidence: 'high'
  }
}

export type ComponentPropSupport = 'declared' | 'accepted' | 'unsupported' | 'unknown'

export function classifyComponentPropSupport(
  contract: ComponentContract,
  propName: string,
  contracts?: ComponentContractMap,
  visited = new Set<ComponentContract>()
): ComponentPropSupport {
  if (isUniversalProp(propName) || hasPropContract(contract.props.entries, propName)) {
    return 'declared'
  }
  if (contract.props.acceptance === 'open') {
    return 'accepted'
  }

  if (visited.has(contract)) {
    return 'unknown'
  }
  const nextVisited = new Set(visited).add(contract)
  const targets = contract.fallthrough.attributeTargets ?? []
  if (targets.length > 0) {
    return combineForwardTargetSupport(targets.map((target) => (
      classifyForwardTargetSupport(target, propName, contracts, nextVisited)
    )))
  }

  if (contract.fallthrough.attributes === 'open') {
    return 'accepted'
  }
  if (contract.props.knowledge !== 'known') {
    return 'unknown'
  }
  if (contract.props.acceptance === 'closed' && contract.fallthrough.attributes === 'closed') {
    return 'unsupported'
  }

  return 'unknown'
}

function classifyForwardTargetSupport(
  target: AttributeForwardTarget,
  propName: string,
  contracts: ComponentContractMap | undefined,
  visited: Set<ComponentContract>
): ComponentPropSupport {
  const normalized = normalizePropName(propName)
  if (target.excludedAttributes?.some((name) => normalizePropName(name) === normalized)) {
    return 'unsupported'
  }
  if (target.kind === 'element') {
    if (!target.supportedAttributes) {
      return 'unknown'
    }
    return target.supportedAttributes.some((name) => normalizePropName(name) === normalized)
      ? 'accepted'
      : 'unsupported'
  }

  const child = contracts?.components.get(target.name)
  return child
    ? classifyComponentPropSupport(child, propName, contracts, visited)
    : 'unknown'
}

function combineForwardTargetSupport(
  results: ComponentPropSupport[]
): ComponentPropSupport {
  if (results.some((result) => result === 'declared' || result === 'accepted')) {
    return 'accepted'
  }
  if (results.some((result) => result === 'unknown')) {
    return 'unknown'
  }
  return 'unsupported'
}

function createUnverifiedAttributeDiagnostic(
  match: ComponentUsageContractMatch,
  prop: VuePropUsage
): ComponentLibraryUsageDiagnostic {
  const { library, usage } = match
  const { packageName, version } = getLibraryIdentity(library)
  const runtimeFile = match.contract.fallthrough.attributeTargets?.[0]?.file

  return {
    code: 'component-attribute-unverified',
    severity: getComponentLibraryRuleDefaultSeverity('component-attribute-unverified'),
    message: `${usage.componentName} from ${packageName}@${version} does not declare attribute "${prop.name}", and its runtime forwarding target could not be fully verified.`,
    file: usage.file,
    evidence: [
      {
        kind: 'source-prop-binding',
        file: usage.file,
        line: prop.loc.line,
        message: `Template passes attribute "${prop.name}".`
      },
      {
        kind: 'component-contract',
        file: runtimeFile ?? getContractFile(match),
        message: runtimeFile
          ? 'Installed runtime forwards this attribute, but the receiving target could not be proven to support it.'
          : 'Installed component evidence does not prove whether this attribute is accepted or rejected.'
      }
    ],
    fixes: [{
      title: `Confirm that the installed component forwards or declares "${prop.name}".`
    }],
    confidence: 'low'
  }
}

function createUnsupportedSlotDiagnostic(
  match: ComponentUsageContractMatch,
  slot: VueSlotUsage
): ComponentLibraryUsageDiagnostic {
  const { library, usage } = match
  const { packageName, version } = getLibraryIdentity(library)

  return {
    code: 'component-slot-unsupported',
    severity: getComponentLibraryRuleDefaultSeverity('component-slot-unsupported'),
    message: `${usage.componentName} from ${packageName}@${version} does not declare slot "${slot.name}".`,
    file: usage.file,
    evidence: [
      {
        kind: 'source-slot-template',
        file: usage.file,
        line: slot.loc.line,
        message: `Template provides slot "${slot.name}".`
      },
      {
        kind: 'component-contract',
        file: getContractFile(match),
        message: 'Installed component metadata does not declare this slot.'
      }
    ],
    fixes: [
      {
        title: `Remove slot "${slot.name}" or use a slot declared by the installed component version.`
      }
    ],
    confidence: 'high'
  }
}

function classifyComponentSlotSupport(
  contract: ComponentContract,
  slotName: string
): ComponentPropSupport {
  if (hasSlotContract(contract.slots.entries, slotName)) return 'declared'
  if (contract.slots.acceptance === 'open') return 'accepted'
  return contract.slots.knowledge === 'known'
    && contract.slots.acceptance === 'closed'
    && contract.slots.issues.length === 0
    ? 'unsupported'
    : 'unknown'
}

function createContractSkip(
  match: ComponentUsageContractMatch,
  ruleCode: string,
  line: number,
  sourceKind: string,
  message: string,
  reason: ComponentLibraryUsageResult['skippedChecks'][number]['reason']
): ComponentLibraryUsageResult['skippedChecks'][number] {
  return {
    ruleCode,
    required: true,
    reason,
    file: match.usage.file,
    package: match.library.package,
    evidence: [
      { kind: sourceKind, file: match.usage.file, line, message },
      {
        kind: 'component-contract',
        file: getContractFile(match),
        message: 'Installed component contract evidence is incomplete for this check.'
      }
    ]
  }
}

function getDimensionGapReason(
  dimension: Pick<ContractDimension<unknown>, 'knowledge' | 'issues'>
): 'missing-capability' | 'partial-contract' {
  return dimension.knowledge === 'partial' || dimension.issues.length > 0
    ? 'partial-contract'
    : 'missing-capability'
}

function hasPropContract(props: Map<string, PropContract>, name: string): boolean {
  return Boolean(getPropContract(props, name))
}

function getPropContract(
  props: Map<string, PropContract>,
  name: string
): PropContract | undefined {
  const exact = props.get(name)
  if (exact) {
    return exact
  }

  const normalized = normalizePropName(name)
  return [...props.entries()].find(([contractName]) => (
    normalizePropName(contractName) === normalized
  ))?.[1]
}

function isMissingRequiredProp(
  propContract: PropContract,
  usage: ComponentUsageContractMatch['usage'],
  contract: ComponentContract,
  vueMajor: number | undefined
): boolean {
  if (propContract.required !== true) {
    return false
  }
  if (isListenerPropName(propContract.name) || isUniversalProp(propContract.name)) {
    return false
  }
  const provided = collectProvidedPropNames(usage, contract, vueMajor)
  return !provided.has(normalizePropName(propContract.name))
}

function collectProvidedPropNames(
  usage: ComponentUsageContractMatch['usage'],
  contract: ComponentContract,
  vueMajor: number | undefined
): Set<string> {
  const names = new Set<string>()
  for (const prop of usage.props) {
    names.add(normalizePropName(prop.name))
  }
  for (const model of usage.models) {
    const mapping = getModelContractNames(model, contract, vueMajor)
    if (!mapping) continue
    const { propName } = mapping
    names.add(normalizePropName(propName))
    names.add(normalizePropName(toCamelCase(propName)))
    names.add(normalizePropName(toKebabCase(propName)))
  }
  return names
}

function isListenerPropName(name: string): boolean {
  return /^on[A-Z]/.test(name)
}

function hasIncompatiblePropType(prop: VuePropUsage, propContract: PropContract): boolean {
  // Lowercase on* attributes are native listener fallthrough, not Vue listener props.
  if (prop.kind === 'static' && /^on[a-z]/.test(prop.name)) {
    return false
  }
  if (!propContract.types || propContract.types.length === 0) {
    return false
  }
  if (propContract.types.some((type) => type.kind === 'any' || type.kind === 'unknown')) {
    return false
  }

  const observed = observePropValue(prop)
  if (!observed) {
    return false
  }

  return !propContract.types.some((type) => typeAcceptsValue(type, observed))
}

function observePropValue(
  prop: VuePropUsage
): ObservedPropValue | undefined {
  if (prop.kind === 'boolean') {
    return { kind: 'boolean', value: true, binding: 'static' }
  }

  if (prop.kind === 'dynamic') {
    // Source facts intentionally retain partial shapes for rules that can use
    // individual fields. Type compatibility needs the complete runtime value.
    if (prop.staticEvidence?.complete === false || prop.staticValue === undefined) {
      return undefined
    }
    return observeStaticValue(prop.staticValue, 'dynamic')
  }

  if (prop.kind !== 'static' || prop.value === undefined) {
    return undefined
  }

  const raw = prop.value
  if (raw === 'true' || raw === 'false') {
    return { kind: 'boolean', value: raw === 'true', binding: 'static' }
  }

  if (raw.trim() !== '' && Number.isFinite(Number(raw))) {
    // Prefer numeric observation only when the whole value is numeric.
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) {
      return { kind: 'number', value: Number(raw), binding: 'static' }
    }
  }

  return { kind: 'string', value: raw, binding: 'static' }
}

type ObservedPropValue = {
  kind: 'string' | 'boolean' | 'number' | 'object' | 'array' | 'null'
  value: StaticValue
  binding: 'static' | 'dynamic'
}

function observeStaticValue(
  value: StaticValue,
  binding: ObservedPropValue['binding']
): ObservedPropValue {
  if (value === null) return { kind: 'null', value, binding }
  if (Array.isArray(value)) return { kind: 'array', value, binding }
  if (typeof value === 'object') return { kind: 'object', value, binding }
  if (typeof value === 'string') return { kind: 'string', value, binding }
  if (typeof value === 'number') return { kind: 'number', value, binding }
  return { kind: 'boolean', value, binding }
}

function typeAcceptsValue(
  type: PropTypeDescriptor,
  observed: ObservedPropValue
): boolean {
  if (type.kind === 'literal') {
    if (type.value === undefined) {
      return false
    }
    if (observed.binding === 'static' && observed.kind === 'string') {
      return String(type.value) === observed.value
    }
    return type.value === observed.value
  }

  if (type.kind === 'string') {
    return observed.kind === 'string'
      || (observed.binding === 'static' && (observed.kind === 'number' || observed.kind === 'boolean'))
  }

  if (type.kind === 'number') {
    return observed.kind === 'number'
  }

  if (type.kind === 'boolean') {
    return observed.kind === 'boolean' || (observed.kind === 'string' && observed.value === '')
  }

  if (type.kind === 'object') {
    return observed.kind === 'object'
  }

  if (type.kind === 'array') {
    return observed.kind === 'array'
  }

  if (type.kind === 'null') {
    return observed.kind === 'null'
  }

  // Static source facts cannot represent function, symbol or bigint values.
  return false
}

function createMissingRequiredPropDiagnostic(
  match: ComponentUsageContractMatch,
  propContract: PropContract
): ComponentLibraryUsageDiagnostic {
  const { library, usage } = match
  const { packageName, version } = getLibraryIdentity(library)

  return {
    code: 'component-prop-required-missing',
    severity: getComponentLibraryRuleDefaultSeverity('component-prop-required-missing'),
    message: `${usage.componentName} from ${packageName}@${version} requires prop "${propContract.name}".`,
    file: usage.file,
    evidence: [
      {
        kind: 'source-component-usage',
        file: usage.file,
        line: usage.loc.line,
        message: `Template uses <${usage.tag}> without prop "${propContract.name}".`
      },
      {
        kind: 'component-contract',
        file: getContractFile(match),
        message: 'Installed component metadata marks this prop as required.'
      }
    ],
    fixes: [
      {
        title: `Pass required prop "${propContract.name}" to <${usage.tag}>.`
      }
    ],
    confidence: 'high'
  }
}

function createInvalidPropTypeDiagnostic(
  match: ComponentUsageContractMatch,
  prop: VuePropUsage,
  propContract: PropContract
): ComponentLibraryUsageDiagnostic {
  const { library, usage } = match
  const { packageName, version } = getLibraryIdentity(library)
  const expected = formatPropTypes(propContract.types ?? [])
  const observed = formatObservedProp(prop)

  return {
    code: 'component-prop-type-mismatch',
    severity: getComponentLibraryRuleDefaultSeverity('component-prop-type-mismatch'),
    message: `${usage.componentName} from ${packageName}@${version} prop "${prop.name}" expects ${expected}, got ${observed}.`,
    file: usage.file,
    evidence: [
      {
        kind: 'source-prop-binding',
        file: usage.file,
        line: prop.loc.line,
        message: `Template passes ${observed} to prop "${prop.name}".`
      },
      {
        kind: 'component-contract',
        file: getContractFile(match),
        message: `Installed component metadata declares prop "${propContract.name}" as ${expected}.`
      }
    ],
    fixes: [
      {
        title: `Update "${prop.name}" to a value accepted by the installed component contract (${expected}).`
      }
    ],
    confidence: 'medium'
  }
}

function formatPropTypes(types: PropTypeDescriptor[]): string {
  if (types.length === 0) {
    return 'an unknown type'
  }
  return types.map((type) => {
    if (type.kind === 'literal') {
      return typeof type.value === 'string' ? `"${type.value}"` : String(type.value)
    }
    return type.kind
  }).join(' | ')
}

function formatObservedProp(prop: VuePropUsage): string {
  if (prop.kind === 'boolean') {
    return 'boolean true'
  }
  if (prop.kind === 'static') {
    return prop.value === undefined ? 'a static value' : `static "${prop.value}"`
  }
  if (prop.staticValue !== undefined && prop.staticEvidence?.complete !== false) {
    const observed = observeStaticValue(prop.staticValue, 'dynamic')
    return `dynamic ${observed.kind} ${formatStaticValue(observed.value)}`
  }
  return 'a dynamic value'
}

function formatStaticValue(value: StaticValue): string {
  if (typeof value === 'string') return `"${value}"`
  return JSON.stringify(value)
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase())
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
}

function hasEventContract(
  events: Map<string, EventContract>,
  name: string
): boolean {
  return Boolean(getEventContract(events, name))
}

function getEventContract(
  events: Map<string, EventContract>,
  name: string
): EventContract | undefined {
  const exact = events.get(name)
  if (exact) {
    return exact
  }

  const normalized = normalizeEventName(name)
  return [...events.entries()].find(([contractName]) => (
    normalizeEventName(contractName) === normalized
  ))?.[1]
}

function hasSlotContract(slots: Map<string, { name: string }>, name: string): boolean {
  if (slots.has(name)) {
    return true
  }

  const normalized = normalizeSlotName(name)
  return [...slots.keys()].some((contractName) => normalizeSlotName(contractName) === normalized)
}

function isUniversalProp(name: string): boolean {
  return universalProps.has(name) || name.startsWith('data-') || name.startsWith('aria-')
}

function normalizePropName(name: string): string {
  return name.replace(/[-_:]/g, '').toLowerCase()
}

function normalizeEventName(name: string): string {
  return name.replace(/[-_:]/g, '').toLowerCase()
}

function normalizeSlotName(name: string): string {
  return name.replace(/[-_:]/g, '').toLowerCase()
}

const universalProps = new Set([
  'class',
  'id',
  'is',
  'key',
  'ref',
  'role',
  'slot',
  'style'
])

function createUnsupportedEventDiagnostic(
  match: ComponentUsageContractMatch,
  eventName: string
): ComponentLibraryUsageDiagnostic {
  const { library, usage } = match
  const { packageName, version } = getLibraryIdentity(library)

  return {
    code: 'component-event-unsupported',
    severity: getComponentLibraryRuleDefaultSeverity('component-event-unsupported'),
    message: `${usage.componentName} from ${packageName}@${version} does not declare event "${eventName}".`,
    file: usage.file,
    evidence: [
      {
        kind: 'source-event-listener',
        file: usage.file,
        line: usage.events.find((event) => event.name === eventName)?.loc.line,
        message: `Template listens to "${eventName}".`
      },
      {
        kind: 'component-contract',
        file: getContractFile(match),
        message: 'Installed component metadata does not declare this event.'
      }
    ],
    fixes: [],
    confidence: 'high'
  }
}

function createEventPayloadChangedDiagnostic(
  match: ComponentUsageContractMatch,
  event: VueEventUsage,
  eventContract: EventContract
): ComponentLibraryUsageDiagnostic {
  const { library, usage } = match
  const { packageName, version } = getLibraryIdentity(library)
  const signatures = formatEventSignatures(eventContract.signatures)
  const handlerRequired = getHandlerMinimumArity(event)

  return {
    code: 'component-event-payload-changed',
    severity: getComponentLibraryRuleDefaultSeverity('component-event-payload-changed'),
    message: `${usage.componentName} from ${packageName}@${version} declares event "${event.name}" with payload signatures ${signatures}, but the handler requires at least ${handlerRequired} parameters.`,
    file: usage.file,
    evidence: [
      {
        kind: 'source-event-listener',
        file: usage.file,
        line: event.loc.line,
        message: `Template listens to "${event.name}" with ${handlerRequired} required handler parameter${handlerRequired === 1 ? '' : 's'}.`
      },
      {
        kind: 'component-contract',
        file: getContractFile(match),
        message: `Installed component evidence declares payload signatures: ${signatures}.`
      }
    ],
    fixes: [
      {
        title: `Reduce the handler's required parameters to match one of ${signatures}.`
      }
    ],
    confidence: 'high'
  }
}

function classifyEventPayloadCompatibility(
  event: VueEventUsage,
  events: ContractDimension<EventContract>,
  eventContract: EventContract
): 'compatible' | 'incompatible' | 'unknown' {
  if (!event.handler) return 'unknown'
  if (
    event.handler.payloadUsage === 'ignored'
    && event.modifiers.every((modifier) => ['once', 'capture', 'passive'].includes(modifier))
  ) return 'compatible'
  const handlerRequired = getHandlerMinimumArity(event)
  if (handlerRequired === 0 || event.handler.maxArity === null) return 'unknown'
  if (
    events.knowledge !== 'known'
    || events.issues.length > 0
    || eventContract.signatures.length === 0
  ) return 'unknown'
  return eventContract.signatures.every((signature) => (
    signature.maxArity !== null && signature.maxArity < handlerRequired
  ))
    ? 'incompatible'
    : 'compatible'
}

function getLibraryIdentity(library: ComponentLibraryEvidence): {
  packageName: string
  version: string
} {
  const packageInfo = library.package as ComponentLibraryEvidence['package'] & { name?: string }
  return {
    packageName: library.package.canonicalName ?? packageInfo.name ?? library.package.dependencyName ?? 'unknown',
    version: library.package.installedVersion ?? library.package.declaredVersion ?? 'unknown'
  }
}

function getContractFile(match: ComponentUsageContractMatch): string | undefined {
  return match.contract.sources[0]?.path
}

function getHandlerMinimumArity(event: VueEventUsage): number {
  return event.handler?.minArity ?? event.handler?.parameters.length ?? 0
}

function formatEventSignatures(signatures: EventSignature[]): string {
  return signatures.map(formatEventSignature).join(' | ')
}

function formatEventSignature(signature: EventSignature): string {
  return `(${signature.parameters.map((parameter, index) => {
    const name = parameter.name ?? `arg${index + 1}`
    return `${parameter.rest ? '...' : ''}${name}${parameter.optional ? '?' : ''}`
  }).join(', ')})`
}

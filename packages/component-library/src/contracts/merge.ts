import { isDeepStrictEqual } from 'node:util'
import type { ComponentLibraryEvidence } from '../types.js'
import {
  createContractCacheKey,
  readContractCache,
  writeContractCache
} from './cache.js'
import { readTypeScriptContractsWithCacheInputs } from './declarations.js'
import { readMetadataContracts } from './metadata.js'
import { readRuntimeFallthrough, type RuntimeFallthroughResult } from './runtime.js'
import type {
  ComponentContract,
  ComponentContractMap,
  ContractDimension,
  ContractAcceptance,
  DeclarationCacheInputs,
  EventContract,
  DeclarationContractReadResult,
  ContractIssue,
  ContractProvenance,
  PropContract
} from './types.js'

const priority = {
  adapter: 4,
  'web-types': 3,
  'vetur-tags': 2,
  'vetur-attributes': 2,
  typescript: 1,
  runtime: 0
} as const

const sourceOrder: Record<ContractProvenance['source'], number> = {
  adapter: 0,
  'web-types': 1,
  'vetur-tags': 2,
  'vetur-attributes': 3,
  typescript: 4,
  runtime: 5
}

const maxContractExtractions = 32
const contractExtractions = new Map<string, Promise<ContractExtraction>>()

interface ContractExtraction {
  contracts: ComponentContractMap
  cacheInputs: DeclarationCacheInputs
}

interface ContractReaders {
  readMetadata: (evidence: ComponentLibraryEvidence) => Promise<ComponentContractMap[]>
  readDeclarations: (evidence: ComponentLibraryEvidence) => Promise<ComponentContractMap | DeclarationContractReadResult>
  readRuntime?: (evidence: ComponentLibraryEvidence) => Promise<RuntimeFallthroughResult>
}

export async function extractComponentLibraryContracts(
  evidence: ComponentLibraryEvidence
): Promise<ComponentContractMap> {
  const cacheKey = await createContractCacheKey(evidence)
  if (!cacheKey) return (await extractUncachedContracts(evidence)).contracts

  const existing = contractExtractions.get(cacheKey)
  if (existing) return cloneContractMap((await existing).contracts)

  const extraction = (async () => {
    const cached = await readContractCache(cacheKey, evidence.cacheDirectory)
    if (cached) {
      return { contracts: cached, cacheInputs: emptyDeclarationCacheInputs() }
    }
    const result = await extractUncachedContracts(evidence)
    await writeContractCache(cacheKey, result.contracts, result.cacheInputs, evidence.cacheDirectory)
    return result
  })()
  const tracked = contractExtractions.size < maxContractExtractions
  if (tracked) contractExtractions.set(cacheKey, extraction)
  try {
    return cloneContractMap((await extraction).contracts)
  } finally {
    if (tracked && contractExtractions.get(cacheKey) === extraction) {
      contractExtractions.delete(cacheKey)
    }
  }
}

async function extractUncachedContracts(
  evidence: ComponentLibraryEvidence
): Promise<ContractExtraction> {
  return extractComponentLibraryContractsWithReadersInternal(evidence, {
    readMetadata: readMetadataContracts,
    readDeclarations: readTypeScriptContractsWithCacheInputs,
    ...(evidence.runtime === false ? {} : { readRuntime: readRuntimeFallthrough })
  })
}

export async function extractComponentLibraryContractsWithReaders(
  evidence: ComponentLibraryEvidence,
  readers: ContractReaders
): Promise<ComponentContractMap> {
  return (await extractComponentLibraryContractsWithReadersInternal(evidence, readers)).contracts
}

async function extractComponentLibraryContractsWithReadersInternal(
  evidence: ComponentLibraryEvidence,
  readers: ContractReaders
): Promise<ContractExtraction> {
  const [metadata, declarations, runtime] = await Promise.allSettled([
    readers.readMetadata(evidence),
    readers.readDeclarations(evidence),
    readers.readRuntime?.(evidence) ?? Promise.resolve({
      components: new Map(),
      slots: new Map(),
      dynamicSlots: new Set<string>(),
      props: new Map(),
      events: new Map(),
      vue2Models: new Map(),
      componentSources: new Map(),
      sources: [],
      problems: []
    })
  ])
  const maps = metadata.status === 'fulfilled'
    ? [...metadata.value]
    : [failedExtraction('Metadata contract extraction failed', metadata.reason)]

  const declarationResult = declarations.status === 'fulfilled'
    ? normalizeDeclarationResult(declarations.value)
    : {
        contracts: failedDeclarationExtraction(evidence, declarations.reason),
        cacheInputs: { ...emptyDeclarationCacheInputs(), reliable: false }
      }
  maps.push(declarationResult.contracts)

  const merged = mergeComponentContractMaps(maps)
  if (runtime.status === 'rejected') {
    merged.problems.push({
      message: `Runtime fallthrough extraction failed: ${getErrorMessage(runtime.reason)}`
    })
    return { contracts: merged, cacheInputs: declarationResult.cacheInputs }
  }
  merged.problems.push(...runtime.value.problems)
  return {
    contracts: applyRuntimeFallthrough(merged, runtime.value),
    cacheInputs: declarationResult.cacheInputs
  }
}

function normalizeDeclarationResult(
  result: ComponentContractMap | DeclarationContractReadResult
): DeclarationContractReadResult {
  return 'contracts' in result
    ? result
    : { contracts: result, cacheInputs: emptyDeclarationCacheInputs() }
}

function emptyDeclarationCacheInputs(): DeclarationCacheInputs {
  return {
    reliable: true,
    files: [],
    fileProbes: [],
    directoryProbes: [],
    resolutions: []
  }
}

function cloneContractMap(contracts: ComponentContractMap): ComponentContractMap {
  return structuredClone(contracts)
}

export function getContractExtractionCacheStateForTests(): { size: number; limit: number } {
  return { size: contractExtractions.size, limit: maxContractExtractions }
}

export function mergeComponentContractMaps(
  maps: ComponentContractMap[]
): ComponentContractMap {
  const componentEntries = maps.flatMap((map) => [...map.components.entries()])
  const components = new Map<string, ComponentContract>()
  const remaining = new Set(componentEntries.map((_, index) => index))

  while (remaining.size > 0) {
    const rootIndex = [...remaining].sort((first, second) => (
      compareComponentEntries(componentEntries[first]!, componentEntries[second]!)
    ))[0]!
    const group = collectAliasGroup(rootIndex, componentEntries)
    group.indices.forEach((index) => remaining.delete(index))

    const contracts = [...new Set(group.indices.map((index) => componentEntries[index]![1]))]
      .sort(compareContracts)
    const canonicalName = componentEntries[rootIndex]![1].name
    const contract = mergeContracts(canonicalName, contracts, group.names)

    for (const name of group.names) {
      components.set(name, contract)
    }
  }

  return {
    components,
    sources: mergeProvenance(maps.flatMap((map) => map.sources)),
    problems: maps.flatMap((map) => map.problems)
  }
}

function collectAliasGroup(
  rootIndex: number,
  entries: Array<[string, ComponentContract]>
): { indices: number[]; names: string[] } {
  const names = new Set(getEntryNames(entries[rootIndex]!))
  const selected = new Set([rootIndex])
  let changed = true

  while (changed) {
    changed = false

    for (const [index, [key, contract]] of entries.entries()) {
      if (selected.has(index)) {
        continue
      }

      const contractNames = [key, contract.name, ...contract.aliases]
      if (!contractNames.some((contractName) => names.has(contractName))) {
        continue
      }

      selected.add(index)
      contractNames.forEach((contractName) => names.add(contractName))
      changed = true
    }
  }

  return {
    indices: [...selected],
    names: [...names].sort(compareText)
  }
}

function mergeContracts(
  name: string,
  contracts: ComponentContract[],
  names: string[]
): ComponentContract {
  return {
    name,
    aliases: names.filter((alias) => alias !== name),
    props: mergeDimensions(contracts.map((contract) => contract.props)),
    events: mergeDimensions(contracts.map((contract) => contract.events)),
    slots: mergeDimensions(contracts.map((contract) => contract.slots)),
    ...mergeModelMappings(contracts.map(contract => contract.vue2Model)),
    fallthrough: {
      attributes: mergeAcceptance(contracts.map((contract) => contract.fallthrough.attributes)),
      listeners: mergeAcceptance(contracts.map((contract) => contract.fallthrough.listeners)),
      attributeTargets: mergeAttributeTargets(contracts.flatMap((contract) => (
        contract.fallthrough.attributeTargets ?? []
      )))
    },
    sources: mergeProvenance(contracts.flatMap((contract) => contract.sources))
  }
}

function applyRuntimeFallthrough(
  contracts: ComponentContractMap,
  runtime: RuntimeFallthroughResult
): ComponentContractMap {
  const names = new Set([
    ...runtime.components.keys(),
    ...runtime.props.keys(),
    ...runtime.events.keys(),
    ...runtime.vue2Models.keys(),
    ...runtime.slots.keys(),
    ...runtime.dynamicSlots
  ])
  const publicNames = new Set(runtime.publicComponents?.flatMap(component => [component.name, ...component.aliases]))
  for (const name of names) {
    if (publicNames.has(name)) continue
    const existing = contracts.components.get(name)
    if (!existing) continue
    const augmented = augmentRuntimeContract(existing, {
      fallthrough: runtime.components.get(name),
      props: runtime.props.get(name) ?? new Map(),
      events: runtime.events.get(name),
      slots: runtime.slots.get(name) ?? new Map(),
      dynamicSlots: runtime.dynamicSlots.has(name),
      ...(runtime.vue2Models.has(name) ? { vue2Model: runtime.vue2Models.get(name) } : {}),
      sources: runtime.componentSources.get(name) ?? []
    })
    for (const [alias, contract] of contracts.components) {
      if (contract === existing) {
        contracts.components.set(alias, augmented)
      }
    }
  }
  contracts.sources = mergeProvenance([...contracts.sources, ...runtime.sources])
  for (const component of runtime.publicComponents ?? []) {
    const names = [component.name, ...component.aliases]
    const matched = [...new Set(names.flatMap(name => {
      const existing = contracts.components.get(name)
      return existing ? [existing] : []
    }))]
    const aliases = [...new Set([...names, ...matched.flatMap(contract => [contract.name, ...contract.aliases])])]
    const existing = matched.length ? mergeContracts(matched[0]!.name, matched, aliases) : component
    const augmented = augmentRuntimeContract(existing, {
      fallthrough: component.fallthrough,
      props: component.props.entries,
      events: component.events.entries,
      slots: component.slots.entries,
      dynamicSlots: runtime.publicDynamicSlots?.has(component.name) ?? false,
      vue2Model: component.vue2Model,
      sources: component.sources
    })
    for (const alias of aliases) contracts.components.set(alias, augmented)
  }
  return contracts
}

interface RuntimeComponentAugmentation {
  fallthrough?: ComponentContract['fallthrough']
  props: Map<string, PropContract>
  events?: Map<string, EventContract>
  slots: Map<string, { name: string }>
  dynamicSlots: boolean
  vue2Model?: ComponentContract['vue2Model']
  sources: ContractProvenance[]
}

function augmentRuntimeContract(existing: ComponentContract, runtime: RuntimeComponentAugmentation): ComponentContract {
  const targets = mergeAttributeTargets([
    ...(existing.fallthrough.attributeTargets ?? []),
    ...(runtime.fallthrough?.attributeTargets ?? [])
  ])
  const attributes = existing.fallthrough.attributes === 'open'
    ? 'open'
    : targets.length > 0
      ? 'unknown'
      : runtime.fallthrough?.attributes === 'closed' ? 'closed' : existing.fallthrough.attributes
  return {
    ...existing,
    props: {
      ...existing.props,
      knowledge: existing.props.knowledge === 'unknown' && runtime.props.size ? 'partial' : existing.props.knowledge,
      entries: mergeRuntimePropEntries(existing.props.entries, runtime.props)
    },
    events: mergeRuntimeEventEntries(existing.events, runtime.events),
    ...('vue2Model' in runtime ? { vue2Model: runtime.vue2Model } : {}),
    slots: mergeRuntimeSlotEntries(existing.slots, runtime.slots, runtime.dynamicSlots),
    fallthrough: { attributes, listeners: existing.fallthrough.listeners, attributeTargets: targets },
    sources: mergeProvenance([...existing.sources, ...runtime.sources])
  }
}

function mergeModelMappings(models: ComponentContract['vue2Model'][]): Pick<ComponentContract, 'vue2Model'> {
  const available = models.filter(model => model !== undefined)
  if (available.length === 0) return {}
  const first = available[0]
  return { vue2Model: available.every(model => isDeepStrictEqual(model, first)) ? first : null }
}

function mergeRuntimeEventEntries(
  existing: ContractDimension<EventContract>,
  runtime: Map<string, EventContract> | undefined
): ContractDimension<EventContract> {
  if (!runtime?.size) return existing
  const entries = new Map(existing.entries)
  let added = false
  for (const [name, event] of runtime) {
    if (entries.has(name)) continue
    entries.set(name, event)
    added = true
  }
  return added
    ? { ...existing, knowledge: 'partial', acceptance: 'unknown', entries }
    : existing
}


function mergeRuntimePropEntries(
  existing: Map<string, PropContract>,
  runtimeProps: Map<string, PropContract>
): Map<string, PropContract> {
  const merged = new Map(existing)
  for (const [name, runtimeProp] of runtimeProps) {
    const current = merged.get(name)
    merged.set(name, current ? mergePropContracts(current, runtimeProp) : runtimeProp)
  }
  return merged
}

function mergeRuntimeSlotEntries(
  existing: ContractDimension<{ name: string }>,
  runtimeSlots: Map<string, { name: string }>,
  dynamic: boolean
): ContractDimension<{ name: string }> {
  if (runtimeSlots.size === 0 && !dynamic) return existing
  return {
    ...existing,
    knowledge: dynamic
      ? 'partial'
      : existing.knowledge === 'unknown'
        ? 'partial'
        : existing.knowledge,
    acceptance: dynamic ? 'unknown' : existing.acceptance,
    entries: new Map([...existing.entries, ...runtimeSlots])
  }
}

function mergeAttributeTargets(
  targets: NonNullable<ComponentContract['fallthrough']['attributeTargets']>
) {
  const unique = new Map<string, typeof targets[number]>()
  for (const target of targets) {
    unique.set(`${target.kind}:${target.name}:${target.file}:${target.excludedAttributes?.join(',') ?? ''}`, target)
  }
  return [...unique.values()]
}

function getEntryNames([key, contract]: [string, ComponentContract]): string[] {
  return [key, contract.name, ...contract.aliases]
}

function compareComponentEntries(
  first: [string, ComponentContract],
  second: [string, ComponentContract]
): number {
  return compareContracts(first[1], second[1]) || compareText(first[0], second[0])
}

function mergeDimensions<T>(dimensions: ContractDimension<T>[]): ContractDimension<T> {
  const entries = new Map<string, T>()
  const issues: ContractIssue[] = dimensions.flatMap((dimension) => dimension.issues)
  const available = dimensions.filter((dimension) => dimension.knowledge !== 'unknown')
  let partial = available.some((dimension) => dimension.knowledge === 'partial')

  for (const dimension of dimensions) {
    for (const [name, value] of dimension.entries) {
      const existing = entries.get(name)
      if (existing === undefined) {
        entries.set(name, value)
      } else if (isEventContract(existing) && isEventContract(value)) {
        entries.set(name, mergeEventContracts(existing, value) as T)
      } else if (isPropContract(existing) && isPropContract(value)) {
        entries.set(name, mergePropContracts(existing, value) as T)
      } else if (!isDeepStrictEqual(existing, value)) {
        partial = true
        issues.push({
          code: 'entry-conflict',
          message: `Contract entries for ${name} disagree across evidence sources.`
        })
      }
    }
  }

  const acceptance = mergeDimensionAcceptance(dimensions, issues)
  const hasIndependentCompleteSource = acceptance !== 'unknown' && dimensions.some((dimension) => (
    dimension.knowledge === 'known'
    && dimension.acceptance === acceptance
    && dimension.issues.length === 0
  ))
  if (issues.length > 0 && !hasIndependentCompleteSource) {
    partial = true
  }
  const hasExplicitBoundary = dimensions.some((dimension) => dimension.acceptance !== 'unknown')
  const hasUnknownWithClosedBoundary = dimensions.some((dimension) => (
    dimension.knowledge === 'unknown' && dimension.acceptance === 'unknown'
  )) && dimensions.some((dimension) => dimension.acceptance === 'closed')
  const boundaryConflict = issues.some((issue) => issue.code === 'boundary-conflict')
  const knowledge = available.length === 0 || hasUnknownWithClosedBoundary || boundaryConflict
    ? 'unknown'
    : partial
      ? 'partial'
      : 'known'

  if (!hasExplicitBoundary && available.length === 0) {
    return { knowledge: 'unknown', acceptance, entries, issues }
  }
  return { knowledge, acceptance, entries, issues }
}

function isEventContract(value: unknown): value is { name: string; signatures: Array<{ parameters: unknown[]; minArity: number; maxArity: number | null }>; source: string } {
  return Boolean(value && typeof value === 'object' && 'name' in value && 'signatures' in value && Array.isArray(value.signatures))
}

function mergeEventContracts(
  first: { name: string; signatures: Array<{ parameters: unknown[]; minArity: number; maxArity: number | null }>; source: string },
  second: { name: string; signatures: Array<{ parameters: unknown[]; minArity: number; maxArity: number | null }>; source: string }
) {
  const signatures = [...first.signatures]
  for (const signature of second.signatures) {
    if (!signatures.some((candidate) => isDeepStrictEqual(candidate, signature))) {
      signatures.push(signature)
    }
  }
  return { ...first, signatures }
}

function isPropContract(value: unknown): value is PropContract {
  return Boolean(value && typeof value === 'object' && 'name' in value && !('signatures' in value))
}

function mergePropContracts(first: PropContract, second: PropContract): PropContract {
  const types = mergePropTypes(first.types, second.types)
  const required = first.required === true || second.required === true
    ? true
    : first.required === false || second.required === false
      ? false
      : first.required ?? second.required

  const merged: PropContract = { name: first.name || second.name }
  if (required !== undefined) {
    merged.required = required
  }
  if (types) {
    merged.types = types
  }
  return merged
}

function mergePropTypes(
  first: PropContract['types'],
  second: PropContract['types']
): PropContract['types'] | undefined {
  if (!first?.length && !second?.length) {
    return undefined
  }
  const merged = [...(first ?? [])]
  for (const type of second ?? []) {
    if (!merged.some((candidate) => isDeepStrictEqual(candidate, type))) {
      merged.push(type)
    }
  }
  return merged
}

function mergeDimensionAcceptance<T>(
  dimensions: ContractDimension<T>[],
  issues: ContractIssue[]
): ContractAcceptance {
  return mergeAcceptance(dimensions.map((dimension) => dimension.acceptance), issues)
}

function mergeAcceptance(
  values: ContractAcceptance[],
  issues: ContractIssue[] = []
): ContractAcceptance {
  const explicit = [...new Set(values.filter((value) => value !== 'unknown'))]
  if (explicit.includes('closed') && explicit.includes('open')) {
    issues.push({
      code: 'boundary-conflict',
      message: 'Contract evidence disagrees about whether arbitrary entries are accepted.'
    })
    return 'unknown'
  }
  if (explicit.includes('closed')) {
    return values.some((value) => value === 'unknown') ? 'unknown' : 'closed'
  }
  if (explicit.includes('open')) {
    return 'open'
  }
  return 'unknown'
}

function compareContracts(first: ComponentContract, second: ComponentContract): number {
  const priorityDifference = getContractPriority(second) - getContractPriority(first)
  if (priorityDifference !== 0) {
    return priorityDifference
  }

  const sourceDifference = getContractSourceOrder(first) - getContractSourceOrder(second)
  return sourceDifference || compareText(getContractSortKey(first), getContractSortKey(second))
}

function getContractPriority(contract: ComponentContract): number {
  return Math.max(0, ...contract.sources.map((source) => priority[source.source]))
}

function getContractSourceOrder(contract: ComponentContract): number {
  return Math.min(Number.MAX_SAFE_INTEGER, ...contract.sources.map((source) => sourceOrder[source.source]))
}

function getContractSortKey(contract: ComponentContract): string {
  return contract.sources
    .map((source) => `${source.source}:${source.path}`)
    .sort()
    .join('|')
}

function mergeProvenance(sources: ContractProvenance[]): ContractProvenance[] {
  const unique = new Map<string, ContractProvenance>()
  for (const source of sources) {
    unique.set(`${source.source}\0${source.path}`, source)
  }

  return [...unique.values()].sort((first, second) => {
    const priorityDifference = priority[second.source] - priority[first.source]
    const sourceDifference = sourceOrder[first.source] - sourceOrder[second.source]
    return priorityDifference || sourceDifference || compareText(first.path, second.path)
  })
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0
}

function failedExtraction(message: string, reason: unknown): ComponentContractMap {
  return {
    components: new Map(),
    sources: [],
    problems: [{
      message: `${message}: ${reason instanceof Error ? reason.message : String(reason)}`
    }]
  }
}

function failedDeclarationExtraction(
  evidence: ComponentLibraryEvidence,
  reason: unknown
): ComponentContractMap {
  const message = `TypeScript declaration extraction failed: ${getErrorMessage(reason)}`
  const entries = evidence.artifacts.declarationEntries

  return {
    components: new Map(),
    sources: entries.map((entry) => ({
      source: 'typescript',
      path: entry.path,
      relativePath: entry.relativePath
    })),
    problems: entries.length > 0
      ? entries.map((entry) => ({ message, path: entry.path }))
      : [{ message }]
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import { readFile } from 'node:fs/promises'
import type { ComponentLibraryEvidence, EvidenceFile } from '../types.js'
import type {
  PropContract,
  PropTypeDescriptor,
  ComponentContract,
  ComponentContractMap,
  ContractDimension,
  ContractIssue,
  ContractProvenance,
  EventContract,
  EventParameter,
  EventSignature
} from './types.js'

type WebTypesContributionNode = {
  name?: string
  events?: WebTypesEventNode[]
  attributes?: WebTypesAttributeNode[]
  props?: WebTypesAttributeNode[]
  slots?: WebTypesSlotNode[]
  'vue-slots'?: WebTypesSlotNode[]
  children?: WebTypesContributionNode[]
}

type WebTypesAttributeNode = {
  name?: string
  description?: string
  required?: boolean
  type?: string | string[] | WebTypesValueType
  value?: WebTypesValueType
  values?: Array<string | number | boolean | { name?: string; value?: string | number | boolean }>
  enum?: Array<string | number | boolean>
  default?: unknown
}

type WebTypesValueType = {
  type?: string | string[]
  kind?: string
  items?: WebTypesValueType | string | string[]
}

type WebTypesEventNode = {
  name?: string
  arguments?: WebTypesEventParameterNode[]
  parameters?: WebTypesEventParameterNode[]
  params?: WebTypesEventParameterNode[]
}

type WebTypesEventParameterNode = string | {
  name?: string
  id?: string
}

type WebTypesSlotNode = {
  name?: string
}

type VeturTagNode = {
  attributes?: VeturAttributeNode[]
}

type VeturAttributeNode = string | {
  name?: string
  type?: string
  description?: string
}

type VeturAttributeMeta = {
  type?: string
  description?: string
  options?: Array<string | number | boolean>
}

type MetadataSource = Exclude<ContractProvenance['source'], 'adapter' | 'typescript'>

export async function readMetadataContracts(
  evidence: ComponentLibraryEvidence
): Promise<ComponentContractMap[]> {
  return Promise.all([
    readWebTypesContracts(evidence),
    readVeturTagsContracts(evidence),
    readVeturAttributesContracts(evidence)
  ])
}

export async function readWebTypesContracts(
  evidence: ComponentLibraryEvidence
): Promise<ComponentContractMap> {
  const artifact = evidence.artifacts.webTypes
  return readMetadataSource(artifact, 'web-types', (parsed, provenance) => {
    const components = new Map<string, ComponentContract>()

    for (const node of collectCandidateNodes(parsed)) {
      if (!node.name) {
        continue
      }

      addAliases(components, node.name, (name, aliases) => ({
        name,
        aliases,
        props: getWebTypesProps(node),
        events: getWebTypesEvents(node),
        slots: getWebTypesSlots(node),
        fallthrough: { attributes: 'unknown', listeners: 'unknown' },
        sources: [provenance]
      }))
    }

    return components
  })
}

export async function readVeturTagsContracts(
  evidence: ComponentLibraryEvidence
): Promise<ComponentContractMap> {
  const artifact = evidence.artifacts.veturTags
  return readMetadataSource(artifact, 'vetur-tags', (parsed, provenance) => {
    const components = new Map<string, ComponentContract>()

    for (const [tag, node] of collectVeturTagNodes(parsed)) {
      addAliases(components, tag, (name, aliases) => ({
        name,
        aliases,
        props: getVeturTagProps(node),
        events: getVeturTagEvents(node),
        slots: unknownDimension(),
        fallthrough: { attributes: 'unknown', listeners: 'unknown' },
        sources: [provenance]
      }))
    }

    return components
  })
}

export async function readVeturAttributesContracts(
  evidence: ComponentLibraryEvidence
): Promise<ComponentContractMap> {
  const artifact = evidence.artifacts.veturAttributes
  return readMetadataSource(artifact, 'vetur-attributes', (parsed, provenance) => {
    const components = new Map<string, ComponentContract>()

    for (const [tag, attribute, meta] of collectVeturAttributeEntries(parsed)) {
      for (const componentName of getComponentContractNames(tag)) {
        const aliases = getComponentContractNames(tag).filter((name) => name !== componentName)
        const contract = getOrCreateVeturAttributeContract(
          components,
          componentName,
          aliases,
          provenance
        )

        if (isVeturEventAttribute(attribute)) {
          const eventName = attribute.slice(1)
          contract.events.knowledge = 'known'
          contract.events.entries.set(eventName, {
            name: eventName,
            signatures: [],
            source: 'metadata' as const
          })
          continue
        }

        const propName = normalizeVeturPropName(attribute)
        contract.props.knowledge = 'known'
        const types = [
          ...parseMetadataTypeString(meta?.type),
          ...parseMetadataEnumValues(meta?.options)
        ]
        const prop: PropContract = { name: propName }
        if (types.length > 0) {
          prop.types = uniquePropTypes(types)
        }
        const existing = contract.props.entries.get(propName)
        contract.props.entries.set(propName, existing ? mergeMetadataPropContracts(existing, prop) : prop)
      }
    }

    return components
  })
}

async function readMetadataSource(
  artifact: EvidenceFile | undefined,
  source: MetadataSource,
  collect: (parsed: unknown, provenance: ContractProvenance) => Map<string, ComponentContract>
): Promise<ComponentContractMap> {
  if (!artifact) {
    return emptyContractMap()
  }

  const provenance = toProvenance(artifact, source)

  try {
    const raw = await readFile(artifact.path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return {
      components: collect(parsed, provenance),
      sources: [provenance],
      problems: []
    }
  } catch (error) {
    return {
      components: new Map(),
      sources: [provenance],
      problems: [{
        message: `Could not read ${source} metadata: ${getErrorMessage(error)}`,
        path: artifact.path
      }]
    }
  }
}

function getWebTypesProps(
  node: WebTypesContributionNode
): ContractDimension<PropContract> {
  const attributes = node.attributes !== undefined ? node.attributes : node.props
  if (attributes === undefined) {
    return unknownDimension()
  }

  return knownDimension(new Map(attributes.flatMap((attribute) => {
    if (!attribute.name) {
      return []
    }

    return [[attribute.name, propContractFromWebTypesAttribute(attribute)]]
  })))
}

function propContractFromWebTypesAttribute(attribute: WebTypesAttributeNode): PropContract {
  const name = attribute.name!
  const required = typeof attribute.required === 'boolean'
    ? attribute.required
    : attribute.default !== undefined
      ? false
      : undefined
  const types = [
    ...parseMetadataTypeField(attribute.type),
    ...parseMetadataTypeField(attribute.value),
    ...parseMetadataEnumValues(attribute.values ?? attribute.enum)
  ]
  const unique = uniquePropTypes(types)

  const contract: PropContract = { name }
  if (required !== undefined) {
    contract.required = required
  }
  if (unique.length > 0) {
    contract.types = unique
  }
  return contract
}

function getWebTypesEvents(
  node: WebTypesContributionNode
): ContractDimension<EventContract> {
  if (node.events === undefined) {
    return unknownDimension()
  }

  const issues: ContractIssue[] = []
  const entries = new Map(node.events.flatMap((event) => {
    if (!event.name) {
      issues.push({ code: 'metadata-entry-invalid', message: 'A Web Types event is missing its name.' })
      return []
    }

    return [[event.name, {
      name: event.name,
      signatures: getMetadataSignatures(event),
      source: 'metadata' as const
    }]]
  }))
  return knownDimension(entries, issues)
}

function getWebTypesSlots(
  node: WebTypesContributionNode
): ContractDimension<{ name: string }> {
  const slots = node.slots !== undefined ? node.slots : node['vue-slots']
  const entries = inferredDescriptionSlots(node)
  for (const slot of slots ?? []) {
    if (slot.name) entries.set(slot.name, { name: slot.name })
  }
  if (slots !== undefined) return knownDimension(entries)
  if (entries.size === 0) return unknownDimension()
  return {
    knowledge: 'partial',
    acceptance: 'unknown',
    entries,
    issues: []
  }
}

function inferredDescriptionSlots(
  node: WebTypesContributionNode
): Map<string, { name: string }> {
  const entries = new Map<string, { name: string }>()
  for (const attribute of [...(node.attributes ?? []), ...(node.props ?? [])]) {
    const description = attribute.description
    if (!description) continue
    for (const match of description.matchAll(/\bslot\s*=\s*["'`]([^"'`]+)["'`]/g)) {
      const name = match[1]?.trim()
      if (name) entries.set(name, { name })
    }
  }
  return entries
}

function getVeturTagProps(node: VeturTagNode): ContractDimension<PropContract> {
  if (node.attributes === undefined) {
    return unknownDimension()
  }

  return knownDimension(new Map(node.attributes.flatMap((attribute) => {
    const name = getVeturAttributeName(attribute)
    if (!name || isVeturEventAttribute(name)) {
      return []
    }

    const propName = normalizeVeturPropName(name)
    const type = typeof attribute === 'string' ? undefined : attribute.type
    const types = type ? parseMetadataTypeString(type) : []
    const contract: PropContract = { name: propName }
    if (types.length > 0) {
      contract.types = types
    }
    return [[propName, contract]]
  })))
}

function getVeturTagEvents(
  node: VeturTagNode
): ContractDimension<EventContract> {
  if (node.attributes === undefined) {
    return unknownDimension()
  }

  return knownDimension(new Map(node.attributes.flatMap((attribute) => {
    const name = getVeturAttributeName(attribute)
    if (!name || !isVeturEventAttribute(name)) {
      return []
    }

    const eventName = name.slice(1)
    return [[eventName, {
      name: eventName,
      signatures: [],
      source: 'metadata' as const
    }]]
  })))
}

function getMetadataSignatures(event: WebTypesEventNode): EventSignature[] {
  const parameters = event.arguments ?? event.parameters ?? event.params
  if (!Array.isArray(parameters)) return []
  const payload: EventParameter[] = []
  for (const parameter of parameters) {
    const name = typeof parameter === 'string' ? parameter : parameter?.name ?? parameter?.id
    if (typeof name !== 'string' || name.length === 0) return []
    payload.push({ name, optional: false, rest: false })
  }
  return [{ parameters: payload, minArity: payload.length, maxArity: payload.length }]
}

function collectCandidateNodes(value: unknown): WebTypesContributionNode[] {
  if (!value || typeof value !== 'object') {
    return []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCandidateNodes(item))
  }

  const node = value as WebTypesContributionNode
  const result: WebTypesContributionNode[] = []
  if (node.name && (
    node.events
    || node.attributes
    || node.props
    || node.slots
    || node['vue-slots']
    || node.children
  )) {
    result.push(node)
  }

  for (const child of Object.values(value)) {
    result.push(...collectCandidateNodes(child))
  }

  return result
}

function collectVeturTagNodes(value: unknown): Array<[string, VeturTagNode]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return []
  }

  return Object.entries(value).flatMap(([tag, node]) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return []
    }

    return [[tag, node as VeturTagNode]]
  })
}

function collectVeturAttributeEntries(value: unknown): Array<[string, string, VeturAttributeMeta | undefined]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return []
  }

  return Object.entries(value).flatMap(([key, raw]) => {
    const separator = key.lastIndexOf('/')
    if (separator <= 0 || separator === key.length - 1) {
      return []
    }

    const meta = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as VeturAttributeMeta
      : undefined
    return [[key.slice(0, separator), key.slice(separator + 1), meta]]
  })
}

function getOrCreateVeturAttributeContract(
  components: Map<string, ComponentContract>,
  name: string,
  aliases: string[],
  provenance: ContractProvenance
): ComponentContract {
  const existing = components.get(name)
  if (existing) {
    return existing
  }

  const contract: ComponentContract = {
    name,
    aliases,
    props: unknownDimension(),
    events: unknownDimension(),
    slots: unknownDimension(),
    fallthrough: { attributes: 'unknown', listeners: 'unknown' },
    sources: [provenance]
  }
  components.set(name, contract)
  return contract
}

function addAliases(
  components: Map<string, ComponentContract>,
  tag: string,
  create: (name: string, aliases: string[]) => ComponentContract
): void {
  const names = getComponentContractNames(tag)
  for (const name of names) {
    components.set(name, create(name, names.filter((alias) => alias !== name)))
  }
}


function parseMetadataTypeField(value: unknown): PropTypeDescriptor[] {
  if (value === undefined || value === null) {
    return []
  }
  if (typeof value === 'string') {
    return parseMetadataTypeString(value)
  }
  if (Array.isArray(value)) {
    return uniquePropTypes(value.flatMap((item) => parseMetadataTypeField(item)))
  }
  if (typeof value === 'object') {
    const node = value as WebTypesValueType
    if (node.type !== undefined) {
      return parseMetadataTypeField(node.type)
    }
    if (typeof node.kind === 'string') {
      return parseMetadataTypeString(node.kind)
    }
  }
  return []
}

function parseMetadataEnumValues(
  values: Array<string | number | boolean | { name?: string; value?: string | number | boolean }> | undefined
): PropTypeDescriptor[] {
  if (!values?.length) {
    return []
  }
  const types: PropTypeDescriptor[] = []
  for (const item of values) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      types.push({ kind: 'literal', value: item })
      continue
    }
    if (item && typeof item === 'object') {
      const value = item.value ?? item.name
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        types.push({ kind: 'literal', value })
      }
    }
  }
  return types
}

function parseMetadataTypeString(value: string | undefined): PropTypeDescriptor[] {
  if (!value) {
    return []
  }

  const normalized = value.trim()
  if (!normalized) {
    return []
  }

  // Union types: number | string, 'sm' | 'md'
  if (normalized.includes('|')) {
    return uniquePropTypes(normalized.split('|').flatMap((part) => parseMetadataTypeString(part.trim())))
  }

  // Quoted literal
  const quoted = normalized.match(/^['"](.*)['"]$/)
  if (quoted) {
    return [{ kind: 'literal', value: quoted[1]! }]
  }

  // Boolean / numeric literals
  if (normalized === 'true' || normalized === 'false') {
    return [{ kind: 'literal', value: normalized === 'true' }]
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return [{ kind: 'literal', value: Number(normalized) }]
  }

  const lower = normalized.toLowerCase()
  if (lower === 'string' || lower === 'stringliteral') {
    return [{ kind: 'string' }]
  }
  if (lower === 'number' || lower === 'num') {
    return [{ kind: 'number' }]
  }
  if (lower === 'boolean' || lower === 'bool') {
    return [{ kind: 'boolean' }]
  }
  if (lower === 'bigint') {
    return [{ kind: 'bigint' }]
  }
  if (lower === 'symbol') {
    return [{ kind: 'symbol' }]
  }
  if (lower === 'function' || lower === 'method') {
    return [{ kind: 'function' }]
  }
  if (lower === 'any') {
    return [{ kind: 'any' }]
  }
  if (lower === 'unknown') {
    return [{ kind: 'unknown' }]
  }
  if (lower === 'null') {
    return [{ kind: 'null' }]
  }
  if (
    lower === 'array'
    || lower.endsWith('[]')
    || lower.startsWith('array<')
    || lower.startsWith('readonlyarray<')
    || lower.startsWith('any[]')
  ) {
    return [{ kind: 'array' }]
  }
  if (lower === 'object' || lower.startsWith('record<') || lower.startsWith('{')) {
    return [{ kind: 'object' }]
  }

  // Named aliases are opaque without their declaration; preserve incompleteness.
  return [{ kind: 'unknown' }]
}

function uniquePropTypes(types: PropTypeDescriptor[]): PropTypeDescriptor[] {
  const seen = new Set<string>()
  const unique: PropTypeDescriptor[] = []
  for (const type of types) {
    const key = type.kind === 'literal' ? `literal:${String(type.value)}` : type.kind
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(type)
  }
  return unique
}

function mergeMetadataPropContracts(first: PropContract, second: PropContract): PropContract {
  const required = first.required === true || second.required === true
    ? true
    : first.required === false || second.required === false
      ? false
      : first.required ?? second.required
  const types = uniquePropTypes([...(first.types ?? []), ...(second.types ?? [])])
  const merged: PropContract = { name: first.name || second.name }
  if (required !== undefined) {
    merged.required = required
  }
  if (types.length > 0) {
    merged.types = types
  }
  return merged
}

function getVeturAttributeName(attribute: VeturAttributeNode): string | undefined {
  return typeof attribute === 'string' ? attribute : attribute.name
}

function isVeturEventAttribute(name: string): boolean {
  return name.startsWith('@')
}

function normalizeVeturPropName(name: string): string {
  return name.replace(/^:/, '')
}

function normalizeComponentName(tag: string): string {
  if (!tag.includes('-')) {
    return tag
  }

  return tag
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
}

function getComponentContractNames(tag: string): string[] {
  const componentName = normalizeComponentName(tag)
  return componentName === tag ? [tag] : [tag, componentName]
}

function toProvenance(artifact: EvidenceFile, source: MetadataSource): ContractProvenance {
  return {
    source,
    path: artifact.path,
    relativePath: artifact.relativePath
  }
}

function knownDimension<T>(entries: Map<string, T> = new Map(), issues: ContractIssue[] = []): ContractDimension<T> {
  return { knowledge: issues.length > 0 ? 'partial' : 'known', acceptance: 'unknown', entries, issues }
}

function unknownDimension<T>(): ContractDimension<T> {
  return { knowledge: 'unknown', acceptance: 'unknown', entries: new Map(), issues: [] }
}

function emptyContractMap(): ComponentContractMap {
  return { components: new Map(), sources: [], problems: [] }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

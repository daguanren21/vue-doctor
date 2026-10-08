export type ContractKnowledge = 'known' | 'partial' | 'unknown'
export type ContractAcceptance = 'closed' | 'open' | 'unknown'

export interface ContractIssue {
  code: string
  message: string
  artifact?: string
}

export interface ContractDimension<T> {
  knowledge: ContractKnowledge
  acceptance: ContractAcceptance
  entries: Map<string, T>
  issues: ContractIssue[]
}

export interface ContractProvenance {
  source: 'adapter' | 'web-types' | 'vetur-tags' | 'vetur-attributes' | 'typescript' | 'runtime'
  path: string
  relativePath: string
}

export interface EventParameter {
  name?: string
  optional: boolean
  rest: boolean
}

export interface EventSignature {
  parameters: EventParameter[]
  minArity: number
  maxArity: number | null
}

export interface EventContract {
  name: string
  signatures: EventSignature[]
  source: 'emit' | 'listener-prop' | 'metadata'
}


export type PropTypeKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'function'
  | 'symbol'
  | 'bigint'
  | 'any'
  | 'unknown'
  | 'null'
  | 'literal'

export interface PropTypeDescriptor {
  kind: PropTypeKind
  value?: string | number | boolean
}

export interface PropContract {
  name: string
  /** True when TypeScript / runtime evidence marks the prop as required. */
  required?: boolean
  /** Flattened accepted value kinds from declaration evidence. */
  types?: PropTypeDescriptor[]
}
export interface FallthroughContract {
  attributes: ContractAcceptance
  listeners: ContractAcceptance
  attributeTargets?: AttributeForwardTarget[]
}

export type AttributeForwardTarget = {
  kind: 'component'
  name: string
  file: string
  excludedAttributes?: string[]
} | {
  kind: 'element'
  name: string
  file: string
  supportedAttributes?: string[]
  excludedAttributes?: string[]
}

export interface ComponentContract {
  name: string
  aliases: string[]
  props: ContractDimension<PropContract>
  events: ContractDimension<EventContract>
  slots: ContractDimension<{ name: string }>
  fallthrough: FallthroughContract
  /** Statically resolved Vue 2 model mapping; absent or null means unresolved. */
  vue2Model?: { prop: string; event: string } | null
  sources: ContractProvenance[]
}

export interface ComponentContractMap {
  components: Map<string, ComponentContract>
  sources: ContractProvenance[]
  problems: Array<{ message: string; path?: string }>
}

export interface DeclarationCacheInputs {
  reliable: boolean
  files: string[]
  fileProbes: string[]
  directoryProbes: string[]
  resolutions: string[]
}

export interface DeclarationContractReadResult {
  contracts: ComponentContractMap
  cacheInputs: DeclarationCacheInputs
}

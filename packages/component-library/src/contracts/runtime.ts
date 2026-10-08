import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { babelParse, compileScript, type SFCDescriptor, type SFCScriptBlock } from '@vue/compiler-sfc'
import { API } from 'typescript/unstable/sync'
import {
  isCallExpression,
  isArrowFunction,
  isBlock,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isObjectBindingPattern,
  isPropertyAssignment,
  isPropertyAccessExpression,
  isPropertySignatureDeclaration,
  isReturnStatement,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  SyntaxKind,
  type CallExpression,
  type InterfaceDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile
} from 'typescript/unstable/ast'
import { listSearchableFiles } from '../artifacts.js'
import type { ComponentLibraryEvidence } from '../types.js'
import { createRuntimeInteractionReader, type RuntimeInteractionEvidence, type RuntimeOptionEvidence, type RuntimePublicComponent } from './runtime-interactions.js'
import { parseRuntimeSfc } from './runtime-sfc.js'
import type {
  AttributeForwardTarget,
  ComponentContract,
  ContractAcceptance,
  ContractProvenance,
  EventContract,
  FallthroughContract,
  PropContract,
  PropTypeDescriptor
} from './types.js'

export interface RuntimeFallthroughResult {
  /** Contracts whose identity is traced from an actual public runtime export. */
  publicComponents?: ComponentContract[]
  publicDynamicSlots?: Set<string>
  components: Map<string, FallthroughContract>
  props: Map<string, Map<string, PropContract>>
  events: Map<string, Map<string, EventContract>>
  vue2Models: Map<string, ComponentContract['vue2Model']>
  slots: Map<string, Map<string, { name: string }>>
  dynamicSlots: Set<string>
  componentSources: Map<string, ContractProvenance[]>
  sources: ContractProvenance[]
  problems: Array<{ message: string; path?: string }>
}

const runtimeExtensions = new Set(['.js', '.mjs', '.cjs'])
const sourceScriptExtensions = new Set([...runtimeExtensions, '.ts', '.tsx', '.jsx'])
const vnodeFactories = new Set([
  'createBlock',
  'createElementBlock',
  'createElementVNode',
  'createVNode',
  'h'
])
const maxAttributeProvenanceDepth = 64

interface AttributeBagEvidence {
  excludedAttributes: Set<string>
}

interface AttributeBinding {
  initializer: Node
  excludedAttributes: string[]
}

interface AttributeProvenanceContext {
  bindings: Map<string, AttributeBinding[]>
  sourceNames: Set<string>
  sourceFile: SourceFile
}

export async function readRuntimeFallthrough(
  evidence: ComponentLibraryEvidence
): Promise<RuntimeFallthroughResult> {
  if (!evidence.package.packageRoot || evidence.artifacts.runtimeEntries.length === 0) {
    return emptyRuntimeFallthroughResult()
  }
  const files = await listSearchableFiles(evidence.package.packageRoot)
  const readInteractions = createRuntimeInteractionReader(files)
  const filesByPath = new Map(files.map(file => [file.path, file]))
  const candidateFiles = files.filter((file) => (
    (sourceScriptExtensions.has(extname(file.path)) && !/\.d\.[cm]?ts$/.test(file.path)) || extname(file.path) === '.vue'
  ))
  const candidates = (await mapWithConcurrency(
    candidateFiles,
    16,
    async (file) => {
      const text = await readFile(file.path, 'utf8')
      const compiledRuntime = runtimeExtensions.has(extname(file.path)) && text.includes('defineComponent') && (
        text.includes('createBlock') || text.includes('createElementBlock') || text.includes('createVNode') || text.includes(' h(')
      )
      return { file, text, compiledRuntime }
    }
  )).filter(({ file, text, compiledRuntime }) => extname(file.path) === '.vue'
    ? text.includes('<template') || text.includes('<script')
    : compiledRuntime || /\bexport\b/.test(text))


  const domPath = resolveDomDeclarationPath()
  const openFiles = [
    ...candidates.filter(({ compiledRuntime }) => compiledRuntime).map(({ file }) => file.path),
    ...(domPath ? [domPath] : [])
  ]
  const api = new API({ cwd: evidence.package.packageRoot })
  let snapshot: ReturnType<API['updateSnapshot']> | undefined

  try {
    snapshot = api.updateSnapshot({ openFiles })
    const nativeAttributes = domPath
      ? readNativeAttributes(getSourceFile(snapshot, domPath))
      : new Map<string, string[]>()
    const components = new Map<string, FallthroughContract>()
    const props = new Map<string, Map<string, PropContract>>()
    const events = new Map<string, Map<string, EventContract>>()
    const vue2Models = new Map<string, ComponentContract['vue2Model']>()
    const componentSources = new Map<string, ContractProvenance[]>()
    const slots = new Map<string, Map<string, { name: string }>>()
    const dynamicSlots = new Set<string>()
    const sources: ContractProvenance[] = []
    const problems: RuntimeFallthroughResult['problems'] = []
    const addInteractions = (name: string, interaction: RuntimeInteractionEvidence) => {
      if (interaction.events.size > 0) events.set(name, new Map([...(events.get(name) ?? []), ...interaction.events]))
      const previous = vue2Models.get(name)
      const next = interaction.vue2Model
      vue2Models.set(name, vue2Models.has(name) && (previous?.prop !== next?.prop || previous?.event !== next?.event) ? null : next)
    }
    const addSources = (name: string, provenance: ContractProvenance, paths: readonly string[]) => {
      const inheritedSources = paths.flatMap(path => {
        const source = filesByPath.get(path)
        return source ? [{ source: 'runtime' as const, path, relativePath: source.relativePath }] : []
      })
      sources.push(provenance, ...inheritedSources)
      componentSources.set(name, uniqueSources([...(componentSources.get(name) ?? []), provenance, ...inheritedSources]))
    }

    for (const { file, text, compiledRuntime } of candidates) {
      const provenance: ContractProvenance = {
        source: 'runtime',
        path: file.path,
        relativePath: file.relativePath
      }
      if (extname(file.path) === '.vue') {
        const fallbackName = toPascalCase(basename(file.path, '.vue'))
        const sfcEvidence = await readSfcEvidence(text, file.path, nativeAttributes, readInteractions.readSfc)
        const name = sfcEvidence.name ?? fallbackName
        if (sfcEvidence.problem) {
          problems.push({ message: sfcEvidence.problem, path: file.path })
        }
        if (sfcEvidence.fallthrough) {
          components.set(name, mergeRuntimeFallthrough(components.get(name), sfcEvidence.fallthrough))
        }
        if (sfcEvidence.props.size > 0) {
          props.set(name, mergeRuntimeProps(props.get(name), sfcEvidence.props))
        }
        addInteractions(name, sfcEvidence)
        if (sfcEvidence.slots.size > 0) {
          slots.set(name, new Map([
            ...(slots.get(name) ?? []),
            ...sfcEvidence.slots
          ]))
        }
        if (sfcEvidence.dynamicSlots) dynamicSlots.add(name)
        if (
          sfcEvidence.fallthrough
          || sfcEvidence.props.size > 0
          || sfcEvidence.events.size > 0
          || sfcEvidence.vue2Model !== null
          || sfcEvidence.slots.size > 0
          || sfcEvidence.dynamicSlots
        ) {
          addSources(name, provenance, sfcEvidence.interactionSources)
        }
        continue
      }
      const interaction = await readInteractions.readModule(text, file.path)
      if (interaction?.name) {
        addInteractions(interaction.name, interaction)
        if (interaction.slots.size) slots.set(interaction.name, new Map([...(slots.get(interaction.name) ?? []), ...interaction.slots]))
        if (interaction.dynamicSlots) dynamicSlots.add(interaction.name)
        for (const value of interaction.propsOptions) {
          props.set(interaction.name, new Map([...(props.get(interaction.name) ?? []), ...readPropsValueNode(value)]))
        }
        if (interaction.events.size > 0 || interaction.vue2Model !== null || interaction.propsOptions.length || interaction.slots.size || interaction.dynamicSlots) {
          addSources(interaction.name, provenance, interaction.interactionSources)
        }
      }
      if (!compiledRuntime) continue
      const sourceFile = getSourceFile(snapshot, file.path)
      if (!sourceFile) {
        problems.push({ message: 'TypeScript could not parse the runtime component artifact.', path: file.path })
        continue
      }

      const names = findComponentNames(sourceFile)
      if (names.length === 0) {
        continue
      }
      const fallthrough = findFallthrough(sourceFile, nativeAttributes)
      sources.push(provenance)
      for (const name of names) {
        components.set(name, mergeRuntimeFallthrough(components.get(name), fallthrough))
        componentSources.set(name, uniqueSources([
          ...(componentSources.get(name) ?? []),
          provenance
        ]))
      }
    }

    const publicComponents: ComponentContract[] = []
    const publicDynamicSlots = new Set<string>()
    const publicEvidence = await readInteractions.readPublicComponents(evidence.artifacts.runtimeEntries, evidence.package.packageRoot)
    const identities = new Map<string, RuntimePublicComponent[]>()
    const nameIdentities = new Map<string, Set<string>>()
    const exportIdentities = new Map<string, Set<string>>()
    for (const component of publicEvidence) {
      const group = identities.get(component.identity)
      if (group) group.push(component)
      else identities.set(component.identity, [component])
      if (component.name) {
        const owners = nameIdentities.get(component.name) ?? new Set<string>()
        owners.add(component.identity)
        nameIdentities.set(component.name, owners)
      }
      const owners = exportIdentities.get(component.exportName) ?? new Set<string>()
      owners.add(component.identity)
      exportIdentities.set(component.exportName, owners)
    }
    for (const group of identities.values()) {
      const component = group[0]!
      const exports = [...new Set(group.map(component => component.exportName))]
        .filter(name => exportIdentities.get(name)?.size === 1)
      if (!exports.length) continue
      const file = filesByPath.get(component.file)
      if (!file) continue
      const sfc = component.descriptor
        ? await readSfcEvidence(await readFile(file.path, 'utf8'), file.path, nativeAttributes, readInteractions.readSfc)
        : undefined
      const explicitName = component.name && nameIdentities.get(component.name)?.size === 1 ? component.name : undefined
      const name = explicitName ?? exports.find(name => name !== 'default')
        ?? (component.name ? 'default' : toPascalCase(basename(file.path, extname(file.path))))
      const publicProps = new Map<string, PropContract>()
      for (const value of component.propsOptions) {
        for (const [name, prop] of readPropsValueNode(value)) publicProps.set(name, prop)
      }
      // Script setup's macro props supplement ordinary options; never infer a closed surface.
      if (component.descriptor?.scriptSetup && sfc) {
        for (const [name, prop] of sfc.props) publicProps.set(name, prop)
      }
      const sourceFile = !sfc ? getSourceFile(snapshot, file.path) : undefined
      const compiledNames = sourceFile ? findComponentNames(sourceFile) : []
      const publicFallthrough = sfc?.fallthrough ?? (sourceFile && compiledNames.length === 1
        && compiledNames[0] === name ? findFallthrough(sourceFile, nativeAttributes) : undefined)
      const publicEvents = new Map([...component.events, ...(sfc?.events ?? [])])
      const publicSlots = new Map([...component.slots, ...(sfc?.slots ?? [])])
      if (component.dynamicSlots || sfc?.dynamicSlots) publicDynamicSlots.add(name)
      const provenance = uniqueSources([file.path, ...group.flatMap(component => component.interactionSources)].map(path => ({
        source: 'runtime' as const,
        path,
        relativePath: filesByPath.get(path)?.relativePath ?? relative(evidence.package.packageRoot!, path)
      })))
      publicComponents.push({
        name,
        aliases: exports.filter(alias => alias !== name),
        props: { knowledge: publicProps.size ? 'partial' : 'unknown', acceptance: 'unknown', entries: publicProps, issues: [] },
        events: { knowledge: publicEvents.size ? 'partial' : 'unknown', acceptance: 'unknown', entries: publicEvents, issues: [] },
        slots: { knowledge: publicSlots.size ? 'partial' : 'unknown', acceptance: 'unknown', entries: publicSlots, issues: [] },
        vue2Model: component.descriptor?.template?.attrs.functional !== undefined ? null : component.vue2Model,
        fallthrough: publicFallthrough ?? { attributes: 'unknown', listeners: 'unknown' },
        sources: provenance
      })
      sources.push(...provenance)
    }

    return {
      publicComponents,
      publicDynamicSlots,
      components,
      props,
      events,
      vue2Models,
      slots,
      dynamicSlots,
      componentSources,
      sources: uniqueSources(sources),
      problems
    }
  } finally {
    try {
      snapshot?.dispose()
    } finally {
      api.close()
    }
  }
}

function emptyRuntimeFallthroughResult(): RuntimeFallthroughResult {
  return {
    components: new Map(),
    slots: new Map(),
    dynamicSlots: new Set(),
    props: new Map(),
    events: new Map(),
    vue2Models: new Map(),
    componentSources: new Map(),
    sources: [],
    problems: []
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  for (let index = 0; index < items.length; index += concurrency) {
    results.push(...await Promise.all(items.slice(index, index + concurrency).map(map)))
  }
  return results
}

type SfcTemplateNode = {
  type: number
  tag?: string
  tagType?: number
  props?: Array<{
    type: number
    name?: string
    arg?: { type?: number; content?: string; isStatic?: boolean }
    exp?: { content?: string }
    value?: { content?: string }
  }>
  children?: SfcTemplateNode[]
}

type SfcScriptNode = {
  type?: string
  name?: string
  value?: unknown
  id?: SfcScriptNode
  init?: SfcScriptNode
  key?: SfcScriptNode
  declaration?: SfcScriptNode
  expression?: SfcScriptNode
  callee?: SfcScriptNode
  arguments?: SfcScriptNode[]
  declarations?: SfcScriptNode[]
  properties?: SfcScriptNode[]
}

interface SfcRuntimeEvidence {
  fallthrough?: FallthroughContract
  name?: string
  slots: Map<string, { name: string }>
  dynamicSlots: boolean
  props: Map<string, PropContract>
  events: Map<string, EventContract>
  vue2Model: RuntimeInteractionEvidence['vue2Model']
  interactionSources: string[]
  problem?: string
}

async function readSfcEvidence(
  source: string,
  file: string,
  nativeAttributes: Map<string, string[]>,
  readInteractions: (descriptor: SFCDescriptor, file: string) => Promise<RuntimeOptionEvidence>
): Promise<SfcRuntimeEvidence> {
  const { descriptor, errors } = parseRuntimeSfc(source, file)
  if (errors.length > 0) {
    return {
      slots: new Map(),
      dynamicSlots: false,
      props: new Map(),
      events: new Map(),
      vue2Model: null,
      interactionSources: [],
      problem: `Vue could not parse the published SFC: ${errors.map(String).join('; ')}`
    }
  }
  const compiled = compileSfcScript(descriptor, file)
  const props = compiled && descriptor.scriptSetup ? readSfcProps(compiled) : new Map<string, PropContract>()
  const interactions = await readInteractions(descriptor, file)
  for (const value of interactions.propsOptions) {
    for (const [name, prop] of readPropsValueNode(value)) props.set(name, prop)
  }
  const slotEvidence = readSfcSlots(descriptor)
  return {
    name: compiled ? readSfcComponentName(compiled) : undefined,
    props,
    ...interactions,
    ...(descriptor.template?.attrs.functional !== undefined ? { vue2Model: null } : {}),
    slots: new Map([...interactions.slots, ...slotEvidence.entries]),
    dynamicSlots: interactions.dynamicSlots || slotEvidence.dynamic,
    ...(descriptor.template?.ast && descriptor.template.attrs.functional === undefined
      ? { fallthrough: readSfcTemplateFallthrough(descriptor, file, nativeAttributes) }
      : {})
  }
}

function compileSfcScript(
  descriptor: SFCDescriptor,
  file: string
): SFCScriptBlock | undefined {
  if (!descriptor.script && !descriptor.scriptSetup) return undefined
  try {
    return compileScript(descriptor, { id: file })
  } catch {
    return undefined
  }
}

function readSfcComponentName(compiled: SFCScriptBlock): string | undefined {
  const statements = [
    ...(compiled.scriptAst ?? []),
    ...(compiled.scriptSetupAst ?? [])
  ] as SfcScriptNode[]
  const bindings = new Map<string, SfcScriptNode>()
  visitSfcScript(statements, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier' || !node.id.name || !node.init) return
    bindings.set(node.id.name, node.init)
  })
  let name: string | undefined
  visitSfcScript(statements, (node) => {
    if (name) return
    if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
      name = componentNameFromExpression(node.declaration, bindings)
      return
    }
    if (
      node.type === 'CallExpression'
      && node.callee?.type === 'Identifier'
      && node.callee.name === 'defineOptions'
    ) {
      name = componentNameFromObject(node.arguments?.[0])
    }
  })
  return name
}

function componentNameFromExpression(
  node: SfcScriptNode,
  bindings: Map<string, SfcScriptNode>
): string | undefined {
  if (node.type === 'ObjectExpression') return componentNameFromObject(node)
  if (node.type === 'Identifier' && node.name) {
    const binding = bindings.get(node.name)
    return binding ? componentNameFromExpression(binding, bindings) : undefined
  }
  if (node.type === 'CallExpression') {
    return componentNameFromObject(node.arguments?.[0])
  }
  return undefined
}

function componentNameFromObject(node: SfcScriptNode | undefined): string | undefined {
  if (node?.type !== 'ObjectExpression') return undefined
  for (const property of node.properties ?? []) {
    const key = property.key?.type === 'Identifier'
      ? property.key.name
      : typeof property.key?.value === 'string'
        ? property.key.value
        : undefined
    if (key !== 'name') continue
    const value = property.value
    if (typeof value === 'string') return value
    if (isSfcScriptNode(value) && typeof value.value === 'string') return value.value
    return undefined
  }
  return undefined
}

function visitSfcScript(
  roots: SfcScriptNode[],
  visit: (node: SfcScriptNode) => void
): void {
  const walk = (node: SfcScriptNode): void => {
    visit(node)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
      if (Array.isArray(value)) {
        for (const child of value) if (isSfcScriptNode(child)) walk(child)
      } else if (isSfcScriptNode(value)) {
        walk(value)
      }
    }
  }
  for (const root of roots) walk(root)
}

function isSfcScriptNode(value: unknown): value is SfcScriptNode {
  return Boolean(value && typeof value === 'object' && 'type' in value)
}

interface SfcSlotEvidence {
  entries: Map<string, { name: string }>
  dynamic: boolean
}

function readSfcSlots(descriptor: SFCDescriptor): SfcSlotEvidence {
  const slots = new Map<string, { name: string }>()
  const root = descriptor.template?.ast as SfcTemplateNode | undefined
  if (!root) return { entries: slots, dynamic: false }
  let dynamic = false
  const visit = (node: SfcTemplateNode): void => {
    if (node.type === 1 && node.tag === 'slot') {
      const nameAttribute = node.props?.find((prop) => prop.type === 6 && prop.name === 'name')
      const dynamicName = node.props?.some((prop) => (
        prop.type === 7
        && prop.name === 'bind'
        && (
          !prop.arg
          || prop.arg.content === 'name'
          || prop.arg.isStatic === false
        )
      ))
      if (dynamicName) {
        dynamic = true
      } else {
        const name = nameAttribute?.value?.content || 'default'
        slots.set(name, { name })
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return {
    entries: new Map([...slots].sort(([first], [second]) => first.localeCompare(second))),
    dynamic
  }
}

function readSfcTemplateFallthrough(
  descriptor: SFCDescriptor,
  file: string,
  nativeAttributes: Map<string, string[]>
): FallthroughContract {
  const template = descriptor.template
  if (!template?.ast) {
    return { attributes: 'unknown', listeners: 'unknown', attributeTargets: [] }
  }
  const roots = (template.ast.children as SfcTemplateNode[])
    .filter((node) => node.type === 1)
  if (roots.length !== 1) {
    return { attributes: 'unknown', listeners: 'unknown', attributeTargets: [] }
  }
  const root = roots[0]!
  const explicitTargets = collectSfcAttrsTargets(root, file, nativeAttributes)
  const implicitTarget = createSfcTarget(root, file, nativeAttributes)
  const targets = uniqueTargets([
    ...explicitTargets,
    ...(implicitTarget ? [implicitTarget] : [])
  ])
  return { attributes: 'unknown', listeners: 'unknown', attributeTargets: targets }
}

function readSfcProps(compiled: SFCScriptBlock): Map<string, PropContract> {
  const bindings = compiled.bindings ?? {}
  const fromBindings = new Map(Object.entries(bindings)
    .filter(([, binding]) => binding === 'props' || binding === 'props-aliased')
    .map(([name]) => [name, { name }] as const)
    .sort(([first], [second]) => first.localeCompare(second)))

  return mergeRuntimeProps(
    fromBindings,
    mergeRuntimeProps(
      readScriptAstProps(compiled.scriptAst),
      mergeRuntimeProps(
        readDefinePropsFromAst(compiled.scriptSetupAst),
        readCompiledComponentProps(compiled.content)
      )
    )
  )
}

function readScriptAstProps(scriptAst: unknown[] | undefined): Map<string, PropContract> {
  if (!scriptAst) {
    return new Map()
  }
  const exportDefault = scriptAst.find((node: any) => node?.type === 'ExportDefaultDeclaration') as any
  const declaration = exportDefault?.declaration
  const options = declaration?.type === 'CallExpression'
    && declaration.callee?.type === 'Identifier'
    && declaration.callee.name === 'defineComponent'
    ? declaration.arguments?.[0]
    : declaration
  return readPropsOptionValue(options)
}

function readDefinePropsFromAst(scriptSetupAst: unknown[] | undefined): Map<string, PropContract> {
  if (!scriptSetupAst) {
    return new Map()
  }

  for (const node of walkBabelNodes(scriptSetupAst)) {
    if (node?.type !== 'CallExpression') {
      continue
    }
    if (getBabelCalleeName(node.callee) !== 'defineProps') {
      continue
    }

    const argProps = readPropsValueNode(node.arguments?.[0])
    if (argProps.size > 0) {
      return argProps
    }

    const typeParam = node.typeParameters?.params?.[0]
    const fromType = readPropsFromTsType(typeParam)
    if (fromType.size > 0) {
      return fromType
    }
  }

  return new Map()
}

function readCompiledComponentProps(content: string | undefined): Map<string, PropContract> {
  if (!content) return new Map()
  try {
    const body = babelParse(content, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program.body
    const exported = body.find(node => node.type === 'ExportDefaultDeclaration')
    if (exported?.type !== 'ExportDefaultDeclaration') return new Map()
    const options = exported.declaration.type === 'CallExpression'
      ? exported.declaration.arguments[0]
      : exported.declaration
    return readPropsOptionValue(options)
  } catch {
    return new Map()
  }
}


function readPropsOptionValue(options: any): Map<string, PropContract> {
  if (!options || options.type !== 'ObjectExpression') {
    return new Map()
  }
  for (let index = options.properties.length - 1; index >= 0; index--) {
    const property = options.properties[index]
    if (property?.type === 'SpreadElement' || property?.computed) return new Map()
    if (getBabelPropertyName(property?.key) === 'props') return readPropsValueNode(property.value)
  }
  return new Map()
}

function readPropsValueNode(value: any): Map<string, PropContract> {
  const props = new Map<string, PropContract>()
  if (!value) {
    return props
  }

  if (value.type === 'ArrayExpression') {
    for (const element of value.elements ?? []) {
      const name = getBabelStringValue(element)
      if (name) {
        props.set(name, { name, required: false })
      }
    }
    return props
  }

  if (value.type === 'ObjectExpression') {
    for (const property of value.properties ?? []) {
      if (property?.type === 'SpreadElement' || property?.type === 'SpreadProperty' || property?.computed) {
        // A spread may override a known property's details, but cannot remove its name.
        for (const name of props.keys()) props.set(name, { name })
        continue
      }
      const name = getBabelPropertyName(property?.key)
      if (!name) {
        continue
      }
      props.set(name, propContractFromBabelProperty(name, property?.value ?? property))
    }
  }

  return props
}

function propContractFromBabelProperty(name: string, value: any): PropContract {
  if (!value) {
    return { name, required: false }
  }

  // Bare constructor: props: { label: String }
  if (value.type === 'Identifier') {
    const types = runtimeConstructorToTypes(value.name)
    return types ? { name, required: false, types } : { name, required: false }
  }

  if (value.type === 'ArrayExpression') {
    const types = flattenRuntimeTypes(value.elements ?? [])
    return types.length > 0
      ? { name, required: false, types }
      : { name, required: false }
  }

  if (value.type !== 'ObjectExpression') {
    return { name, required: false }
  }

  let required: boolean | undefined
  let types: PropTypeDescriptor[] | undefined
  let hasDefault = false

  for (const property of value.properties ?? []) {
    const key = getBabelPropertyName(property?.key)
    if (!key) {
      continue
    }
    if (key === 'required') {
      if (property.value?.type === 'BooleanLiteral') {
        required = property.value.value === true
      } else if (property.value?.type === 'Literal' && typeof property.value.value === 'boolean') {
        required = property.value.value === true
      }
    } else if (key === 'default') {
      hasDefault = true
    } else if (key === 'type') {
      types = readRuntimeTypeNode(property.value)
    }
  }

  if (required === undefined && hasDefault) {
    required = false
  }
  if (required === undefined) {
    required = false
  }

  const contract: PropContract = { name, required }
  if (types && types.length > 0) {
    contract.types = types
  }
  return contract
}

function readRuntimeTypeNode(node: any): PropTypeDescriptor[] | undefined {
  if (!node) {
    return undefined
  }
  if (node.type === 'Identifier') {
    return runtimeConstructorToTypes(node.name)
  }
  if (node.type === 'ArrayExpression') {
    const types = flattenRuntimeTypes(node.elements ?? [])
    return types.length > 0 ? types : undefined
  }
  if (node.type === 'NullLiteral' || (node.type === 'Literal' && node.value === null)) {
    return [{ kind: 'null' }]
  }
  return undefined
}

function flattenRuntimeTypes(elements: any[]): PropTypeDescriptor[] {
  const types: PropTypeDescriptor[] = []
  const seen = new Set<string>()
  for (const element of elements) {
    if (!element) {
      continue
    }
    if (element.type === 'Identifier') {
      for (const type of runtimeConstructorToTypes(element.name) ?? []) {
        if (!seen.has(type.kind)) {
          seen.add(type.kind)
          types.push(type)
        }
      }
      continue
    }
    if (element.type === 'NullLiteral' || (element.type === 'Literal' && element.value === null)) {
      if (!seen.has('null')) {
        seen.add('null')
        types.push({ kind: 'null' })
      }
    }
  }
  return types
}

function runtimeConstructorToTypes(name: string): PropTypeDescriptor[] | undefined {
  switch (name) {
    case 'String':
      return [{ kind: 'string' }]
    case 'Number':
      return [{ kind: 'number' }]
    case 'Boolean':
      return [{ kind: 'boolean' }]
    case 'Array':
      return [{ kind: 'array' }]
    case 'Object':
      return [{ kind: 'object' }]
    case 'Function':
      return [{ kind: 'function' }]
    case 'Symbol':
      return [{ kind: 'symbol' }]
    case 'BigInt':
      return [{ kind: 'bigint' }]
    default:
      return undefined
  }
}

function readPropsFromTsType(typeNode: any): Map<string, PropContract> {
  const props = new Map<string, PropContract>()
  if (!typeNode) {
    return props
  }

  if (typeNode.type === 'TSTypeLiteral') {
    for (const member of typeNode.members ?? []) {
      if (member?.type !== 'TSPropertySignature') {
        continue
      }
      const name = getBabelPropertyName(member.key)
      if (!name) {
        continue
      }
      const required = member.optional !== true
      const types = readTsTypeNode(member.typeAnnotation?.typeAnnotation)
      const contract: PropContract = { name, required }
      if (types && types.length > 0) {
        contract.types = types
      }
      props.set(name, contract)
    }
    return props
  }

  if (typeNode.type === 'TSTypeReference' || typeNode.type === 'TSTypeQuery') {
    // External type aliases are unknown at runtime extraction time.
    return props
  }

  return props
}

function readTsTypeNode(typeNode: any): PropTypeDescriptor[] | undefined {
  if (!typeNode) {
    return undefined
  }

  if (typeNode.type === 'TSUnionType') {
    const types: PropTypeDescriptor[] = []
    const seen = new Set<string>()
    for (const part of typeNode.types ?? []) {
      for (const type of readTsTypeNode(part) ?? []) {
        const key = type.kind === 'literal' ? `literal:${String(type.value)}` : type.kind
        if (!seen.has(key)) {
          seen.add(key)
          types.push(type)
        }
      }
    }
    return types.length > 0 ? types : undefined
  }

  switch (typeNode.type) {
    case 'TSStringKeyword':
      return [{ kind: 'string' }]
    case 'TSNumberKeyword':
      return [{ kind: 'number' }]
    case 'TSBooleanKeyword':
      return [{ kind: 'boolean' }]
    case 'TSBigIntKeyword':
      return [{ kind: 'bigint' }]
    case 'TSSymbolKeyword':
      return [{ kind: 'symbol' }]
    case 'TSAnyKeyword':
      return [{ kind: 'any' }]
    case 'TSUnknownKeyword':
      return [{ kind: 'unknown' }]
    case 'TSNullKeyword':
      return [{ kind: 'null' }]
    case 'TSArrayType':
    case 'TSTupleType':
      return [{ kind: 'array' }]
    case 'TSFunctionType':
      return [{ kind: 'function' }]
    case 'TSLiteralType': {
      const literal = typeNode.literal
      if (literal?.type === 'StringLiteral') {
        return [{ kind: 'literal', value: literal.value }]
      }
      if (literal?.type === 'NumericLiteral') {
        return [{ kind: 'literal', value: literal.value }]
      }
      if (literal?.type === 'BooleanLiteral') {
        return [{ kind: 'literal', value: literal.value === true }]
      }
      if (literal?.type === 'Literal') {
        if (typeof literal.value === 'string' || typeof literal.value === 'number' || typeof literal.value === 'boolean') {
          return [{ kind: 'literal', value: literal.value }]
        }
      }
      return undefined
    }
    case 'TSTypeReference': {
      const name = getBabelPropertyName(typeNode.typeName) ?? typeNode.typeName?.name
      if (name === 'Array' || name === 'ReadonlyArray') {
        return [{ kind: 'array' }]
      }
      if (name === 'Record' || name === 'Object') {
        return [{ kind: 'object' }]
      }
      if (name === 'Function') {
        return [{ kind: 'function' }]
      }
      return [{ kind: 'object' }]
    }
    case 'TSTypeLiteral':
    case 'TSIntersectionType':
      return [{ kind: 'object' }]
    default:
      return undefined
  }
}




function getBabelCalleeName(node: any): string | undefined {
  if (!node) return undefined
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') return getBabelPropertyName(node.property)
  return undefined
}

function* walkBabelNodes(node: any): Generator<any> {
  if (!node) {
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      yield* walkBabelNodes(item)
    }
    return
  }
  if (typeof node !== 'object') {
    return
  }
  yield node
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      yield* walkBabelNodes(value)
    }
  }
}

function getBabelPropertyName(node: any): string | undefined {
  if (!node) return undefined
  if (node.type === 'Identifier') return node.name
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral') return String(node.value)
  if (node.type === 'Literal') return String(node.value)
  return undefined
}

function getBabelStringValue(node: any): string | undefined {
  if (!node) return undefined
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  return undefined
}

function collectSfcAttrsTargets(
  node: SfcTemplateNode,
  file: string,
  nativeAttributes: Map<string, string[]>
): AttributeForwardTarget[] {
  const forwardsAttrs = node.props?.some((prop) => (
    prop.type === 7
    && prop.name === 'bind'
    && prop.arg === undefined
    && prop.exp?.content === '$attrs'
  )) ?? false
  const target = forwardsAttrs ? createSfcTarget(node, file, nativeAttributes) : undefined
  return [
    ...(target ? [target] : []),
    ...(node.children?.flatMap((child) => collectSfcAttrsTargets(child, file, nativeAttributes)) ?? [])
  ]
}

function createSfcTarget(
  node: SfcTemplateNode,
  file: string,
  nativeAttributes: Map<string, string[]>
): AttributeForwardTarget | undefined {
  if (!node.tag) {
    return undefined
  }
  return node.tagType === 0
    ? {
        kind: 'element',
        name: node.tag,
        file,
        supportedAttributes: nativeAttributes.get(node.tag)
      }
    : { kind: 'component', name: node.tag, file }
}

function toPascalCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('')
}

function getSourceFile(
  snapshot: ReturnType<API['updateSnapshot']>,
  path: string
): SourceFile | undefined {
  return snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path)
}

function findComponentNames(sourceFile: SourceFile): string[] {
  const names = new Set<string>()
  walk(sourceFile, (node) => {
    if (!isCallExpression(node) || getCalleeName(node, sourceFile) !== 'defineComponent') {
      return
    }
    const options = node.arguments[0]
    if (!options || !isObjectLiteralExpression(options)) {
      return
    }
    for (const property of options.properties) {
      if (!isPropertyAssignment(property) || getPropertyName(property.name, sourceFile) !== 'name') {
        continue
      }
      if (isStringLiteral(property.initializer)) {
        names.add(property.initializer.text)
      }
    }
  })
  return [...names]
}

function findFallthrough(
  sourceFile: SourceFile,
  nativeAttributes: Map<string, string[]>
): FallthroughContract {
  const importNames = readImportNames(sourceFile)
  const attributeContext = createAttributeProvenanceContext(sourceFile)
  const explicitTargets: AttributeForwardTarget[] = []
  const rootTargets: AttributeForwardTarget[] = []
  let hasKnownFragmentRoot = false
  let inheritAttrs = true
  let propBoundaryKnown = true

  walk(sourceFile, (node) => {
    if (isPropertyAssignment(node) && getPropertyName(node.name, sourceFile) === 'inheritAttrs') {
      if (node.initializer.kind === SyntaxKind.FalseKeyword) {
        inheritAttrs = false
      }
    }

    if (isCallExpression(node) && getCalleeName(node, sourceFile) === 'defineComponent') {
      const options = node.arguments[0]
      if (options && isObjectLiteralExpression(options) && hasSetupOption(options, sourceFile)) {
        const props = options.properties.find((property) => (
          'name' in property && property.name
            ? getPropertyName(property.name, sourceFile) === 'props'
            : false
        ))
        if (props && isPropertyAssignment(props)) {
          propBoundaryKnown = props.initializer.kind === SyntaxKind.ObjectLiteralExpression
            || props.initializer.kind === SyntaxKind.ArrayLiteralExpression
        }
      }
    }

    if (!isVNodeCall(node, sourceFile) || !isInRenderReturn(node)) {
      return
    }
    const target = readVNodeTarget(node, sourceFile, importNames, nativeAttributes)
    const attributeBag = resolveAttributeBag(node.arguments[1], attributeContext)
    if (attributeBag && target) {
      explicitTargets.push(withAttributeBagEvidence(target, attributeBag))
    }
    if (hasVNodeAncestor(node, sourceFile)) {
      return
    }
    if (getTargetText(node.arguments[0], sourceFile) === 'Fragment') {
      hasKnownFragmentRoot = true
      return
    }
    if (target) {
      rootTargets.push(target)
    }
  })

  const targets = uniqueTargets([
    ...explicitTargets,
    ...(inheritAttrs ? rootTargets : [])
  ])
  const hasOpenOptionSurface = !inheritAttrs
    && hasExternalOptionSurface(sourceFile, attributeContext)
  const attributes: ContractAcceptance = hasOpenOptionSurface
    ? 'open'
    : targets.length > 0
    ? 'unknown'
    : propBoundaryKnown && (!inheritAttrs || hasKnownFragmentRoot)
      ? 'closed'
      : 'unknown'

  return { attributes, listeners: 'unknown', attributeTargets: targets }
}

function hasExternalOptionSurface(
  sourceFile: SourceFile,
  attributeContext: AttributeProvenanceContext
): boolean {
  const externalImports = readExternalImportNames(sourceFile)
  const instances = new Map<string, number>()

  walk(sourceFile, (node) => {
    if (!isVariableDeclaration(node) || !isIdentifier(node.name) || !node.initializer) {
      return
    }
    if (!isExternalFactoryCall(node.initializer, externalImports, sourceFile)) {
      return
    }
    if (!node.initializer.arguments.some((argument) => (
      Boolean(resolveAttributeBag(argument, attributeContext))
    ))) {
      return
    }
    instances.set(node.name.text, node.initializer.getStart(sourceFile))
  })

  let hasUpdate = false
  walk(sourceFile, (node) => {
    if (hasUpdate || !isCallExpression(node) || !isPropertyAccessExpression(node.expression)) {
      return
    }
    const receiver = node.expression.expression
    if (!isIdentifier(receiver)) {
      return
    }
    const creationPosition = instances.get(receiver.text)
    if (creationPosition === undefined || node.getStart(sourceFile) <= creationPosition) {
      return
    }
    hasUpdate = node.arguments.some((argument) => (
      Boolean(resolveAttributeBag(argument, attributeContext))
    ))
  })

  return hasUpdate
}

function readExternalImportNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const specifier = statement.moduleSpecifier.text
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      continue
    }
    const clause = statement.importClause
    if (clause?.name) {
      names.add(clause.name.text)
    }
    const bindings = clause?.namedBindings
    if (!bindings) {
      continue
    }
    if ('name' in bindings && bindings.name) {
      names.add(bindings.name.text)
      continue
    }
    if ('elements' in bindings) {
      for (const element of bindings.elements) {
        names.add(element.name.text)
      }
    }
  }
  return names
}

function isExternalFactoryCall(
  node: Node,
  externalImports: Set<string>,
  sourceFile: SourceFile
): node is CallExpression {
  if (!isCallExpression(node) && !isNewExpression(node)) {
    return false
  }
  const expression = node.expression
  if (isIdentifier(expression)) {
    return externalImports.has(expression.text)
  }
  if (isPropertyAccessExpression(expression) && isIdentifier(expression.expression)) {
    return externalImports.has(expression.expression.text)
  }
  return false
}

function hasSetupOption(
  options: ObjectLiteralExpression,
  sourceFile: SourceFile
): boolean {
  return options.properties.some((property) => (
    'name' in property && property.name
      ? getPropertyName(property.name, sourceFile) === 'setup'
      : false
  ))
}

function readImportNames(sourceFile: SourceFile): Map<string, string> {
  const names = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement) || !statement.importClause) {
      continue
    }
    const clause = statement.importClause
    if (clause.name) {
      names.set(clause.name.text, clause.name.text)
    }
    const bindings = clause.namedBindings
    if (!bindings || !('elements' in bindings)) {
      continue
    }
    for (const element of bindings.elements) {
      names.set(element.name.text, element.propertyName?.text ?? element.name.text)
    }
  }
  return names
}

function readVNodeTarget(
  call: CallExpression,
  sourceFile: SourceFile,
  importNames: Map<string, string>,
  nativeAttributes: Map<string, string[]>
): AttributeForwardTarget | undefined {
  const argument = call.arguments[0]
  if (!argument) {
    return undefined
  }
  if (isStringLiteral(argument)) {
    return {
      kind: 'element',
      name: argument.text,
      file: sourceFile.fileName,
      supportedAttributes: nativeAttributes.get(argument.text)
    }
  }

  let name: string | undefined
  if (isIdentifier(argument)) {
    name = argument.text
  } else if (isCallExpression(argument)) {
    const callee = getCalleeName(argument, sourceFile)
    const inner = argument.arguments[0]
    if (callee === 'unref' && inner && isIdentifier(inner)) {
      name = inner.text
    } else if (callee === 'resolveComponent' && inner && isStringLiteral(inner)) {
      name = inner.text
    }
  }
  if (!name || name === 'Fragment') {
    return undefined
  }
  return {
    kind: 'component',
    name: importNames.get(name) ?? name,
    file: sourceFile.fileName
  }
}

function isVNodeCall(node: Node, sourceFile: SourceFile): node is CallExpression {
  return isCallExpression(node) && vnodeFactories.has(getCalleeName(node, sourceFile) ?? '')
}

function getCalleeName(call: CallExpression, sourceFile: SourceFile): string | undefined {
  const text = call.expression.getText(sourceFile)
  return text.match(/([\w$]+)$/)?.[1]
}

function createAttributeProvenanceContext(sourceFile: SourceFile): AttributeProvenanceContext {
  const bindings = new Map<string, AttributeBinding[]>()
  const sourceNames = collectSetupAttrsNames(sourceFile)

  walk(sourceFile, (node) => {
    if (!isVariableDeclaration(node) || !node.initializer) {
      return
    }
    if (isIdentifier(node.name)) {
      addAttributeBinding(bindings, node.name.text, {
        initializer: node.initializer,
        excludedAttributes: []
      })
      return
    }
    if (!isObjectBindingPattern(node.name)) {
      return
    }

    const excludedAttributes = node.name.elements
      .filter((element) => !element.dotDotDotToken)
      .map((element) => element.propertyName || element.name)
      .map((name) => name ? getPropertyName(name, sourceFile) : undefined)
      .filter((name): name is string => Boolean(name))
    for (const element of node.name.elements) {
      if (!element.dotDotDotToken || !element.name || !isIdentifier(element.name)) {
        continue
      }
      addAttributeBinding(bindings, element.name.text, {
        initializer: node.initializer,
        excludedAttributes
      })
    }
  })

  return { bindings, sourceNames, sourceFile }
}

function collectSetupAttrsNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>()
  walk(sourceFile, (node) => {
    let parameters
    if (isMethodDeclaration(node) && getPropertyName(node.name, sourceFile) === 'setup') {
      parameters = node.parameters
    } else if (
      isPropertyAssignment(node)
      && getPropertyName(node.name, sourceFile) === 'setup'
      && (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))
    ) {
      parameters = node.initializer.parameters
    }
    const contextParameter = parameters?.[1]
    if (!contextParameter || !isObjectBindingPattern(contextParameter.name)) {
      return
    }
    for (const element of contextParameter.name.elements) {
      const sourceName = element.propertyName || element.name
      if (sourceName && element.name && getPropertyName(sourceName, sourceFile) === 'attrs' && isIdentifier(element.name)) {
        names.add(element.name.text)
      }
    }
  })
  return names
}

function addAttributeBinding(
  bindings: Map<string, AttributeBinding[]>,
  name: string,
  binding: AttributeBinding
): void {
  bindings.set(name, [...(bindings.get(name) ?? []), binding])
}

function resolveAttributeBag(
  node: Node | undefined,
  context: AttributeProvenanceContext,
  visited = new Set<Node>(),
  depth = 0
): AttributeBagEvidence | undefined {
  if (!node || depth >= maxAttributeProvenanceDepth || visited.has(node)) {
    return undefined
  }
  const nextVisited = new Set(visited).add(node)
  const { sourceFile } = context

  if (isPropertyAccessExpression(node) && node.name.text === '$attrs') {
    return { excludedAttributes: new Set() }
  }
  if (isCallExpression(node) && getCalleeName(node, sourceFile) === 'useAttrs') {
    return { excludedAttributes: new Set() }
  }
  if (isIdentifier(node)) {
    if (context.sourceNames.has(node.text)) {
      return { excludedAttributes: new Set() }
    }
    const bindings = context.bindings.get(node.text) ?? []
    if (bindings.length !== 1) {
      return undefined
    }
    const binding = bindings[0]!
    const evidence = resolveAttributeBag(binding.initializer, context, nextVisited, depth + 1)
    return evidence
      ? addExcludedAttributes(evidence, binding.excludedAttributes)
      : undefined
  }
  if (isCallExpression(node)) {
    const callee = getCalleeName(node, sourceFile)
    if (callee === 'unref') {
      return resolveAttributeBag(node.arguments[0], context, nextVisited, depth + 1)
    }
    if (callee === 'computed') {
      return resolveReturnedAttributeBag(node.arguments[0], context, nextVisited, depth + 1)
    }
    if (callee === 'mergeProps') {
      return mergeAttributeBagEvidence(node.arguments.map((argument) => (
        resolveAttributeBag(argument, context, nextVisited, depth + 1)
      )))
    }
  }
  if (isObjectLiteralExpression(node)) {
    return mergeAttributeBagEvidence(node.properties.map((property) => (
      isSpreadAssignment(property)
        ? resolveAttributeBag(property.expression, context, nextVisited, depth + 1)
        : undefined
    )))
  }
  if (isArrowFunction(node) || isFunctionExpression(node)) {
    return resolveReturnedAttributeBag(node, context, nextVisited, depth + 1)
  }
  return undefined
}

function resolveReturnedAttributeBag(
  node: Node | undefined,
  context: AttributeProvenanceContext,
  visited: Set<Node>,
  depth: number
): AttributeBagEvidence | undefined {
  if (!node || depth >= maxAttributeProvenanceDepth) {
    return undefined
  }
  if (isArrowFunction(node) && !isBlock(node.body)) {
    return resolveAttributeBag(node.body, context, visited, depth + 1)
  }
  if (!isArrowFunction(node) && !isFunctionExpression(node)) {
    return resolveAttributeBag(node, context, visited, depth + 1)
  }
  if (!isBlock(node.body)) {
    return undefined
  }
  return mergeAttributeBagEvidence(node.body.statements.map((statement) => (
    isReturnStatement(statement)
      ? resolveAttributeBag(statement.expression, context, visited, depth + 1)
      : undefined
  )))
}

function mergeAttributeBagEvidence(
  candidates: Array<AttributeBagEvidence | undefined>
): AttributeBagEvidence | undefined {
  const evidence = candidates.filter((candidate): candidate is AttributeBagEvidence => Boolean(candidate))
  if (evidence.length === 0) {
    return undefined
  }
  const excludedAttributes = new Set(evidence[0]!.excludedAttributes)
  for (const candidate of evidence.slice(1)) {
    for (const name of excludedAttributes) {
      if (!candidate.excludedAttributes.has(name)) {
        excludedAttributes.delete(name)
      }
    }
  }
  return { excludedAttributes }
}

function addExcludedAttributes(
  evidence: AttributeBagEvidence,
  names: string[]
): AttributeBagEvidence {
  return {
    excludedAttributes: new Set([...evidence.excludedAttributes, ...names])
  }
}

function withAttributeBagEvidence(
  target: AttributeForwardTarget,
  evidence: AttributeBagEvidence
): AttributeForwardTarget {
  const excludedAttributes = [...evidence.excludedAttributes].sort()
  return excludedAttributes.length > 0
    ? { ...target, excludedAttributes }
    : target
}

function isInRenderReturn(node: Node): boolean {
  let current = node.parent
  while (current) {
    if (current.kind === SyntaxKind.ReturnStatement || current.kind === SyntaxKind.ArrowFunction) {
      return true
    }
    if (current.kind === SyntaxKind.SourceFile || current.kind === SyntaxKind.VariableDeclaration) {
      return false
    }
    current = current.parent
  }
  return false
}

function hasVNodeAncestor(node: Node, sourceFile: SourceFile): boolean {
  let current = node.parent
  while (current && current.kind !== SyntaxKind.ReturnStatement && current.kind !== SyntaxKind.ArrowFunction) {
    if (isVNodeCall(current, sourceFile)) {
      return true
    }
    current = current.parent
  }
  return false
}

function getTargetText(node: Node | undefined, sourceFile: SourceFile): string | undefined {
  if (!node) {
    return undefined
  }
  if (isIdentifier(node)) {
    return node.text
  }
  return node.getText(sourceFile)
}

function readNativeAttributes(sourceFile: SourceFile | undefined): Map<string, string[]> {
  if (!sourceFile) {
    return new Map()
  }
  const interfaces = new Map<string, InterfaceDeclaration>()
  for (const statement of sourceFile.statements) {
    if (isInterfaceDeclaration(statement)) {
      interfaces.set(statement.name.text, statement)
    }
  }
  const tagMap = interfaces.get('HTMLElementTagNameMap')
  if (!tagMap) {
    return new Map()
  }

  const result = new Map<string, string[]>()
  for (const member of tagMap.members) {
    if (!isPropertySignatureDeclaration(member) || !member.type) {
      continue
    }
    const tag = getPropertyName(member.name, sourceFile)
    const interfaceName = member.type.getText(sourceFile)
    if (!tag || !interfaces.has(interfaceName)) {
      continue
    }
    result.set(tag, [...collectInterfaceProperties(interfaceName, interfaces, sourceFile)].sort())
  }
  return result
}

function collectInterfaceProperties(
  name: string,
  interfaces: Map<string, InterfaceDeclaration>,
  sourceFile: SourceFile,
  visited = new Set<string>()
): Set<string> {
  if (visited.has(name)) {
    return new Set()
  }
  visited.add(name)
  const declaration = interfaces.get(name)
  const properties = new Set<string>()
  if (!declaration) {
    return properties
  }

  for (const member of declaration.members) {
    if (!isPropertySignatureDeclaration(member) || member.getText(sourceFile).startsWith('readonly ')) {
      continue
    }
    const propertyName = getPropertyName(member.name, sourceFile)
    if (propertyName) {
      properties.add(propertyName)
      if (propertyName === 'htmlFor') {
        properties.add('for')
      }
    }
  }
  for (const clause of declaration.heritageClauses ?? []) {
    for (const type of clause.types) {
      const parentName = type.expression.getText(sourceFile)
      for (const property of collectInterfaceProperties(parentName, interfaces, sourceFile, visited)) {
        properties.add(property)
      }
    }
  }
  return properties
}

function getPropertyName(node: Node, sourceFile: SourceFile): string | undefined {
  if ('text' in node && typeof node.text === 'string') {
    return node.text
  }
  const text = node.getText(sourceFile)
  return text.match(/^['"](.*)['"]$/)?.[1] ?? text
}

function resolveDomDeclarationPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const packageRoot = dirname(require.resolve('typescript/package.json'))
    const platformPackage = `typescript-${process.platform}-${process.arch}`
    return [
      join(packageRoot, 'lib', 'lib.dom.d.ts'),
      join(dirname(packageRoot), '@typescript', platformPackage, 'lib', 'lib.dom.d.ts')
    ].find(existsSync)
  } catch {
    return undefined
  }
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function mergeRuntimeFallthrough(
  existing: FallthroughContract | undefined,
  next: FallthroughContract
): FallthroughContract {
  if (!existing) {
    return next
  }
  const targets = uniqueTargets([
    ...(existing.attributeTargets ?? []),
    ...(next.attributeTargets ?? [])
  ])
  return {
    attributes: targets.length > 0
      ? 'unknown'
      : existing.attributes === 'closed' && next.attributes === 'closed'
        ? 'closed'
        : 'unknown',
    listeners: 'unknown',
    attributeTargets: targets
  }
}

function mergeRuntimeProps(
  existing: Map<string, PropContract> | undefined,
  next: Map<string, PropContract>
): Map<string, PropContract> {
  const merged = new Map(existing ?? [])
  for (const [name, value] of next) {
    const previous = merged.get(name)
    merged.set(name, previous ? mergeRuntimePropContract(previous, value) : value)
  }
  return merged
}

function mergeRuntimePropContract(first: PropContract, second: PropContract): PropContract {
  const required = first.required === true || second.required === true
    ? true
    : first.required === false || second.required === false
      ? false
      : first.required ?? second.required

  const types = [
    ...(first.types ?? []),
    ...(second.types ?? []).filter((type) => !(first.types ?? []).some((candidate) => (
      candidate.kind === type.kind && candidate.value === type.value
    )))
  ]

  const merged: PropContract = { name: first.name || second.name }
  if (required !== undefined) {
    merged.required = required
  }
  if (types.length > 0) {
    merged.types = types
  }
  return merged
}

function uniqueTargets(targets: AttributeForwardTarget[]): AttributeForwardTarget[] {
  const unique = new Map<string, AttributeForwardTarget>()
  for (const target of targets) {
    unique.set(`${target.kind}:${target.name}:${target.file}:${target.excludedAttributes?.join(',') ?? ''}`, target)
  }
  return [...unique.values()]
}

function uniqueSources(sources: ContractProvenance[]): ContractProvenance[] {
  const unique = new Map(sources.map((source) => [`${source.source}:${source.path}`, source]))
  return [...unique.values()]
}

import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { babelParse, extractIdentifiers, walkIdentifiers, type SFCDescriptor, type SFCScriptBlock } from '@vue/compiler-sfc'
import type { EvidenceFile } from '../types.js'
import type { ComponentContract, EventContract } from './types.js'
import { parseRuntimeSfc } from './runtime-sfc.js'
import { readMappedRuntimeEntry } from './runtime-bundle.js'

type ScriptNode = { type: string; [key: string]: unknown }
type ModelContract = NonNullable<ComponentContract['vue2Model']>
type SfcStatement = NonNullable<SFCScriptBlock['scriptAst']>[number]
const instanceOptions = new Set([
  'data', 'provide', 'render', 'beforeCreate', 'created', 'beforeMount', 'mounted',
  'beforeUpdate', 'updated', 'activated', 'deactivated', 'beforeDestroy', 'destroyed',
  'beforeUnmount', 'unmounted', 'errorCaptured', 'renderTracked', 'renderTriggered', 'serverPrefetch'
])

export interface RuntimeInteractionEvidence {
  events: Map<string, EventContract>
  vue2Model: ModelContract | null
  interactionSources: string[]
}

export interface RuntimeOptionEvidence extends RuntimeInteractionEvidence {
  name?: string
  propsOptions: ScriptNode[]
  slots: Map<string, { name: string }>
  dynamicSlots: boolean
}

export interface RuntimePublicComponent extends RuntimeOptionEvidence {
  file: string
  identity: string
  exportName: string
  descriptor?: SFCDescriptor
}

interface ModelModule {
  file: string
  body: ScriptNode[]
  scriptSetupBody?: ScriptNode[]
  shadowedBindings?: ReadonlySet<string>
  unstableBindings?: Set<string>
  staticExports?: Map<string, ScriptNode>
  descriptor?: SFCDescriptor
}

type LoadModelModule = (specifier: string, importer: string) => Promise<ModelModule | undefined>

export function createRuntimeInteractionReader(files: readonly EvidenceFile[]) {
  const available = new Set(files.map(file => file.path))
  const modules = new Map<string, Promise<ModelModule | undefined>>()
  const load: LoadModelModule = async (specifier, importer) => {
    if (!specifier.startsWith('.') || /[?#]/.test(specifier)) return undefined
    const base = resolve(dirname(importer), specifier)
    const file = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'].map(extension => base + extension),
      join(base, 'index.ts'), join(base, 'index.js')].find(candidate => available.has(candidate))
    if (!file) return undefined
    let module = modules.get(file)
    if (!module) {
      module = readFile(file, 'utf8').then(source => parseModelModule(source, file))
        .catch(() => undefined)
      modules.set(file, module)
    }
    return module
  }
  return {
    readSfc: (descriptor: SFCDescriptor, file: string) => readSfcInteractions(descriptor, file, load),
    readModule: async (source: string, file: string): Promise<RuntimeOptionEvidence | undefined> => {
      const module = parseModelModule(source, file)
      if (!module) return undefined
      const value = asNode(module.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration)
      const resolved = value && await resolveStaticValue(value, module, load, new Set(), new Set())
      if (!resolved) return undefined
      const name = literalString(asNode(effectiveOption(resolved.value, 'name')?.value))
      if (!name) return undefined
      return { name, ...await readOptionEvidence(resolved.value, resolved.module, load) }
    },
    readPublicComponents: async (entries: readonly EvidenceFile[], packageRoot: string): Promise<RuntimePublicComponent[]> => {
      const result: RuntimePublicComponent[] = []
      for (const entry of entries) {
        let module = await load(`./${entry.path.split('/').pop()!}`, entry.path)
        if (!module) continue
        let names = await exportedNames(module, load, new Set())
        const entrySources = [entry.path]
        if (!names.size) {
          const mapped = await readMappedRuntimeEntry(entry, packageRoot, available)
          if (!mapped) continue
          module = parseModelModule(mapped.source, mapped.file)
          if (!module) continue
          modules.set(mapped.file, Promise.resolve(module))
          entrySources.push(mapped.mapFile, mapped.file)
          names = await exportedNames(module, load, new Set())
          if (mapped.defaultOnly) names = new Set(names.has('default') ? ['default'] : [])
        }
        for (const name of names) {
          const sources = new Set<string>(entrySources)
          const resolved = await resolveExport(module, name, load, sources, new Set())
          if (!resolved || !isComponentOptions(resolved.value, resolved.module)) continue
          const evidence = await readOptionEvidence(resolved.value, resolved.module, load)
          result.push({
            ...evidence,
            name: literalString(asNode(effectiveOption(resolved.value, 'name')?.value)),
            file: resolved.module.file,
            identity: `${resolved.module.file}:${resolved.value.start ?? 'sfc'}`,
            exportName: name === 'default' && entry.entry && entry.entry !== '.' ? entry.entry : name,
            descriptor: resolved.module.descriptor,
            interactionSources: [...new Set([...sources, ...evidence.interactionSources])]
          })
        }
      }
      return result
    }
  }
}

interface ResolvedValue {
  value: ScriptNode
  module: ModelModule
}

function parseModelModule(source: string, file: string): ModelModule | undefined {
  if (extname(file) !== '.vue') {
    const module: ModelModule = { file, body: parseStatements(source, scriptLanguage(file)) }
    if (module.body.some(statement => statement.type.startsWith('Export'))
      || declaresBinding(module.body, 'module') || declaresBinding(module.body, 'exports')) return module
    const body: ScriptNode[] = []
    const exports = new Map<string, ScriptNode>()
    for (const statement of module.body) {
      const assignment = statement.type === 'ExpressionStatement' ? asNode(statement.expression) : undefined
      const left = asNode(assignment?.left)
      const object = asNode(left?.object)
      const property = left?.computed ? literalString(asNode(left.property)) : exportName(asNode(left?.property))
      const name = left?.type === 'MemberExpression' && object?.type === 'Identifier'
        ? object.name === 'module' && property === 'exports' ? 'default'
          : object.name === 'exports' ? property : undefined
        : undefined
      const value = asNode(assignment?.right)
      if (assignment?.type === 'AssignmentExpression' && assignment.operator === '=' && name
        && value && ['ObjectExpression', 'Identifier'].includes(value.type)) {
        exports.set(name, value)
        continue
      }
      let usesExports = false
      visit(statement, node => {
        if (node.type === 'Identifier' && (node.name === 'module' || node.name === 'exports')) usesExports = true
      })
      if (usesExports) return module
      body.push(statement)
    }
    if (!exports.size || (exports.has('default') && exports.size > 1)) return module
    return { ...module, body, staticExports: exports }
  }
  const { descriptor, errors } = parseRuntimeSfc(source, file)
  if (errors.length || descriptor.script?.src || descriptor.scriptSetup?.src) return undefined
  const module = sfcModelModule(descriptor, file)
  // Aliased options combined with script setup require proving which options the compiler replaces.
  if (descriptor.script && descriptor.scriptSetup && !componentOptions(module.body)) return undefined
  return { ...module, descriptor }
}

function exportName(node: ScriptNode | undefined): string | undefined {
  return node?.type === 'Identifier' ? String(node.name) : literalString(node)
}

async function exportedNames(module: ModelModule, load: LoadModelModule, active: Set<string>): Promise<Set<string>> {
  if (active.has(module.file) || active.size >= 32) return new Set()
  active.add(module.file)
  const names = new Set<string>(module.staticExports?.keys())
  try {
    for (const statement of module.body) {
      if (statement.type === 'ExportDefaultDeclaration') names.add('default')
      if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type') {
        for (const binding of nodes(statement.specifiers)) {
          const name = exportName(asNode(binding.exported))
          if (name && binding.exportKind !== 'type') names.add(name)
        }
        const declaration = asNode(statement.declaration)
        if (declaration?.type === 'VariableDeclaration') {
          for (const binding of nodes(declaration.declarations)) {
            const name = exportName(asNode(binding.id))
            if (name) names.add(name)
          }
        }
      }
      if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
        const specifier = literalString(asNode(statement.source))
        const imported = specifier && await load(specifier, module.file)
        if (imported) for (const name of await exportedNames(imported, load, active)) {
          if (name !== 'default') names.add(name)
        }
      }
    }
    if (module.descriptor && !module.descriptor.script) names.add('default')
    return names
  } finally {
    active.delete(module.file)
  }
}

async function resolveExport(
  module: ModelModule, name: string, load: LoadModelModule, sources: Set<string>, active: Set<string>
): Promise<ResolvedValue | undefined> {
  const key = `${module.file}:export:${name}`
  if (active.has(key) || active.size >= 32) return undefined
  active.add(key)
  sources.add(module.file)
  try {
    const exported = module.staticExports?.get(name)
    if (exported) return await resolveStaticValue(exported, module, load, sources, active)
    for (const statement of module.body) {
      if (statement.type === 'ExportDefaultDeclaration' && name === 'default') {
        const value = asNode(statement.declaration)
        return value && await resolveStaticValue(value, module, load, sources, active)
      }
      if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') continue
      const declaration = asNode(statement.declaration)
      if (declaration?.type === 'VariableDeclaration'
        && nodes(declaration.declarations).some(binding => exportName(asNode(binding.id)) === name)) {
        return await resolveStaticValue({ type: 'Identifier', name }, module, load, sources, active)
      }
      const binding = nodes(statement.specifiers).find(binding => exportName(asNode(binding.exported)) === name && binding.exportKind !== 'type')
      if (!binding) continue
      const local = exportName(asNode(binding.local))
      const specifier = literalString(asNode(statement.source))
      if (!local) return undefined
      if (!specifier) return await resolveStaticValue({ type: 'Identifier', name: local }, module, load, sources, active)
      const imported = await load(specifier, module.file)
      return imported && await resolveExport(imported, local, load, sources, active)
    }
    if (name === 'default' && module.descriptor && !module.descriptor.script) {
      return { value: { type: 'ObjectExpression', properties: [] }, module }
    }
    if (name === 'default') return undefined
    let result: ResolvedValue | undefined
    for (const statement of module.body) {
      if (statement.type !== 'ExportAllDeclaration' || statement.exportKind === 'type') continue
      const specifier = literalString(asNode(statement.source))
      const imported = specifier && await load(specifier, module.file)
      if (!imported) return undefined
      if (!(await exportedNames(imported, load, new Set())).has(name)) continue
      const candidate = await resolveExport(imported, name, load, sources, active)
      if (!candidate) return undefined
      if (result && (result.module.file !== candidate.module.file || result.value !== candidate.value)) return undefined
      result = candidate
    }
    return result
  } finally {
    active.delete(key)
  }
}

async function resolveStaticValue(
  value: ScriptNode, module: ModelModule, load: LoadModelModule | undefined, sources: Set<string>, active: Set<string>
): Promise<ResolvedValue | undefined> {
  if (['ObjectExpression', 'ArrayExpression'].includes(value.type)) return { value, module }
  const options = unwrapDefineComponent(value, module)
  if (options) return { value: options, module }
  if (value.type !== 'Identifier' || typeof value.name !== 'string'
    || module.shadowedBindings?.has(value.name) || unstableOptionBindings(module).has(value.name)) return undefined
  const key = `${module.file}:binding:${value.name}`
  if (active.has(key) || active.size >= 32) return undefined
  active.add(key)
  try {
    const declarations = module.body.flatMap(statement => {
      const declaration = statement.type === 'ExportNamedDeclaration' ? asNode(statement.declaration) : statement
      return declaration?.type === 'VariableDeclaration'
        ? nodes(declaration.declarations).filter(binding => asNode(binding.id)?.name === value.name) : []
    })
    if (declarations.length > 1) return undefined
    const initializer = asNode(declarations[0]?.init)
    if (initializer) return await resolveStaticValue(initializer, module, load, sources, active)
    for (const statement of module.body) {
      if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
      const binding = nodes(statement.specifiers).find(binding => asNode(binding.local)?.name === value.name)
      const name = binding?.type === 'ImportDefaultSpecifier' ? 'default'
        : binding?.type === 'ImportSpecifier' && binding.importKind !== 'type' ? exportName(asNode(binding.imported)) : undefined
      const specifier = literalString(asNode(statement.source))
      if (!name || !specifier || !load) continue
      const imported = await load(specifier, module.file)
      return imported && await resolveExport(imported, name, load, sources, active)
    }
    return undefined
  } finally {
    active.delete(key)
  }
}

function isComponentOptions(options: ScriptNode, module: ModelModule): boolean {
  if (options.type !== 'ObjectExpression') return false
  if (module.descriptor) return true
  // A named utility/options object is not by itself evidence of a Vue component.
  return ['render', 'template', 'setup'].some(name => effectiveOption(options, name) !== undefined)
}

async function readOptionEvidence(options: ScriptNode, module: ModelModule, load: LoadModelModule | undefined): Promise<RuntimeOptionEvidence> {
  const evidence = await readOptionsInteractions(options, module, load)
  const sources = new Set(evidence.interactionSources)
  const layers = await resolveOptionLayers(options, module, load, sources, new Set())
  const propsOptions: ScriptNode[] = []
  let render: ScriptNode | undefined
  for (const layer of layers) {
    if (!layer) {
      propsOptions.length = 0
      render = undefined
      continue
    }
    render = effectiveOption(layer.value, 'render') ?? render
    const props = propertyValue(layer.value, 'props')
    if (!props) continue
    const resolved = await resolveStaticValue(props, layer.module, load, sources, new Set())
    if (resolved) {
      if (nodes(resolved.value.properties).some(property => property.type === 'SpreadElement' || property.computed)) {
        propsOptions.length = 0
      }
      propsOptions.push(resolved.value)
    } else propsOptions.length = 0
  }
  const slots = new Map<string, { name: string }>()
  let dynamicSlots = false
  const fn = render?.type === 'ObjectMethod' ? render : asNode(render?.value)
  const body = fn && ['ObjectMethod', 'FunctionExpression'].includes(fn.type) ? asNode(fn.body) : undefined
  if (body) visit(body, node => {
    if (node.type !== 'MemberExpression') return
    const object = asNode(node.object)
    if (object?.type !== 'MemberExpression' || asNode(object.object)?.type !== 'ThisExpression') return
    const bag = object.computed ? literalString(asNode(object.property)) : asNode(object.property)?.name
    if (bag !== '$slots' && bag !== '$scopedSlots') return
    const name = node.computed ? literalString(asNode(node.property)) : exportName(asNode(node.property))
    if (name) slots.set(name, { name })
    else dynamicSlots = true
  }, true)
  return { ...evidence, propsOptions, slots, dynamicSlots, interactionSources: [...sources] }
}

export async function readSfcInteractions(
  descriptor: SFCDescriptor,
  file = '',
  load?: LoadModelModule
): Promise<RuntimeOptionEvidence> {
  const events = new Map<string, EventContract>()
  let interactionSources: string[] = []
  let propsOptions: ScriptNode[] = []
  let slots = new Map<string, { name: string }>()
  let dynamicSlots = false
  const add = (name: string | undefined): void => {
    if (name) events.set(name, { name, source: 'emit', signatures: [] })
  }
  const module = sfcModelModule(descriptor, file)
  let vue2Model: ModelContract | null = descriptor.script ? null : { prop: 'value', event: 'input' }
  if (descriptor.script && !descriptor.script.src && (!descriptor.scriptSetup || componentOptions(module.body))) {
    const value = asNode(module.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration)
    const resolved = value && await resolveStaticValue(value, module, load, new Set(), new Set())
    if (resolved) {
      const evidence = await readOptionEvidence(resolved.value, resolved.module, load)
      propsOptions = evidence.propsOptions
      slots = evidence.slots
      dynamicSlots = evidence.dynamicSlots
      vue2Model = evidence.vue2Model
      interactionSources = evidence.interactionSources
      for (const name of evidence.events.keys()) add(name)
    }
  }
  const setupEmits = findSetupEmits(module.scriptSetupBody ?? [])
  if (setupEmits) readDeclaredEvents(nodes(setupEmits.arguments)[0], add)
  visitTemplate(descriptor.template?.ast, add, declaresBinding(module.scriptSetupBody ?? [], '$emit'))
  return { events, vue2Model, interactionSources, propsOptions, slots, dynamicSlots }
}

function findSetupEmits(body: ScriptNode[]): ScriptNode | undefined {
  for (const statement of body) {
    const expressions = statement.type === 'ExpressionStatement' ? [asNode(statement.expression)]
      : statement.type === 'VariableDeclaration' ? nodes(statement.declarations).map(declaration => asNode(declaration.init)) : []
    for (const expression of expressions) {
      if (expression?.type === 'CallExpression' && asNode(expression.callee)?.name === 'defineEmits') return expression
    }
  }
  return undefined
}

function sfcModelModule(descriptor: SFCDescriptor, file: string): ModelModule {
  const body = descriptor.script && !descriptor.script.src
    ? parseStatements(descriptor.script.content, descriptor.script.lang) : []
  const scriptSetupBody = descriptor.scriptSetup && !descriptor.scriptSetup.src
    ? parseStatements(descriptor.scriptSetup.content, descriptor.scriptSetup.lang) : undefined
  const options = componentOptions(body)
  if (scriptSetupBody && options) {
    const emits = findSetupEmits(scriptSetupBody)
    const properties = nodes(options.properties).filter(property => (
      propertyName(property) !== 'setup' && (!emits || propertyName(property) !== 'emits')
    ))
    if (emits) properties.push({
      type: 'ObjectProperty', key: { type: 'Identifier', name: 'emits' },
      value: nodes(emits.arguments)[0] ?? { type: 'ArrayExpression', elements: [] }
    })
    const exported = body.find(statement => statement.type === 'ExportDefaultDeclaration')!
    exported.declaration = { ...options, properties }
  }
  return { file, body, ...(scriptSetupBody ? { scriptSetupBody } : {}) }
}

function declaresBinding(body: ScriptNode[], name: string): boolean {
  return body.some(statement => {
    const bindings = statement.type === 'VariableDeclaration' ? nodes(statement.declarations).map(declaration => asNode(declaration.id))
      : statement.type === 'ImportDeclaration' ? nodes(statement.specifiers).map(specifier => asNode(specifier.local))
        : [asNode(statement.id)]
    return bindings.some(binding => binding && extractIdentifiers(binding as SfcStatement).some(identifier => identifier.name === name))
  })
}

function parseStatements(source: string, lang?: string): ScriptNode[] {
  if (lang && !['js', 'jsx', 'ts', 'tsx'].includes(lang)) return []
  try {
    return babelParse(source, {
      sourceType: 'module',
      plugins: [...(lang === 'ts' || lang === 'tsx' ? ['typescript' as const] : []), 'jsx']
    }).program.body as unknown as ScriptNode[]
  } catch {
    return []
  }
}

function componentOptions(body: ScriptNode[]): ScriptNode | undefined {
  const declaration = asNode(body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration)
  return declaration?.type === 'ObjectExpression' ? declaration : unwrapDefineComponent(declaration, { file: '', body })
}

function scriptLanguage(file: string): string {
  const extension = extname(file).slice(1)
  return extension === 'ts' || extension === 'tsx' ? extension : 'js'
}

function unwrapDefineComponent(value: ScriptNode | undefined, module: ModelModule): ScriptNode | undefined {
  if (value?.type !== 'CallExpression' || nodes(value.arguments).length !== 1) return undefined
  const callee = asNode(value.callee)
  if (callee?.type !== 'Identifier' || module.shadowedBindings?.has(String(callee.name))) return undefined
  const imported = module.body.some(statement => statement.type === 'ImportDeclaration'
    && statement.importKind !== 'type' && literalString(asNode(statement.source)) === 'vue'
    && nodes(statement.specifiers).some(binding => binding.type === 'ImportSpecifier' && binding.importKind !== 'type'
      && asNode(binding.imported)?.name === 'defineComponent' && asNode(binding.local)?.name === callee.name))
  const options = nodes(value.arguments)[0]
  return imported && options?.type === 'ObjectExpression' ? options : undefined
}

async function readOptionsInteractions(
  options: ScriptNode,
  module: ModelModule,
  load: LoadModelModule | undefined
): Promise<RuntimeInteractionEvidence> {
  const sources = new Set<string>()
  const layers = await resolveOptionLayers(options, module, load, sources, new Set())
  const events = new Map<string, EventContract>()
  const functions = new Map<string, ScriptNode>()
  const add = (name: string | undefined): void => {
    if (name) events.set(name, { name, source: 'emit', signatures: [] })
  }
  let model: ModelContract | null | undefined
  for (const layer of layers) {
    if (!layer) {
      events.clear()
      functions.clear()
      model = null
      continue
    }
    // Object duplicates replace before Vue's inheritance strategies apply.
    const properties = new Map(nodes(layer.value.properties).map(property => [propertyName(property), property]))
    if (properties.has('model')) model = readModelOption(propertyValue(layer.value, 'model'))
    readDeclaredEvents(propertyValue(layer.value, 'emits'), add)
    for (const [name, property] of properties) {
      if (name === 'methods' || name === 'computed') {
        const members = asNode(property.value)
        if (members?.type !== 'ObjectExpression'
          || nodes(members.properties).some(member => member.type === 'SpreadElement' || member.computed)) {
          for (const key of functions.keys()) if (key.startsWith(`${name}:`)) functions.delete(key)
          continue
        }
        for (const method of nodes(members.properties)) functions.set(`${name}:${propertyName(method)}`, method)
      } else if (name === 'watch') {
        for (const watcher of effectiveProperties(asNode(property.value)).values()) readInstanceFunction(watcher, add)
      } else if (name === 'render') {
        functions.set('render', property)
      } else if (name && instanceOptions.has(name)) {
        readInstanceFunction(property, add)
      }
    }
  }
  // Vue 3 does not execute inherited setup; framework-agnostic evidence cannot assume Vue 2 merging.
  const setup = effectiveOption(options, 'setup')
  if (setup) readSetupEvents(setup, add)
  for (const fn of functions.values()) readInstanceFunction(fn, add)
  return { events, vue2Model: model === undefined ? { prop: 'value', event: 'input' } : model, interactionSources: [...sources] }
}

function readModelOption(model: ScriptNode | undefined): ModelContract | null {
  if (model?.type !== 'ObjectExpression'
    || nodes(model.properties).some(property => property.type !== 'ObjectProperty' || property.computed === true)) return null
  const prop = propertyValue(model, 'prop')
  const event = propertyValue(model, 'event')
  const propName = prop ? literalString(prop) : 'value'
  const eventName = event ? literalString(event) : 'input'
  return propName && eventName ? { prop: propName, event: eventName } : null
}

function isVueComponentRegistration(call: ScriptNode, module: ModelModule): boolean {
  if (call.type !== 'CallExpression' || nodes(call.arguments).length !== 2 || !literalString(nodes(call.arguments)[0])) return false
  const callee = asNode(call.callee)
  if (callee?.type !== 'MemberExpression' || callee.computed || asNode(callee.property)?.name !== 'component') return false
  const receiver = asNode(callee.object)
  const globalVue = receiver?.type === 'MemberExpression' && !receiver.computed && asNode(receiver.property)?.name === 'Vue'
    && asNode(receiver.object)?.name === 'window' && !declaresBinding(module.body, 'window')
  const importedVue = receiver?.type === 'Identifier' && module.body.some(statement => statement.type === 'ImportDeclaration'
    && statement.importKind !== 'type' && literalString(asNode(statement.source)) === 'vue'
    && nodes(statement.specifiers).some(binding => binding.type === 'ImportDefaultSpecifier'
      && asNode(binding.local)?.name === receiver.name))
  if (!globalVue && !importedVue) return false
  const binding = globalVue ? 'window' : receiver?.name
  let moduleScope = false
  let modified = false
  for (const statement of module.body) visit(statement, value => {
    if (value === call) moduleScope = true
    let target = value.type === 'AssignmentExpression' ? asNode(value.left)
      : value.type === 'UpdateExpression' || (value.type === 'UnaryExpression' && value.operator === 'delete')
        ? asNode(value.argument) : undefined
    while (target?.type === 'MemberExpression') target = asNode(target.object)
    if (target?.type === 'Identifier' && target.name === binding) modified = true
  }, true)
  return moduleScope && !modified
}

function unstableOptionBindings(module: ModelModule): ReadonlySet<string> {
  if (module.unstableBindings) return module.unstableBindings
  const unstable = new Set<string>()
  const aliases = new Map<string, Set<string>>()
  const addTarget = (target: ScriptNode | undefined, bindings = unstable): void => {
    if (!target) return
    if (target.type === 'Identifier' && typeof target.name === 'string') bindings.add(target.name)
    else if (target.type === 'MemberExpression' || target.type === 'OptionalMemberExpression') addTarget(asNode(target.object), bindings)
    else if (target.type === 'RestElement') addTarget(asNode(target.argument), bindings)
    else if (target.type === 'AssignmentPattern') addTarget(asNode(target.left), bindings)
    else if (target.type === 'ArrayPattern') for (const element of nodes(target.elements)) addTarget(element, bindings)
    else if (target.type === 'ObjectPattern') {
      for (const property of nodes(target.properties)) addTarget(asNode(property.value ?? property.argument), bindings)
    }
  }
  const addReferences = (value: ScriptNode, bindings: Set<string>): void => {
    walkIdentifiers(value as SfcStatement, (identifier, _parent, _stack, referenced, local) => {
      if (referenced && !local) bindings.add(identifier.name)
    })
  }
  for (const statement of [...module.body, ...(module.scriptSetupBody ?? [])]) visit(statement, node => {
    if (node.type === 'VariableDeclarator' || node.type === 'AssignmentExpression' || node.type === 'FunctionDeclaration') {
      const value = node.type === 'FunctionDeclaration' ? node : asNode(node.init ?? node.right)
      const bindings = new Set<string>()
      addTarget(asNode(node.id ?? node.left), bindings)
      if (value && bindings.size) {
        const references = new Set<string>()
        addReferences(value, references)
        for (const binding of bindings) {
          const dependencies = aliases.get(binding) ?? new Set<string>()
          for (const reference of references) dependencies.add(reference)
          aliases.set(binding, dependencies)
        }
      }
    }
    if (node.type === 'AssignmentExpression' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') addTarget(asNode(node.left))
    else if (node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) addTarget(asNode(node.argument))
    else if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      if (unwrapDefineComponent(node, module) || isVueComponentRegistration(node, module)) return
      // Passing options to arbitrary code no longer proves their original shape.
      for (const argument of nodes(node.arguments)) addReferences(argument, unstable)
      if (asNode(node.callee)?.type === 'MemberExpression') addTarget(asNode(node.callee))
    }
  })
  // Writes and escapes through aliases invalidate their original option objects.
  const pending = [...unstable]
  while (pending.length) {
    for (const dependency of aliases.get(pending.pop()!) ?? []) {
      if (unstable.has(dependency)) continue
      unstable.add(dependency)
      pending.push(dependency)
    }
  }
  module.unstableBindings = unstable
  return unstable
}

async function resolveOptionLayers(
  value: ScriptNode,
  module: ModelModule,
  load: LoadModelModule | undefined,
  sources: Set<string>,
  active: Set<ScriptNode>,
  factoryReturn = false
): Promise<Array<ResolvedValue | null>> {
  if (active.has(value) || active.size >= 32) return [null]
  active.add(value)
  try {
    if (value.type === 'Identifier') {
      if (typeof value.name === 'string' && module.shadowedBindings?.has(value.name)) return [null]
      if (typeof value.name === 'string' && unstableOptionBindings(module).has(value.name)) return [null]
      if (!factoryReturn && load) {
        const resolved = await resolveStaticValue(value, module, load, sources, new Set())
        if (resolved) return await resolveOptionLayers(resolved.value, resolved.module, load, sources, active)
      }
      for (const statement of module.body) {
        if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
          const declaration = nodes(statement.declarations).find(item => asNode(item.id)?.name === value.name)
          const initializer = asNode(declaration?.init)
          if (initializer) return await resolveOptionLayers(initializer, module, load, sources, active, factoryReturn)
        }
        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
        const binding = nodes(statement.specifiers).find(item => asNode(item.local)?.name === value.name)
        const specifier = literalString(asNode(statement.source))
        if (binding?.type !== 'ImportDefaultSpecifier' || !specifier || !load) continue
        const imported = await load(specifier, module.file)
        if (!imported) return [null]
        sources.add(imported.file)
        const declaration = asNode(imported.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration)
        return declaration ? await resolveOptionLayers(declaration, imported, load, sources, active, factoryReturn) : [null]
      }
      return [null]
    }
    if (factoryReturn) {
      if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(value.type)) return [null]
      const parameters = nodes(value.params)
      if (parameters.some(parameter => parameter.type !== 'Identifier')) return [null]
      const shadowedBindings = new Set(module.shadowedBindings)
      for (const parameter of parameters) {
        if (typeof parameter.name === 'string') shadowedBindings.add(parameter.name)
      }
      const name = asNode(value.id)?.name
      if (typeof name === 'string') shadowedBindings.add(name)
      const body = asNode(value.body)
      const statements = nodes(body?.body)
      const returned = body?.type === 'ObjectExpression' ? body
        : statements.length === 1 && statements[0]?.type === 'ReturnStatement'
          ? asNode(statements[0].argument)
          : undefined
      return returned ? await resolveOptionLayers(returned, { ...module, shadowedBindings }, load, sources, active) : [null]
    }
    if (value.type === 'CallExpression') {
      const options = unwrapDefineComponent(value, module)
      if (options) return await resolveOptionLayers(options, module, load, sources, active)
      const callee = asNode(value.callee)
      if (callee?.type !== 'Identifier'
        || nodes(value.arguments).some(argument => !['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(argument.type))) return [null]
      return await resolveOptionLayers(callee, module, load, sources, active, true)
    }
    if (value.type !== 'ObjectExpression') return [null]
    const properties = nodes(value.properties)
    let lastUnknown = -1
    for (let index = 0; index < properties.length; index++) {
      if (properties[index]!.type === 'SpreadElement' || properties[index]!.computed === true) lastUnknown = index
    }
    if (lastUnknown >= 0) {
      const remaining = { ...value, properties: properties.slice(lastUnknown + 1) }
      return [null, ...await resolveOptionLayers(remaining, module, load, sources, active)]
    }
    const inherited: Array<ResolvedValue | null> = []
    const base = propertyValue(value, 'extends')
    if (base) inherited.push(...await resolveOptionLayers(base, module, load, sources, active))
    const mixins = propertyValue(value, 'mixins')
    if (mixins) {
      if (mixins.type !== 'ArrayExpression') inherited.push(null)
      else for (const mixin of nodes(mixins.elements)) {
        inherited.push(...await resolveOptionLayers(mixin, module, load, sources, active))
      }
    }
    return [...inherited, { value, module }]
  } finally {
    active.delete(value)
  }
}

function readDeclaredEvents(value: ScriptNode | undefined, add: (name: string | undefined) => void): void {
  if (value?.type === 'ArrayExpression') {
    for (const item of nodes(value.elements)) add(literalString(item))
  } else if (value?.type === 'ObjectExpression') {
    for (const property of nodes(value.properties)) add(propertyName(property))
  }
}

function effectiveOption(options: ScriptNode, name: string): ScriptNode | undefined {
  const properties = nodes(options.properties)
  for (let index = properties.length - 1; index >= 0; index--) {
    const property = properties[index]!
    if (property.type === 'SpreadElement' || property.computed === true) return undefined
    if (propertyName(property) === name) return property
  }
  return undefined
}

function readSetupEvents(property: ScriptNode, add: (name: string | undefined) => void): void {
  const setup = property.type === 'ObjectMethod' ? property : asNode(property.value)
  if (!setup || !['ObjectMethod', 'FunctionExpression', 'ArrowFunctionExpression'].includes(setup.type)) return
  const context = nodes(setup.params)[1]
  const body = asNode(setup.body)
  if (!context || body?.type !== 'BlockStatement') return
  const emitter = context.type === 'ObjectPattern'
    ? asNode(nodes(context.properties).find(item => propertyName(item) === 'emit')?.value)
    : context
  if (emitter?.type !== 'Identifier' || typeof emitter.name !== 'string') return
  readEmitterCalls(body, emitter.name, context.type === 'Identifier', add)
}

function readEmitterCalls(body: ScriptNode, name: string, member: boolean, add: (name: string | undefined) => void): void {
  const names = new Set<string>()
  let unstable = false
  // Vue's walker handles lexical shadows; conservatively reject var declarations
  // because a branch-scoped walk cannot establish their function-wide hoisting.
  visit(body, node => {
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      for (const declaration of nodes(node.declarations)) {
        const id = asNode(declaration.id)
        if (id && extractIdentifiers(id as SfcStatement).some(identifier => identifier.name === name)) unstable = true
      }
    }
  })
  walkIdentifiers(body as SfcStatement, (identifier, parent, stack, referenced, local) => {
    if (identifier.name !== name || local || unstable) return
    if (stack.some(ancestor => ('id' in ancestor && ancestor.id?.type === 'Identifier' && ancestor.id.name === name))) return
    const written = stack.some(ancestor => {
      const target = ancestor.type === 'AssignmentExpression' || ancestor.type === 'ForInStatement' || ancestor.type === 'ForOfStatement'
        ? ancestor.left
        : ancestor.type === 'UpdateExpression' || (ancestor.type === 'UnaryExpression' && ancestor.operator === 'delete')
          ? ancestor.argument
          : undefined
      return target?.start != null && target.end != null && identifier.start != null
        && identifier.start >= target.start && identifier.start < target.end
    })
    if (written) {
      unstable = true
      return
    }
    if (!referenced) return
    const call = member ? stack[stack.length - 2] : parent
    if (member && (parent?.type !== 'MemberExpression' || parent.object !== identifier)) {
      unstable = true
      return
    }
    const isEmitter = !member || (parent?.type === 'MemberExpression'
      && (parent.computed ? parent.property.type === 'StringLiteral' && parent.property.value === 'emit'
        : parent.property.type === 'Identifier' && parent.property.name === 'emit'))
    if (!isEmitter) return
    if (call?.type !== 'CallExpression' || call.callee !== (member ? parent : identifier)) {
      unstable = true
      return
    }
    const event = call.arguments[0]
    if (event?.type === 'StringLiteral') names.add(event.value)
  }, true)
  if (!unstable) for (const event of names) add(event)
}

function readInstanceFunction(property: ScriptNode, add: (name: string | undefined) => void): void {
  const value = property.type === 'ObjectMethod' ? property : asNode(property.value)
  if (value?.type === 'ObjectExpression') {
    for (const accessor of effectiveProperties(value).values()) {
      if (['get', 'set', 'handler'].includes(propertyName(accessor) ?? '')) readInstanceFunction(accessor, add)
    }
    return
  }
  if (value?.type !== 'ObjectMethod' && value?.type !== 'FunctionExpression') return
  const body = asNode(value.body)
  if (!body) return
  visit(body, node => {
    const callee = asNode(node.callee)
    if (node.type === 'CallExpression' && callee?.type === 'MemberExpression'
      && asNode(callee.object)?.type === 'ThisExpression'
      && (callee.computed ? literalString(asNode(callee.property)) : asNode(callee.property)?.name) === '$emit') {
      add(literalString(nodes(node.arguments)[0]))
    }
  }, true)
}

interface TemplateDirective {
  type: number
  name?: string
  exp?: { content?: string }
  value?: { content?: string }
  forParseResult?: { value?: { content: string }; key?: { content: string }; index?: { content: string } }
}

function templateBindingShadowsEmitter(expression: string | undefined): boolean {
  if (!expression) return false
  const parameters = asNode(parseStatements(`(${expression}) => {}`)[0]?.expression)?.params
  return !parameters || nodes(parameters).some(parameter => (
    extractIdentifiers(parameter as SfcStatement).some(identifier => identifier.name === '$emit')
  ))
}

function visitTemplate(root: unknown, add: (name: string | undefined) => void, shadowed = false): void {
  if (!root || typeof root !== 'object') return
  const node = root as { props?: TemplateDirective[]; children?: unknown[] }
  const directives = node.props ?? []
  const loopShadowed = shadowed || directives.some(directive => directive.type === 7 && directive.name === 'for'
    && (!directive.forParseResult || [
      directive.forParseResult.value, directive.forParseResult.key, directive.forParseResult.index
    ].some(binding => templateBindingShadowsEmitter(binding?.content))))
  const childShadowed = loopShadowed || directives.some(directive => (
    directive.type === 7 && directive.name === 'slot' && templateBindingShadowsEmitter(directive.exp?.content)
  ) || (directive.type === 6 && ['slot-scope', 'scope'].includes(directive.name ?? '') && templateBindingShadowsEmitter(directive.value?.content)))
  if (!loopShadowed) for (const directive of directives) {
    if (directive.type !== 7 || directive.name !== 'on' || !directive.exp?.content) continue
    readEmitterCalls({ type: 'BlockStatement', body: parseStatements(directive.exp.content) }, '$emit', false, add)
  }
  for (const child of node.children ?? []) visitTemplate(child, add, childShadowed)
}

function visit(node: ScriptNode, callback: (node: ScriptNode) => void, instanceScope = false): void {
  if (instanceScope && ['FunctionExpression', 'FunctionDeclaration', 'ObjectMethod', 'ClassDeclaration', 'ClassExpression'].includes(node.type)) return
  callback(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'comments' || key.endsWith('Comments')) continue
    if (Array.isArray(value)) {
      for (const child of nodes(value)) visit(child, callback, instanceScope)
    } else {
      const child = asNode(value)
      if (child) visit(child, callback, instanceScope)
    }
  }
}

function effectiveProperties(object: ScriptNode | undefined): Map<string, ScriptNode> {
  const properties = new Map<string, ScriptNode>()
  if (object?.type !== 'ObjectExpression') return properties
  for (const property of nodes(object.properties)) {
    const name = propertyName(property)
    if (property.type === 'SpreadElement' || property.computed) properties.clear()
    else if (name !== undefined) properties.set(name, property)
  }
  return properties
}

function propertyValue(object: ScriptNode, name: string): ScriptNode | undefined {
  const properties = nodes(object.properties)
  for (let index = properties.length - 1; index >= 0; index--) {
    const property = properties[index]!
    if (propertyName(property) === name) return asNode(property.value)
  }
  return undefined
}

function propertyName(property: ScriptNode): string | undefined {
  if (property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod') return undefined
  const key = asNode(property.key)
  return property.computed === true ? literalString(key) : key?.type === 'Identifier' ? String(key.name) : literalString(key)
}

function literalString(node: ScriptNode | undefined): string | undefined {
  return node?.type === 'StringLiteral' && typeof node.value === 'string' ? node.value : undefined
}

function asNode(value: unknown): ScriptNode | undefined {
  return value && typeof value === 'object' && typeof (value as ScriptNode).type === 'string' ? value as ScriptNode : undefined
}

function nodes(value: unknown): ScriptNode[] {
  return Array.isArray(value) ? value.filter(item => asNode(item)) : []
}

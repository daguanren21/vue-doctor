import { resolveStaticValue } from './static-value.js'
import type { StaticKnowledge, StaticValue } from './types.js'

type Node = { type?: string; [key: string]: unknown }
const unknownKnowledge: StaticKnowledge = { complete: false }

/** Resolve literal structure without losing known fields beside runtime-only values. */
export function resolveStaticKnowledge(
  value: unknown,
  constants: ReadonlyMap<string, StaticKnowledge> = new Map(),
  shadowed: ReadonlySet<string> = new Set(),
  depth = 0
): StaticKnowledge {
  if (!value || typeof value !== 'object' || depth > 64) return unknownKnowledge
  const node = value as Node
  if (node.type === 'Identifier') return shadowed.has(String(node.name)) ? unknownKnowledge : constants.get(String(node.name)) ?? unknownKnowledge
  if (['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ChainExpression'].includes(node.type ?? '')) {
    return resolveStaticKnowledge(node.expression, constants, shadowed, depth + 1)
  }
  if (node.type === 'MemberExpression' && !node.optional) {
    const object = resolveStaticKnowledge(node.object, constants, shadowed, depth + 1)
    const property = node.property as Node | undefined
    const key = node.computed ? resolveStaticKnowledge(property, constants, shadowed, depth + 1).value : property?.name
    if (typeof key === 'string' || typeof key === 'number') {
      if (object.properties) return object.properties[key] ?? unknownKnowledge
      const index = Number(key)
      if (object.elements && Number.isSafeInteger(index) && index >= 0 && String(index) === String(key)) {
        return object.elements[index] ?? unknownKnowledge
      }
    }
    return unknownKnowledge
  }
  if (node.type === 'ObjectExpression') {
    const properties: Record<string, StaticKnowledge> = Object.create(null)
    let complete = true
    for (const property of (node.properties ?? []) as Node[]) {
      const keyNode = property.key as Node | undefined
      const key = keyNode?.type === 'Identifier' ? keyNode.name : keyNode?.value
      // Unknown keys/spreads may overwrite any earlier field. Later explicit fields remain valid.
      if (property.type !== 'Property' || property.computed || (typeof key !== 'string' && typeof key !== 'number') || key === '__proto__') {
        for (const previous of Object.keys(properties)) delete properties[previous]
        complete = false
        continue
      }
      const knowledge = property.kind !== 'init' || property.method ? unknownKnowledge : resolveStaticKnowledge(property.value, constants, shadowed, depth + 1)
      properties[key] = knowledge
      if (!knowledge.complete) complete = false
    }
    const result: StaticKnowledge = { properties, complete }
    if (complete) {
      const object: Record<string, StaticValue> = Object.create(null)
      for (const [key, knowledge] of Object.entries(properties)) object[key] = knowledge.value as StaticValue
      result.value = object
    }
    return result
  }
  if (node.type === 'ArrayExpression') {
    const elements: StaticKnowledge[] = []
    let spread = false
    for (const element of (node.elements ?? []) as Array<Node | null>) {
      if (element?.type === 'SpreadElement') { spread = true; break }
      elements.push(resolveStaticKnowledge(element, constants, shadowed, depth + 1))
    }
    const complete = !spread && elements.every((element) => element.complete)
    return { elements, complete, ...(complete ? { value: elements.map((element) => element.value as StaticValue) } : {}) }
  }
  const literal = resolveStaticValue(node)
  return literal === undefined ? unknownKnowledge : { value: literal, complete: true }
}

/** Top-level lexical consts only. No imports, calls, getter evaluation, or runtime execution. */
export function collectStaticConstants(program: unknown, additionalUsage?: unknown): ReadonlyMap<string, StaticKnowledge> {
  return collectLexicalConstants(program, additionalUsage)
}

/** Stable setup references include function declarations, whose callable objects can escape too. */
export function collectSetupBindings(program: unknown, additionalUsage?: unknown): ReadonlyMap<string, StaticKnowledge> {
  const functions = new Map<string, Node>()
  for (const statement of ((program as Node | undefined)?.body ?? []) as Node[]) {
    const id = statement.id as Node | undefined
    if (statement.type === 'FunctionDeclaration' && id?.type === 'Identifier') {
      functions.set(String(id.name), statement)
    }
  }
  return collectLexicalConstants(program, additionalUsage, undefined, undefined, functions)
}

function collectLexicalConstants(
  program: unknown,
  additionalUsage?: unknown,
  inherited: ReadonlyMap<string, StaticKnowledge> = new Map(),
  transparent: ReadonlySet<unknown> = new Set(),
  functions?: ReadonlyMap<string, Node>
): Map<string, StaticKnowledge> {
  const declarations = new Map<string, Node>()
  for (const statement of ((program as Node | undefined)?.body ?? []) as Node[]) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue
    for (const declaration of (statement.declarations ?? []) as Node[]) {
      const id = declaration.id as Node | undefined
      if (id?.type === 'Identifier') declarations.set(String(id.name), declaration)
    }
  }
  const aliases = new Map<string, Node>()
  const invalid = new Set<string>()
  const collectAliases = (node: Node) => {
    if (node.type !== 'VariableDeclarator') return
    const id = node.id as Node | undefined
    if (id?.type !== 'Identifier') return
    const name = String(id.name)
    if (aliases.has(name)) invalid.add(name)
    else aliases.set(name, node)
  }
  walk(program, collectAliases)
  walk(additionalUsage, collectAliases)
  const trackedNames = new Set([...inherited.keys(), ...aliases.keys(), ...(functions?.keys() ?? [])])
  const dependencies = new Map<string, Set<string>>()
  for (const [name, declaration] of aliases) {
    const referenced = new Set<string>()
    const initializer = declaration.init as Node | undefined
    // Capturing a binding in a new function does not alias that binding's callable object.
    // Reads, writes, and escapes inside the function are still inspected below.
    if (!['FunctionExpression', 'ArrowFunctionExpression'].includes(initializer?.type ?? '')) {
      walkReferences(initializer, (name) => { if (trackedNames.has(name)) referenced.add(name) })
    }
    dependencies.set(name, referenced)
  }
  const invalidateReferences = (value: unknown, skipCallResults = false) => walkReferences(value, (name) => {
    if (trackedNames.has(name)) invalid.add(name)
  }, false, skipCallResults)
  const inspect = (node: Node) => {
    if (transparent.has(node)) return
    if (node.type === 'VariableDeclarator') {
      const id = node.id as Node | undefined
      if (id?.type !== 'Identifier') {
        walkBindings(id, (name) => invalid.add(name))
        invalidateReferences(id)
        invalidateReferences(node.init)
      }
    }
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'CatchClause'].includes(node.type ?? '')) {
      walkBindings(node.params ?? node.param, (name) => invalid.add(name))
      const id = node.id as Node | undefined
      if (functions?.get(String(id?.name)) !== node) walkBindings(id, (name) => invalid.add(name))
      // Defaults and computed pattern keys can expose an outer object even when bindings differ.
      invalidateReferences(node.params ?? node.param)
    }
    if (node.type === 'ArrowFunctionExpression' && (node.body as Node | undefined)?.type !== 'BlockStatement' && !transparent.has(node.body)) {
      invalidateReferences(node.body, true)
    }
    if (['ReturnStatement', 'YieldExpression', 'AwaitExpression'].includes(node.type ?? '')) invalidateReferences(node.argument, true)
    if (['AssignmentExpression', 'UpdateExpression', 'ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(node.type ?? '')) invalidateReferences(node)
    if (node.type === 'UnaryExpression' && node.operator === 'delete') invalidateReferences(node.argument)
    if (node.type === 'VAttribute' && node.directive) {
      const key = node.key as { name?: { name?: string } } | undefined
      if (key?.name?.name === 'model') invalidateReferences(node.value)
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression' || node.type === 'TaggedTemplateExpression') {
      invalidateReferences(node.arguments ?? node.quasi)
      const callee = (node.callee ?? node.tag) as Node | undefined
      if (callee?.type !== 'Identifier') invalidateReferences(callee)
      if (callee?.type === 'Identifier' && callee.name === 'eval') for (const name of trackedNames) invalid.add(name)
    }
  }
  walk(program, inspect)
  walk(additionalUsage, inspect)
  // Aliases share mutable objects: uncertainty propagates both to the source and its dependents.
  let changed = true
  while (changed) {
    changed = false
    for (const [name, references] of dependencies) {
      if (!invalid.has(name) && ![...references].some((reference) => invalid.has(reference))) continue
      for (const related of [name, ...references]) {
        if (!invalid.has(related)) { invalid.add(related); changed = true }
      }
    }
  }
  const constants = new Map(inherited)
  // Local bindings shadow inherited values even before initialization (including TDZ).
  for (const statement of ((program as Node | undefined)?.body ?? []) as Node[]) {
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of (statement.declarations ?? []) as Node[]) {
        walkBindings(declaration.id, (name) => constants.delete(name))
      }
    } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
      constants.delete(String((statement.id as Node | undefined)?.name))
    }
  }
  for (const name of invalid) constants.delete(name)
  // Declaration order intentionally rejects forward references and TDZ-dependent evaluation.
  for (const [name, declaration] of declarations) {
    if (!invalid.has(name)) constants.set(name, resolveStaticKnowledge(declaration.init, constants))
  }
  for (const name of functions?.keys() ?? []) {
    if (!invalid.has(name)) constants.set(name, unknownKnowledge)
  }
  return constants
}

/** Only values explicitly returned by a statically shaped data/setup function reach the template. */
export function collectOptionsConstants(program: unknown, additionalUsage?: unknown): ReadonlyMap<string, StaticKnowledge> {
  const statements = ((program as Node | undefined)?.body ?? []) as Node[]
  const exported = statements.find((statement) => statement.type === 'ExportDefaultDeclaration')
  if (!exported) return new Map()
  const transparent = new Set<unknown>([exported])
  let options = exported.declaration as Node | undefined
  if (options?.type === 'CallExpression') {
    const callee = options.callee as Node | undefined
    const definesComponent = statements.some((statement) => statement.type === 'ImportDeclaration'
      && (statement.source as Node | undefined)?.value === 'vue'
      && ((statement.specifiers ?? []) as Node[]).some((specifier) => specifier.type === 'ImportSpecifier'
        && (specifier.imported as Node | undefined)?.name === 'defineComponent'
        && (specifier.local as Node | undefined)?.name === callee?.name))
    if (callee?.type !== 'Identifier' || !definesComponent || (options.arguments as unknown[])?.length !== 1) return new Map()
    transparent.add(options)
    options = (options.arguments as Node[])[0]
  }
  if (options?.type !== 'ObjectExpression') return new Map()
  const properties = new Map<string, Node>()
  for (const property of (options.properties ?? []) as Node[]) {
    const key = property.key as Node | undefined
    const name = key?.type === 'Identifier' ? key.name : key?.value
    // Unknown option keys, mixins and extends may inject lifecycle mutations or override setup/data.
    if (property.type !== 'Property' || property.computed || typeof name !== 'string' || ['mixins', 'extends'].includes(name)) return new Map()
    properties.set(name, property)
  }
  const factories = new Map<string, { body: Node; returned: unknown; parameters: unknown }>()
  for (const name of ['data', 'setup']) {
    const property = properties.get(name)
    if (!property) continue
    const factory = property.value as Node | undefined
    if (property.kind !== 'init' || !factory || !['FunctionExpression', 'ArrowFunctionExpression'].includes(factory.type ?? '') || factory.async || factory.generator) return new Map()
    const body = factory.body as Node | undefined
    if (!body) return new Map()
    if (body.type !== 'BlockStatement') {
      transparent.add(body)
      factories.set(name, { body: { body: [] }, returned: body, parameters: factory.params })
      continue
    }
    const statements = (body.body ?? []) as Node[]
    const last = statements.at(-1)
    if (last?.type !== 'ReturnStatement' || statements.slice(0, -1).some((statement) => !['VariableDeclaration', 'FunctionDeclaration', 'ExpressionStatement', 'EmptyStatement'].includes(statement.type ?? ''))) return new Map()
    transparent.add(last)
    factories.set(name, { body, returned: last.argument, parameters: factory.params })
  }
  const moduleConstants = collectLexicalConstants(program, undefined, undefined, transparent)
  const exposed = new Map<string, StaticKnowledge>()
  for (const [name, factory] of factories) {
    const inherited = new Map(moduleConstants)
    walkBindings(factory.parameters, (name) => inherited.delete(name))
    const locals = collectLexicalConstants(factory.body, undefined, inherited, transparent)
    const returned = resolveStaticKnowledge(factory.returned, locals)
    // Incomplete setup shapes can introduce arbitrary names and take precedence over data.
    if (name === 'setup' && !returned.complete) exposed.clear()
    for (const [key, knowledge] of Object.entries(returned.properties ?? {})) exposed.set(key, knowledge)
  }

  const invalid = new Set<string>()
  const invalidateInstance = (value: unknown) => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { for (const child of value) visit(child); return }
      const node = value as Node
      if (node.type === 'ThisExpression') { for (const name of exposed.keys()) invalid.add(name); return }
      if (node.type === 'MemberExpression') {
        let member = node
        while ((member.object as Node | undefined)?.type === 'MemberExpression') member = member.object as Node
        if ((member.object as Node | undefined)?.type === 'ThisExpression') {
          const property = member.property as Node | undefined
          const name = member.computed ? property?.type === 'Literal' ? property.value : undefined : property?.name
          if (typeof name === 'string') invalid.add(name)
          else for (const name of exposed.keys()) invalid.add(name)
          return
        }
      }
      for (const [key, child] of Object.entries(node)) if (!['parent', 'tokens', 'comments', 'references', 'variables'].includes(key)) visit(child)
    }
    visit(value)
  }
  walk(program, (node) => {
    if (transparent.has(node)) return
    if (node.type === 'AssignmentExpression') {
      invalidateInstance(node.left)
      invalidateInstance(node.right)
    }
    if (node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) invalidateInstance(node.argument)
    if (node.type === 'VariableDeclarator') invalidateInstance(node.init)
    if (node.type === 'ReturnStatement' && !transparent.has(node)) invalidateInstance(node.argument)
    if (node.type === 'CallExpression' || node.type === 'NewExpression' || node.type === 'TaggedTemplateExpression') {
      invalidateInstance(node.arguments ?? node.quasi)
      const callee = (node.callee ?? node.tag) as Node | undefined
      if (callee?.type === 'MemberExpression' && (callee.object as Node | undefined)?.type === 'ThisExpression') {
        invalidateInstance(callee.object)
      } else {
        invalidateInstance(callee)
      }
    }
  })
  const templateConstants = collectLexicalConstants({ body: [] }, additionalUsage, exposed)
  for (const name of exposed.keys()) if (!templateConstants.has(name)) invalid.add(name)
  // Two returned fields may share a mutable object, including nested aliases.
  const affected = new Set<StaticKnowledge>()
  const collectKnowledge = (knowledge: StaticKnowledge | undefined, target: Set<StaticKnowledge>) => {
    if (!knowledge || knowledge === unknownKnowledge || target.has(knowledge)) return
    target.add(knowledge)
    for (const child of Object.values(knowledge.properties ?? {})) collectKnowledge(child, target)
    for (const child of knowledge.elements ?? []) collectKnowledge(child, target)
  }
  for (const name of invalid) collectKnowledge(exposed.get(name), affected)
  for (const [name, knowledge] of exposed) {
    const reachable = new Set<StaticKnowledge>()
    collectKnowledge(knowledge, reachable)
    if (invalid.has(name) || [...reachable].some((item) => affected.has(item))) exposed.delete(name)
  }
  return exposed
}

/** Binding names are not reads; computed keys and defaults are handled by walkReferences. */
function walkBindings(value: unknown, visit: (name: string) => void) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const child of value) walkBindings(child, visit); return }
  const node = value as Node
  if (node.type === 'Identifier') visit(String(node.name))
  else if (node.type === 'ObjectPattern') {
    for (const property of (node.properties ?? []) as Node[]) walkBindings(property.type === 'RestElement' ? property.argument : property.value, visit)
  } else if (node.type === 'ArrayPattern') walkBindings(node.elements, visit)
  else if (node.type === 'RestElement') walkBindings(node.argument, visit)
  else if (node.type === 'AssignmentPattern') walkBindings(node.left, visit)
  else if (node.type === 'TSParameterProperty') walkBindings(node.parameter, visit)
}

/** Walk runtime references, not property spellings, labels, or declaration bindings. */
export function walkReferences(
  value: unknown,
  visit: (name: string, node: unknown) => void,
  binding = false,
  skipCallResults = false
) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const child of value) walkReferences(child, visit, binding, skipCallResults); return }
  const node = value as Node
  // Returning a call result does not return its callee. Calls separately invalidate
  // their arguments and member receivers in the lexical escape analysis.
  if (skipCallResults && ['CallExpression', 'NewExpression', 'TaggedTemplateExpression'].includes(node.type ?? '')) return
  if (node.type === 'Identifier') {
    if (!binding) visit(String(node.name), node)
    return
  }
  if (node.type === 'ImportDeclaration') return
  for (const [key, child] of Object.entries(node)) {
    if (['parent', 'tokens', 'comments', 'references', 'variables', 'typeAnnotation', 'typeParameters', 'typeArguments', 'returnType'].includes(key)) continue
    if (key === 'key' && ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(node.type ?? '') && !node.computed) continue
    if (key === 'property' && node.type === 'MemberExpression' && !node.computed) continue
    if (key === 'label' || (key === 'exported' && node.type === 'ExportSpecifier')) continue
    const functionNode = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type ?? '')
    const declarationBinding = (key === 'id' && ['VariableDeclarator', 'FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type ?? ''))
      || (key === 'params' && functionNode) || (key === 'param' && node.type === 'CatchClause')
    const expression = (key === 'right' && node.type === 'AssignmentPattern')
      || (key === 'key' && node.computed) || (key === 'body' && functionNode)
    walkReferences(child, visit, declarationBinding || (binding && !expression), skipCallResults)
  }
}

function walk(value: unknown, visit: (node: Node) => void) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const child of value) walk(child, visit); return }
  const node = value as Node
  if (typeof node.type === 'string') visit(node)
  for (const [key, child] of Object.entries(node)) {
    if (!['parent', 'tokens', 'comments', 'references', 'variables'].includes(key)) walk(child, visit)
  }
}

import tsParser from '@typescript-eslint/parser'
import { collectScriptBindingFacts, resolveImportedBinding, resolveLexicalBinding, type LexicalBindingFact, type ScriptBindingFacts } from './bindings.js'
import { collectPackageImports } from './origins.js'
import { parseVueScriptContext } from './sfc.js'
import { walkReferences } from './static-knowledge.js'
import type {
  SourceApplicationFact,
  SourceGlobImport,
  SourceModuleContext,
  VueGlobalPluginUsage,
  VuePackageReference
} from './types.js'

type AstNode = {
  type?: string
  name?: string
  value?: unknown
  body?: AstNode[]
  source?: AstNode
  specifiers?: AstNode[]
  local?: AstNode
  imported?: AstNode
  key?: AstNode
  declaration?: AstNode
  declarations?: AstNode[]
  id?: AstNode
  init?: AstNode
  expression?: AstNode
  callee?: AstNode
  tag?: AstNode
  quasi?: AstNode
  object?: AstNode
  property?: AstNode
  computed?: boolean
  arguments?: AstNode[]
  argument?: AstNode
  left?: AstNode
  right?: AstNode
  properties?: AstNode[]
  elements?: Array<AstNode | null>
  params?: AstNode[]
  openingElement?: AstNode
  range?: [number, number]
  [key: string]: unknown
}

export interface AnalyzeProjectModuleContextOptions {
  /** Runtime import roots known to provide Vue, including an npm alias. */
  vueImportRoots?: readonly string[]
}

/** Extract import-graph and Vue bootstrap facts without running diagnostics. */
export function analyzeProjectModuleContext(
  file: string,
  source: string,
  options: AnalyzeProjectModuleContextOptions = {}
): SourceModuleContext {
  const programs: AstNode[] = []
  const errors: string[] = []
  if (file.endsWith('.vue')) {
    const parsed = parseVueScriptContext(source, file)
    programs.push(...parsed.scriptPrograms as AstNode[])
    errors.push(...parsed.errors)
  } else {
    try {
      programs.push(tsParser.parse(source, {
        sourceType: 'module',
        ecmaVersion: 'latest',
        filePath: file,
        range: true,
        ecmaFeatures: { jsx: /\.[jt]sx$/i.test(file) }
      }) as unknown as AstNode)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  const moduleImports = programs.map(program => collectModuleSpecifiers(program, source))
  const imports = [...new Set(moduleImports.flatMap((item) => item.imports))].sort(compareText)
  const eagerImports = [...new Set(programs.flatMap((program) => (program.body ?? [])
    .filter(isRuntimeModuleDeclaration)
    .flatMap((node) => typeof node.source?.value === 'string' ? [node.source.value] : [])))].sort(compareText)
  const unresolvedImports = [...new Set(moduleImports.flatMap((item) => item.unresolved))].sort(compareText)
  const globImports = moduleImports.flatMap(item => item.globs)
  const facts = programs.map((program) => collectVueFacts(file, program, options))
  const applications = facts.flatMap((fact) => fact.applications)
  const vueConstructorPlugins = facts.flatMap((fact) => fact.vueConstructorPlugins)
  return { file, imports, eagerImports, ...(globImports.length ? { globImports } : {}), unresolvedImports, applications, vueConstructorPlugins, errors }
}

/** Registrations require a proven Vue app receiver or imported Vue 2 constructor. */
export function collectGlobalPlugins(
  file: string,
  program: unknown,
  options: AnalyzeProjectModuleContextOptions = {}
): VueGlobalPluginUsage[] {
  const facts = collectVueFacts(file, program, options)
  return deduplicatePlugins([
    ...facts.applications.flatMap((application) => application.plugins),
    ...facts.vueConstructorPlugins.flatMap((registration) => registration.plugins)
  ])
}

export function collectVueApplications(
  file: string,
  program: unknown,
  options: AnalyzeProjectModuleContextOptions = {}
): SourceApplicationFact[] {
  return collectVueFacts(file, program, options).applications
}

function collectVueFacts(
  file: string,
  program: unknown,
  options: AnalyzeProjectModuleContextOptions
): {
  applications: SourceApplicationFact[]
  vueConstructorPlugins: NonNullable<SourceModuleContext['vueConstructorPlugins']>
} {
  const root = program as AstNode
  const vueImportRoots = new Set(options.vueImportRoots?.length ? options.vueImportRoots : ['vue'])
  const bindingFacts = collectScriptBindingFacts(root)
  const packageImports = collectPackageImports(root)
  const applications: SourceApplicationFact[] = []
  const constructorPlugins = new Map<string, VueGlobalPluginUsage[]>()

  type Receiver = SourceApplicationFact | string
  const receivers = new Map<LexicalBindingFact, Receiver>()
  const unavailableBindings = new Set<LexicalBindingFact>()
  const invalidReceivers = new Set<Receiver>()

  const identifierReceiver = (identifier: AstNode): Receiver | undefined => {
    const binding = resolveLexicalBinding(bindingFacts, identifier)
    if (!binding || unavailableBindings.has(binding)) return undefined
    const receiver = receivers.get(binding) ?? (
      binding.kind === 'import' && binding.source && vueImportRoots.has(binding.source)
      && (binding.imported === 'default' || binding.imported === '*')
        ? binding.source
        : undefined
    )
    return receiver !== undefined && !invalidReceivers.has(receiver) ? receiver : undefined
  }

  const invalidateReferences = (value: unknown, deferred: boolean): void => {
    walkReferences(value, (_name, reference) => {
      const binding = resolveLexicalBinding(bindingFacts, reference)
      if (!binding) return
      if (deferred) unavailableBindings.add(binding)
      else {
        const receiver = identifierReceiver(reference as AstNode)
        if (receiver !== undefined) invalidReceivers.add(receiver)
      }
    })
  }

  const invalidateTarget = (rawTarget: AstNode | undefined, deferred: boolean): void => {
    const target = unwrap(rawTarget)
    if (!target) return
    if (target.type === 'Identifier') {
      const binding = resolveLexicalBinding(bindingFacts, target)
      if (binding) {
        if (deferred || binding.kind !== 'variable') unavailableBindings.add(binding)
        receivers.delete(binding)
      }
    } else if (target.type === 'MemberExpression') {
      invalidateReferences(target.object, deferred)
    } else if (target.type === 'ObjectPattern') {
      for (const property of target.properties ?? []) {
        invalidateTarget(property.type === 'RestElement' ? property.argument : property.value as AstNode, deferred)
      }
    } else if (target.type === 'ArrayPattern') {
      for (const element of target.elements ?? []) invalidateTarget(element ?? undefined, deferred)
    } else if (target.type === 'AssignmentPattern') {
      invalidateTarget(target.left, deferred)
    } else if (target.type === 'RestElement') {
      invalidateTarget(target.argument, deferred)
    }
  }

  const inspectEffects = (expression: AstNode, deferred = false): void => {
    visitAst(expression, node => {
      if (node.type === 'AssignmentExpression') {
        invalidateTarget(node.left, deferred)
        invalidateReferences(node.right, deferred)
      } else if (node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) {
        invalidateTarget(node.argument, deferred)
      } else if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
        if (node.left?.type === 'VariableDeclaration') {
          for (const declaration of node.left.declarations ?? []) invalidateTarget(declaration.id, deferred)
        } else invalidateTarget(node.left, deferred)
        if (node.type === 'ForOfStatement') invalidateReferences(node.right, deferred)
      } else if (node.type === 'VariableDeclarator') {
        // Aliases in unsupported control flow must not conceal writes or escapes.
        if (node.init) {
          invalidateTarget(node.id, deferred)
          invalidateReferences(node.init, deferred)
        }
      } else if (node.type === 'CallExpression' || node.type === 'NewExpression' || node.type === 'TaggedTemplateExpression') {
        invalidateReferences(node.arguments ?? node.quasi, deferred)
        const callee = unwrap(node.callee ?? node.tag)
        if (callee?.type === 'MemberExpression' && !isVue3CreateApp(callee, bindingFacts, vueImportRoots)) {
          const object = unwrap(callee.object)
          const receiver = object?.type === 'Identifier' ? identifierReceiver(object) : undefined
          if (!hasKnownVueMethod(memberName(callee), receiver === undefined ? undefined : typeof receiver === 'string')) {
            invalidateReferences(callee.object, deferred)
          }
        }
      } else if (node.type === 'ReturnStatement' || node.type === 'YieldExpression' || node.type === 'AwaitExpression') {
        invalidateReferences(node.argument, deferred)
      }
    })
  }

  // A deferred closure may run between otherwise adjacent top-level statements.
  visitAst(root, node => {
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type ?? '')) return
    inspectEffects(node, true)
    return false
  })

  const liveVueImport = (rawCallee: AstNode | undefined): boolean => {
    const callee = unwrap(rawCallee)
    const identifier = callee?.type === 'MemberExpression' ? unwrap(callee.object) : callee
    const binding = resolveImportedBinding(bindingFacts, identifier)
    return Boolean(binding && !unavailableBindings.has(binding) && !invalidReceivers.has(binding.source ?? ''))
  }

  const collectReceiver = (rawExpression: AstNode | undefined, localName?: string): Receiver | undefined => {
    const expression = unwrap(rawExpression)
    if (!expression) return undefined
    if (expression.type === 'Identifier') return identifierReceiver(expression)
    if (expression.type === 'CallExpression' && liveVueImport(expression.callee) && isVue3CreateApp(expression.callee, bindingFacts, vueImportRoots)) {
      const rootComponent = unwrap(expression.arguments?.[0])
      const rootBinding = rootComponent?.type === 'Identifier' ? resolveImportedBinding(bindingFacts, rootComponent) : undefined
      const application = applicationFromFactory(
        file, localName ?? `inline-${expression.range?.[0] ?? applications.length}`, rootComponent, rootBinding
      )
      applications.push(application)
      return application
    }
    if (expression.type === 'NewExpression' && liveVueImport(expression.callee) && findVue2Constructor(expression, bindingFacts, vueImportRoots)) {
      applications.push(applicationFromVue2(
        file, localName ?? `vue2-inline-${expression.range?.[0] ?? applications.length}`, expression, bindingFacts
      ))
      // Vue 2 instances are bootstrap evidence, not plugin constructors.
      return undefined
    }
    const callee = expression.type === 'CallExpression' ? unwrap(expression.callee) : undefined
    if (callee?.type !== 'MemberExpression') return undefined
    const receiver = collectReceiver(callee.object, localName)
    if (receiver === undefined) return undefined
    const method = memberName(callee)
    if (method === 'use') {
      const registration = resolvePluginRegistration(file, expression, bindingFacts, packageImports)
      if (registration) {
        if (typeof receiver === 'string') {
          const plugins = constructorPlugins.get(receiver) ?? []
          plugins.push(registration)
          constructorPlugins.set(receiver, plugins)
        } else {
          receiver.plugins.push(registration)
        }
      }
    }
    const vue2 = typeof receiver === 'string'
    if (!hasKnownVueMethod(method, vue2)) invalidReceivers.add(receiver)
    return returnsVueReceiver(method, expression.arguments ?? [], vue2, bindingFacts, unavailableBindings) && !invalidReceivers.has(receiver)
      ? receiver
      : undefined
  }

  for (const statement of root.body ?? []) {
    const variableStatement = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (variableStatement?.type === 'VariableDeclaration') {
      for (const declaration of variableStatement.declarations ?? []) {
        if (!declaration.init) continue
        inspectEffects(declaration.init)
        const receiver = collectReceiver(declaration.init, declaration.id?.type === 'Identifier' ? declaration.id.name : undefined)
        const binding = resolveLexicalBinding(bindingFacts, declaration.id)
        if (binding) receivers.delete(binding)
        else invalidateTarget(declaration.id, false)
        if (binding && receiver !== undefined) {
          if (unavailableBindings.has(binding)) invalidReceivers.add(receiver)
          else receivers.set(binding, receiver)
        } else if (declaration.id?.type !== 'Identifier'
          || ['ObjectExpression', 'ArrayExpression', 'ConditionalExpression', 'LogicalExpression', 'SequenceExpression'].includes(unwrap(declaration.init)?.type ?? '')) {
          invalidateReferences(declaration.init, false)
        }
      }
    } else {
      inspectEffects(statement)
      if (statement.type === 'ExpressionStatement') collectReceiver(statement.expression)
    }
  }

  return {
    applications: applications.map((application) => ({
      ...application,
      plugins: deduplicatePlugins([
        ...application.plugins,
        ...(application.vueConstructorImport ? constructorPlugins.get(application.vueConstructorImport) ?? [] : [])
      ])
    })),
    vueConstructorPlugins: [...constructorPlugins].map(([constructorImport, plugins]) => ({
      constructorImport,
      plugins: deduplicatePlugins(plugins)
    }))
  }
}

function resolvePluginRegistration(
  file: string,
  useCall: AstNode,
  bindingFacts: ReturnType<typeof collectScriptBindingFacts>,
  packageImports: ReturnType<typeof collectPackageImports>
): VueGlobalPluginUsage | undefined {
  const plugin = unwrap(useCall.arguments?.[0])
  if (plugin?.type !== 'Identifier' || !plugin.name) return undefined
  const importedPlugin = resolveImportedBinding(bindingFacts, plugin)
  const fallbackPlugin = packageImports.get(plugin.name)
  const packageEvidence = importedPlugin?.source && importedPlugin.imported
    ? toPackageReference(importedPlugin.source)
    : fallbackPlugin?.package
  return packageEvidence ? { file, package: packageEvidence, localName: plugin.name } : undefined
}

function isVue3CreateApp(
  rawCallee: AstNode | undefined,
  facts: ReturnType<typeof collectScriptBindingFacts>,
  vueImportRoots: ReadonlySet<string>
): boolean {
  const callee = unwrap(rawCallee)
  if (callee?.type === 'Identifier') {
    const binding = resolveImportedBinding(facts, callee)
    return ['createApp', 'createSSRApp'].includes(binding?.imported ?? '') && vueImportRoots.has(binding?.source ?? '')
  }
  if (callee?.type !== 'MemberExpression' || callee.computed) return false
  const namespace = unwrap(callee.object)
  const property = unwrap(callee.property)
  if (namespace?.type !== 'Identifier' || property?.type !== 'Identifier' || !['createApp', 'createSSRApp'].includes(property.name ?? '')) return false
  const binding = resolveImportedBinding(facts, namespace)
  return binding?.imported === '*' && vueImportRoots.has(binding.source ?? '')
}

function applicationFromFactory(
  file: string,
  appLocalName: string,
  rootComponent: AstNode | undefined,
  rootBinding: ReturnType<typeof resolveImportedBinding>
): SourceApplicationFact {
  return {
    file,
    framework: 'vue3',
    appLocalName,
    ...(rootBinding?.source && isProjectImport(rootBinding.source)
      ? {
          rootComponentImport: rootBinding.source,
          rootComponentLocalName: rootComponent?.name
        }
      : {}),
    plugins: []
  }
}


function findVue2Constructor(
  expression: AstNode | undefined,
  facts: ReturnType<typeof collectScriptBindingFacts>,
  vueImportRoots: ReadonlySet<string>
): AstNode | undefined {
  const current = unwrap(expression)
  if (!current) return undefined
  if (current.type === 'NewExpression') {
    const callee = unwrap(current.callee)
    const binding = callee?.type === 'Identifier' ? resolveImportedBinding(facts, callee) : undefined
    if (
      binding
      && (binding.imported === 'default' || binding.imported === '*')
      && vueImportRoots.has(binding.source ?? '')
    ) return current
  }
  return undefined
}

function applicationFromVue2(
  file: string,
  appLocalName: string,
  constructor: AstNode,
  facts: ReturnType<typeof collectScriptBindingFacts>
): SourceApplicationFact {
  const rootComponent = findVue2RootComponent(constructor.arguments?.[0], facts)
  const callee = unwrap(constructor.callee)
  const binding = callee?.type === 'Identifier' ? resolveImportedBinding(facts, callee) : undefined
  return {
    file,
    framework: 'vue2.7',
    appLocalName,
    vueConstructorImport: binding?.source,
    ...(rootComponent
      ? {
          rootComponentImport: rootComponent.source,
          rootComponentLocalName: rootComponent.localName
        }
      : {}),
    plugins: []
  }
}

function findVue2RootComponent(
  options: AstNode | undefined,
  facts: ReturnType<typeof collectScriptBindingFacts>
): { source: string; localName: string } | undefined {
  const object = unwrap(options)
  if (object?.type !== 'ObjectExpression') return undefined
  const render = (object.properties as AstNode[] | undefined)?.find((property) => {
    const key = unwrap(property.key)
    return key?.name === 'render' || key?.value === 'render'
  })
  if (!render) return undefined
  const renderValue = unwrap(render.value as AstNode | undefined) ?? render
  const renderFactoryNames = new Set((renderValue.params ?? [])
    .filter((parameter) => parameter.type === 'Identifier' && parameter.name)
    .map((parameter) => parameter.name!))
  let found: { source: string; localName: string } | undefined
  visitAst(renderValue, (node) => {
    if (found) return
    if (node.type === 'CallExpression') {
      const callee = unwrap(node.callee)
      if (callee?.type !== 'Identifier' || !callee.name || !renderFactoryNames.has(callee.name)) return
      const component = unwrap(node.arguments?.[0])
      if (component?.type !== 'Identifier' || !component.name) return
      found = importedProjectComponent(component, facts)
      return
    }
    if (node.type === 'JSXOpeningElement') {
      const jsxName = (node as { name?: AstNode }).name
      if (!jsxName?.name || !['Identifier', 'JSXIdentifier'].includes(jsxName.type ?? '')) return
      found = importedProjectComponent({ ...jsxName, type: 'Identifier' }, facts)
    }
  })
  return found
}

function importedProjectComponent(
  identifier: AstNode,
  facts: ReturnType<typeof collectScriptBindingFacts>
): { source: string; localName: string } | undefined {
  const binding = resolveImportedBinding(facts, identifier)
  return binding?.source && identifier.name && isProjectImport(binding.source)
    ? { source: binding.source, localName: identifier.name }
    : undefined
}

function memberName(member: AstNode): string | undefined {
  const property = unwrap(member.property)
  return member.computed
    ? typeof property?.value === 'string' ? property.value : undefined
    : property?.name
}

const knownVue2Methods: Readonly<Record<string, true>> = {
  use: true, mixin: true, component: true, directive: true, filter: true, extend: true,
  set: true, delete: true, nextTick: true, observable: true, compile: true
}

const knownVue3Methods: Readonly<Record<string, true>> = {
  use: true, mixin: true, provide: true, component: true, directive: true,
  mount: true, unmount: true, onUnmount: true, runWithContext: true
}

function hasKnownVueMethod(method: string | undefined, vue2?: boolean): boolean {
  if (!method) return false
  if (vue2 === true) return knownVue2Methods[method] === true
  if (vue2 === false) return knownVue3Methods[method] === true
  // The effect prepass may precede receiver initialization. Return identity is
  // checked separately once the receiver is known; $mount belongs to instances.
  return knownVue2Methods[method] === true || knownVue3Methods[method] === true || method === '$mount'
}

function returnsVueReceiver(
  method: string | undefined,
  args: AstNode[],
  vue2: boolean,
  facts: ScriptBindingFacts,
  unavailableBindings: ReadonlySet<LexicalBindingFact>
): boolean {
  if (args.some(argument => argument.type === 'SpreadElement')) return false
  if (method === 'use') return args.length >= 1
  if (method === 'mixin') return args.length === 1
  // Vue 2 asset methods return definitions, and extend returns a subclass.
  if (vue2) return false
  if (method === 'provide') return args.length === 2
  if ((method !== 'component' && method !== 'directive') || args.length !== 2) return false
  // Getter overloads (including falsy definitions) return a component/directive, not the app.
  const definition = unwrap(args[1])
  if (!definition) return false
  if (['ObjectExpression', 'ArrayExpression', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(definition.type ?? '')) return true
  if (definition.type === 'Literal') return Boolean(definition.value)
  const binding = resolveLexicalBinding(facts, definition)
  return Boolean(binding && !unavailableBindings.has(binding) && (
    binding.kind === 'function' || binding.kind === 'class'
    || (binding.kind === 'import' && /\.vue(?:$|\?)/i.test(binding.source ?? ''))
  ))
}


function isRuntimeModuleDeclaration(node: AstNode): boolean {
  return ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type ?? '')
    && node.importKind !== 'type' && node.exportKind !== 'type'
    && !(node.specifiers?.length && node.specifiers.every(specifier => specifier.importKind === 'type' || specifier.exportKind === 'type'))
}

function collectModuleSpecifiers(program: AstNode, source: string): { imports: string[]; unresolved: string[]; globs: SourceGlobImport[] } {
  const imports: string[] = []
  const unresolved: string[] = []
  const globs: SourceGlobImport[] = []
  visitAst(program, (node, parent) => {
    if (isImportMetaGlob(node)) {
      const glob = readGlobImport(node)
      if (!glob) unresolved.push('import.meta.glob requires literal patterns and supported static module options.')
      else if (!isKeysOnlyGlob(node, parent, source)) globs.push(glob)
    }
    if (
      isRuntimeModuleDeclaration(node)
      && typeof node.source?.value === 'string'
    ) imports.push(node.source.value)
    if (node.type === 'ImportExpression') {
      if (typeof node.source?.value === 'string') imports.push(node.source.value)
      else unresolved.push('Dynamic import specifier is not a static string.')
    }
    if (
      node.type === 'CallExpression'
      && node.callee?.type === 'Identifier'
      && node.callee.name === 'require'
      && typeof node.arguments?.[0]?.value === 'string'
    ) imports.push(node.arguments[0].value)
    else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
      unresolved.push('require() specifier is not a static string.')
    }
  })
  return { imports, unresolved, globs }
}

function isImportMetaGlob(node: AstNode): boolean {
  const callee = node.callee
  const object = callee?.object
  return node.type === 'CallExpression' && callee?.type === 'MemberExpression' && !callee.computed
    && callee.property?.name === 'glob' && object?.type === 'MetaProperty'
    && (object.meta as AstNode)?.name === 'import' && object.property?.name === 'meta'
}

function isKeysOnlyGlob(node: AstNode, parent: AstNode | undefined, source: string): boolean {
  if (parent?.type !== 'CallExpression' || parent.arguments?.[0] !== node
    || !parent.callee?.range || !node.range) return false
  // Vite recognizes this exact lexical form even when Object is shadowed.
  const callee = source.slice(...parent.callee.range)
  const gap = source.slice(parent.callee.range[1], node.range[0])
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ')
  return /\bObject\.keys$/.test(callee) && /^\(\s*$/.test(gap)
}

function readGlobImport(node: AstNode): SourceGlobImport | undefined {
  const args = node.arguments ?? []
  if (args.length < 1 || args.length > 2) return undefined
  const first = args[0]!
  const entries = first.type === 'ArrayExpression' ? first.elements as Array<AstNode | null> : [first]
  const patterns = entries.map(entry => {
    if (entry?.type === 'Literal' && typeof entry.value === 'string') return entry.value
    if (entry?.type === 'TemplateLiteral' && (entry.expressions as unknown[]).length === 0) {
      const quasi = (entry.quasis as Array<{ value: { cooked?: string } }>)[0]
      return quasi?.value.cooked
    }
    return undefined
  })
  if (!patterns.length || patterns.some(pattern => !pattern)) return undefined
  let eager = false
  const options = args[1]
  if (options) {
    if (options.type !== 'ObjectExpression') return undefined
    for (const property of options.properties as AstNode[]) {
      if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') return undefined
      const key = property.key?.name ?? property.key?.value
      const value = property.value as AstNode | undefined
      if (key === 'eager' && value?.type === 'Literal' && typeof value.value === 'boolean') eager = value.value
      else if (key !== 'import' || value?.type !== 'Literal' || typeof value.value !== 'string') return undefined
    }
  }
  return { patterns: patterns as string[], eager }
}

function visitAst(node: AstNode, visit: (node: AstNode, parent?: AstNode) => void | boolean, parent?: AstNode): void {
  if (visit(node, parent) === false) return
  for (const [key, value] of Object.entries(node)) {
    if (['parent', 'loc', 'range', 'tokens', 'comments'].includes(key)) continue
    if (Array.isArray(value)) {
      for (const child of value) if (isAstNode(child)) visitAst(child, visit, node)
    } else if (isAstNode(value)) {
      visitAst(value, visit, node)
    }
  }
}

function unwrap(node: AstNode | undefined): AstNode | undefined {
  let current = node
  while (current && ['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(current.type ?? '')) {
    current = current.expression
  }
  return current
}

function isProjectImport(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')
    || specifier.startsWith('@/') || specifier.startsWith('~/')
}

function toPackageReference(specifier: string): VuePackageReference | undefined {
  if (isProjectImport(specifier) || specifier.startsWith('\0') || /^[a-z][a-z\d+.-]*:/i.test(specifier)) return undefined
  const segments = specifier.split('/')
  const count = specifier.startsWith('@') ? 2 : 1
  if (segments.length < count) return undefined
  const packageName = segments.slice(0, count).join('/')
  const rest = segments.slice(count)
  return {
    specifier,
    packageName,
    ...(rest.length ? { subpath: `./${rest.join('/')}` } : {})
  }
}

function deduplicatePlugins(plugins: VueGlobalPluginUsage[]): VueGlobalPluginUsage[] {
  const seen = new Set<string>()
  return plugins.filter((plugin) => {
    const key = `${plugin.file}\0${plugin.localName}\0${plugin.package.specifier}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isAstNode(value: unknown): value is AstNode {
  return Boolean(value && typeof value === 'object' && typeof (value as AstNode).type === 'string')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

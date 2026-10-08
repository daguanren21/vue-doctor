import tsParser from '@typescript-eslint/parser'
import { collectScriptBindingFacts, resolveImportedBinding } from './bindings.js'
import { collectPackageImports } from './origins.js'
import { parseVueScriptContext } from './sfc.js'
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
  object?: AstNode
  property?: AstNode
  computed?: boolean
  arguments?: AstNode[]
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

  for (const statement of root.body ?? []) {
    const variableStatement = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (variableStatement?.type !== 'VariableDeclaration') continue
    for (const declaration of variableStatement.declarations ?? []) {
      if (declaration.id?.type !== 'Identifier' || !declaration.id.name) continue
      const init = unwrap(declaration.init)
      const factoryCall = findVueFactoryCall(init, bindingFacts, vueImportRoots)
      if (factoryCall) {
        const rootComponent = unwrap(factoryCall.arguments?.[0])
        const rootBinding = rootComponent?.type === 'Identifier'
          ? resolveImportedBinding(bindingFacts, rootComponent)
          : undefined
        const application = applicationFromFactory(file, declaration.id.name, rootComponent, rootBinding)
        application.plugins.push(...collectTopLevelUseCalls(init).flatMap((useCall) => {
          const plugin = resolvePluginRegistration(file, useCall, bindingFacts, packageImports)
          return plugin ? [plugin] : []
        }))
        applications.push(application)
        continue
      }
      const vue2 = findVue2Constructor(init, bindingFacts, vueImportRoots)
      if (vue2) applications.push(applicationFromVue2(file, declaration.id.name, vue2, bindingFacts))
    }
  }

  for (const statement of root.body ?? []) {
    if (statement.type !== 'ExpressionStatement') continue
    const factoryCall = findVueFactoryCall(statement.expression, bindingFacts, vueImportRoots)
    let inlineApplication: SourceApplicationFact | undefined
    if (factoryCall) {
      const rootComponent = unwrap(factoryCall.arguments?.[0])
      const rootBinding = rootComponent?.type === 'Identifier'
        ? resolveImportedBinding(bindingFacts, rootComponent)
        : undefined
      inlineApplication = applicationFromFactory(
        file,
        `inline-${factoryCall.range?.[0] ?? applications.length}`,
        rootComponent,
        rootBinding
      )
      applications.push(inlineApplication)
    }
    const vue2Constructor = findVue2Constructor(statement.expression, bindingFacts, vueImportRoots)
    if (vue2Constructor) {
      applications.push(applicationFromVue2(
        file,
        `vue2-inline-${vue2Constructor.range?.[0] ?? applications.length}`,
        vue2Constructor,
        bindingFacts
      ))
    }
    for (const useCall of collectTopLevelUseCalls(statement.expression)) {
      const receiver = ultimateUseReceiver(useCall)
      const registration = resolvePluginRegistration(file, useCall, bindingFacts, packageImports)
      if (!registration) continue

      const application = receiver?.type === 'Identifier' && receiver.name
        ? applications.find((candidate) => candidate.appLocalName === receiver.name)
        : inlineApplication
      if (application) {
        application.plugins.push(registration)
        continue
      }
      if (receiver?.type !== 'Identifier') continue
      const receiverBinding = resolveImportedBinding(bindingFacts, receiver)
      if (
        receiverBinding?.source
        && vueImportRoots.has(receiverBinding.source)
        && (receiverBinding.imported === 'default' || receiverBinding.imported === '*')
      ) {
        const plugins = constructorPlugins.get(receiverBinding.source) ?? []
        plugins.push(registration)
        constructorPlugins.set(receiverBinding.source, plugins)
      }
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

function findVueFactoryCall(
  expression: AstNode | undefined,
  facts: ReturnType<typeof collectScriptBindingFacts>,
  vueImportRoots: ReadonlySet<string>
): AstNode | undefined {
  const current = unwrap(expression)
  if (!current) return undefined
  if (current.type === 'CallExpression' && isVue3CreateApp(current.callee, facts, vueImportRoots)) return current
  const callee = current.type === 'CallExpression' ? unwrap(current.callee) : undefined
  return callee?.type === 'MemberExpression'
    ? findVueFactoryCall(callee.object, facts, vueImportRoots)
    : undefined
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
  const callee = current.type === 'CallExpression' ? unwrap(current.callee) : undefined
  return callee?.type === 'MemberExpression'
    ? findVue2Constructor(callee.object, facts, vueImportRoots)
    : undefined
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

function collectTopLevelUseCalls(expression: AstNode | undefined): AstNode[] {
  const current = unwrap(expression)
  if (current?.type !== 'CallExpression') return []
  const calls: AstNode[] = []
  const callee = unwrap(current.callee)
  if (callee?.type === 'MemberExpression') calls.push(...collectTopLevelUseCalls(callee.object))
  if (
    callee?.type === 'MemberExpression'
    && !callee.computed
    && unwrap(callee.property)?.type === 'Identifier'
    && unwrap(callee.property)?.name === 'use'
  ) calls.push(current)
  return calls
}

function ultimateUseReceiver(useCall: AstNode): AstNode | undefined {
  let receiver = unwrap(unwrap(useCall.callee)?.object)
  while (receiver?.type === 'CallExpression') {
    const callee = unwrap(receiver.callee)
    if (callee?.type !== 'MemberExpression' || unwrap(callee.property)?.name !== 'use') break
    receiver = unwrap(callee.object)
  }
  return receiver
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

function visitAst(node: AstNode, visit: (node: AstNode, parent?: AstNode) => void, parent?: AstNode): void {
  visit(node, parent)
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

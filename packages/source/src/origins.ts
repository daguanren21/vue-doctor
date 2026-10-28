import { resolveImportedBinding, type ScriptBindingFacts } from './bindings.js'
import type { VueComponentOrigin, VuePackageReference } from './types.js'

export interface PackageImportEvidence {
  package: VuePackageReference
  importedName: string
}

type ProgramNode = {
  body?: unknown[]
}

type ImportDeclarationNode = {
  type?: string
  importKind?: string
  source?: {
    value?: unknown
  }
  specifiers?: Array<{
    type?: string
    importKind?: string
    local?: {
      name?: string
    }
    imported?: {
      name?: string
      value?: unknown
    }
  }>
}

type AstNode = {
  type?: string
  name?: string
  value?: unknown
  id?: AstNode
  declaration?: AstNode
  init?: AstNode
  key?: AstNode
  source?: AstNode
  callee?: AstNode
  object?: AstNode
  property?: AstNode
  computed?: boolean
  kind?: string
  arguments?: AstNode[]
  properties?: AstNode[]
}

export function collectPackageImports(program: ProgramNode): Map<string, PackageImportEvidence> {
  const imports = new Map<string, PackageImportEvidence>()

  for (const statement of program.body ?? []) {
    const declaration = statement as ImportDeclarationNode
    const packageReference = getPackageReference(declaration)
    if (!packageReference) {
      continue
    }

    for (const specifier of declaration.specifiers ?? []) {
      const localName = specifier.local?.name
      const importedName = getImportedName(specifier)
      if (localName && importedName) {
        imports.set(localName, { package: packageReference, importedName })
      }
    }
  }

  return imports
}

export function collectDirectImportOrigins(
  program: ProgramNode,
  templateContext?: { scriptSetup: boolean; bindings: ScriptBindingFacts }
): Map<string, VueComponentOrigin> {
  const origins = new Map<string, VueComponentOrigin>()

  for (const statement of program.body ?? []) {
    const declaration = statement as ImportDeclarationNode
    if (declaration.type !== 'ImportDeclaration' || declaration.importKind === 'type' || typeof declaration.source?.value !== 'string') {
      continue
    }
    const source = declaration.source.value
    const packageReference = getPackageReference(declaration)
    for (const specifier of declaration.specifiers ?? []) {
      const localName = specifier.local?.name
      if (!localName || specifier.importKind === 'type') continue
      if (packageReference) {
        const importedName = getImportedName(specifier)
        if (importedName) {
          origins.set(localName, {
            kind: 'direct-import',
            package: packageReference,
            importedName,
            importSource: source
          })
        }
      } else if (isLocalImportSpecifier(source)) {
        origins.set(localName, { kind: 'local-import', importSource: source, importedName: getImportedName(specifier) })
      }
    }
  }

  const imports = new Map(origins)

  visitAst(program as AstNode, (node) => {
    if (
      node.type === 'VariableDeclarator'
      && node.id?.type === 'Identifier'
      && node.id.name
      && containsLocalModuleLoad(node.init)
    ) {
      origins.set(node.id.name, { kind: 'local-import' })
    }
  })

  visitAst(program as AstNode, (node) => {
    if (node.type !== 'Property' || propertyName(node.key) !== 'components') return
    const components = node.value
    if (!isAstNode(components) || components.type !== 'ObjectExpression') return
    for (const property of components.properties ?? []) {
      const alias = propertyName(property.key)
      const value = property.value
      if (!alias || !isAstNode(value)) continue
      if (containsLocalModuleLoad(value)) {
        origins.set(alias, { kind: 'local-import' })
        continue
      }
      const origin = componentValueOrigin(value, origins)
      if (origin) origins.set(alias, origin)
    }
  })

  if (templateContext) {
    markComponentsOptionOrigins(program, imports, origins, templateContext.bindings)
    if (templateContext.scriptSetup) {
      for (const binding of templateContext.bindings.scopes[0]?.bindings ?? []) {
        if (binding.kind !== 'import') continue
        const origin = imports.get(binding.name)
        if (origin && origin.importSource === binding.source && origin.importedName === binding.imported) {
          origins.set(binding.name, { ...origin, templateBinding: 'script-setup' })
        }
      }
    }
  }

  return origins
}

function markComponentsOptionOrigins(
  program: ProgramNode,
  imports: ReadonlyMap<string, VueComponentOrigin>,
  origins: Map<string, VueComponentOrigin>,
  bindings: ScriptBindingFacts
): void {
  for (const statement of program.body ?? []) {
    if (!isAstNode(statement) || statement.type !== 'ExportDefaultDeclaration') continue
    let options = statement.declaration
    let factorySource: string | undefined
    if (options?.type === 'CallExpression') {
      const callee = options.callee
      const binding = resolveImportedBinding(bindings, callee?.type === 'MemberExpression' ? callee.object : callee)
      const importedName = callee?.type === 'MemberExpression' && !callee.computed && binding?.imported === '*'
        ? propertyName(callee.property)
        : callee?.type === 'Identifier' ? binding?.imported : undefined
      if (importedName !== 'defineComponent' || options.arguments?.length !== 1) continue
      factorySource = binding?.source
      options = options.arguments[0]
    }
    if (options?.type !== 'ObjectExpression') continue
    // An unknown spread/computed option can replace the entire components table.
    if (options.properties?.some((property) => property.type !== 'Property' || property.computed)) continue
    const registrations = options.properties?.filter((property) => propertyName(property.key) === 'components')
    if (registrations?.length !== 1) continue
    const components = registrations[0]?.value
    if (!isAstNode(components) || components.type !== 'ObjectExpression') continue
    if (components.properties?.some((property) => property.type !== 'Property' || property.computed || property.kind === 'get' || property.kind === 'set')) continue
    const names = new Set<string>()
    const duplicates = new Set<string>()
    for (const property of components.properties ?? []) {
      const name = propertyName(property.key)
      if (!name) continue
      if (names.has(name)) duplicates.add(name)
      names.add(name)
    }
    for (const property of components.properties ?? []) {
      const name = propertyName(property.key)
      const value = property.value
      if (!name || duplicates.has(name) || !isAstNode(value)) continue
      const identifier = value.type === 'MemberExpression' ? value.object : value
      const binding = resolveImportedBinding(bindings, identifier)
      if (!binding || !identifier?.name) continue
      if (value.type === 'MemberExpression' && (value.computed || binding.imported !== '*')) continue
      const imported = imports.get(identifier.name)
      if (!imported || imported.importSource !== binding.source || imported.importedName !== binding.imported) continue
      // A wrapper is trusted only alongside imports from that same package. The
      // runner still verifies that package's canonical Vue identity and version.
      if (factorySource && factorySource !== imported.importSource) continue
      const origin = componentValueOrigin(value, imports)
      if (origin) origins.set(name, { ...origin, templateBinding: 'components-option' })
    }
  }
}

function componentValueOrigin(
  value: AstNode,
  origins: ReadonlyMap<string, VueComponentOrigin>
): VueComponentOrigin | undefined {
  if (value.type === 'Identifier' && value.name) return origins.get(value.name)
  if (
    value.type === 'MemberExpression'
    && value.object?.type === 'Identifier'
    && value.object.name
  ) {
    const origin = origins.get(value.object.name)
    const importedName = propertyName(value.property)
    if (!origin || !importedName) return undefined
    return origin.kind === 'direct-import'
      ? { ...origin, importedName }
      : origin
  }
  return undefined
}

function isLocalImportSpecifier(specifier: string): boolean {
  return specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.startsWith('#')
}

function containsLocalModuleLoad(node: AstNode | undefined): boolean {
  if (!node) return false
  if (
    node.type === 'ImportExpression'
    && isAstNode(node.source)
    && typeof node.source.value === 'string'
    && isLocalImportSpecifier(node.source.value)
  ) {
    return true
  }
  if (
    node.type === 'CallExpression'
    && node.callee?.type === 'Identifier'
    && node.callee.name === 'require'
    && typeof node.arguments?.[0]?.value === 'string'
    && isLocalImportSpecifier(node.arguments[0].value)
  ) {
    return true
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue
    if (Array.isArray(value)) {
      if (value.some((child) => isAstNode(child) && containsLocalModuleLoad(child))) return true
    } else if (isAstNode(value) && containsLocalModuleLoad(value)) {
      return true
    }
  }
  return false
}

function visitAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue
    if (Array.isArray(value)) {
      for (const child of value) if (isAstNode(child)) visitAst(child, visit)
    } else if (isAstNode(value)) {
      visitAst(value, visit)
    }
  }
}

function propertyName(node: AstNode | undefined): string | undefined {
  if (node?.type === 'Identifier') return node.name
  return typeof node?.value === 'string' ? node.value : undefined
}

function isAstNode(value: unknown): value is AstNode {
  return Boolean(value && typeof value === 'object' && 'type' in value)
}

function getPackageReference(declaration: ImportDeclarationNode): VuePackageReference | undefined {
  if (declaration.type !== 'ImportDeclaration' || typeof declaration.source?.value !== 'string') {
    return undefined
  }

  const specifier = declaration.source.value
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    specifier.startsWith('\0') ||
    /^[a-z][a-z\d+.-]*:/i.test(specifier)
  ) {
    return undefined
  }

  const segments = specifier.split('/')
  const packageSegmentCount = specifier.startsWith('@') ? 2 : 1
  if (segments.length < packageSegmentCount) {
    return undefined
  }

  const packageName = segments.slice(0, packageSegmentCount).join('/')
  const subpath = segments.length > packageSegmentCount ? `./${segments.slice(packageSegmentCount).join('/')}` : undefined
  return {
    specifier,
    packageName,
    ...(subpath ? { subpath } : {})
  }
}

function getImportedName(specifier: NonNullable<ImportDeclarationNode['specifiers']>[number]): string | undefined {
  if (specifier.type === 'ImportDefaultSpecifier') {
    return 'default'
  }

  if (specifier.type === 'ImportNamespaceSpecifier') {
    return '*'
  }

  if (specifier.type !== 'ImportSpecifier') {
    return undefined
  }

  if (specifier.imported?.name) {
    return specifier.imported.name
  }

  return typeof specifier.imported?.value === 'string' ? specifier.imported.value : undefined
}

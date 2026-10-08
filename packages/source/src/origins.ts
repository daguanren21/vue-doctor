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
  source?: {
    value?: unknown
  }
  specifiers?: Array<{
    type?: string
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
  init?: AstNode
  key?: AstNode
  source?: AstNode
  callee?: AstNode
  object?: AstNode
  property?: AstNode
  computed?: boolean
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

export function collectDirectImportOrigins(program: ProgramNode): Map<string, VueComponentOrigin> {
  const origins = new Map<string, VueComponentOrigin>()

  for (const statement of program.body ?? []) {
    const declaration = statement as ImportDeclarationNode
    if (declaration.type !== 'ImportDeclaration' || typeof declaration.source?.value !== 'string') {
      continue
    }
    const source = declaration.source.value
    const packageReference = getPackageReference(declaration)
    for (const specifier of declaration.specifiers ?? []) {
      const localName = specifier.local?.name
      if (!localName) continue
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

  return origins
}

function componentValueOrigin(
  value: AstNode,
  origins: Map<string, VueComponentOrigin>
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

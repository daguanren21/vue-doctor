type AstNode = {
  type?: string
  name?: string
  value?: unknown
  source?: AstNode
  importKind?: string
  kind?: string
  range?: [number, number]
  body?: AstNode | AstNode[]
  params?: AstNode[]
  id?: AstNode
  local?: AstNode
  imported?: AstNode
  specifiers?: AstNode[]
  declarations?: AstNode[]
  members?: AstNode[]
  param?: AstNode
  key?: AstNode
  argument?: AstNode
  left?: AstNode
  properties?: AstNode[]
  elements?: Array<AstNode | null>
  parent?: AstNode
  [key: string]: unknown
}

export type LexicalBindingKind =
  | 'class'
  | 'enum'
  | 'function'
  | 'import'
  | 'namespace'
  | 'parameter'
  | 'variable'

export interface LexicalBindingFact {
  name: string
  kind: LexicalBindingKind
  /** Module specifier for import bindings. */
  source?: string
  /** Exported name, `default`, or `*` for namespace imports. */
  imported?: string
}

export interface LexicalScopeFact {
  parent?: number
  range: [number, number]
  bindings: LexicalBindingFact[]
}

/** Serializable lexical/import facts derived only from an ESTree-compatible AST. */
export interface ScriptBindingFacts {
  scopes: LexicalScopeFact[]
}

/**
 * Collects module imports and runtime lexical bindings without retaining AST nodes.
 * The result is safe to pass across workers or include in a cache value.
 */
export function collectScriptBindingFacts(program: unknown): ScriptBindingFacts {
  const root = asNode(program)
  if (!root) return { scopes: [] }

  const scopes: LexicalScopeFact[] = [{ range: nodeRange(root), bindings: [] }]

  const addBinding = (scope: number, binding: LexicalBindingFact): void => {
    const bindings = scopes[scope]?.bindings
    if (!bindings || bindings.some((candidate) => candidate.name === binding.name)) return
    bindings.push(binding)
  }

  const nearestFunctionScope = (scope: number): number => {
    let current: number | undefined = scope
    while (current !== undefined) {
      const marker = scopeKinds.get(current)
      if (marker === 'function' || marker === 'module' || marker === 'static') return current
      current = scopes[current]?.parent
    }
    return 0
  }

  const scopeKinds = new Map<number, 'block' | 'function' | 'module' | 'static'>([[0, 'module']])
  const createScope = (
    node: AstNode,
    parent: number,
    kind: 'block' | 'function' | 'static'
  ): number => {
    const index = scopes.push({ parent, range: nodeRange(node), bindings: [] }) - 1
    scopeKinds.set(index, kind)
    return index
  }

  const addPattern = (
    pattern: AstNode | undefined,
    scope: number,
    kind: Exclude<LexicalBindingKind, 'import'>
  ): void => {
    for (const name of patternNames(pattern)) addBinding(scope, { name, kind })
  }

  const walkChildren = (node: AstNode, scope: number): void => {
    for (const [key, value] of Object.entries(node)) {
      if (SKIPPED_KEYS.has(key)) continue
      if (Array.isArray(value)) {
        for (const child of value) {
          const childNode = asNode(child)
          if (childNode) walk(childNode, scope)
        }
      } else {
        const childNode = asNode(value)
        if (childNode) walk(childNode, scope)
      }
    }
  }

  const walk = (node: AstNode, scope: number): void => {
    if (node.type === 'ImportDeclaration') {
      const source = typeof node.source?.value === 'string' ? node.source.value : undefined
      if (!source || node.importKind === 'type') return
      for (const specifier of node.specifiers ?? []) {
        if (specifier.importKind === 'type' || !specifier.local?.name) continue
        const imported = specifier.type === 'ImportNamespaceSpecifier'
          ? '*'
          : specifier.type === 'ImportDefaultSpecifier'
            ? 'default'
            : specifier.imported?.name
              ?? (typeof specifier.imported?.value === 'string' ? specifier.imported.value : undefined)
        addBinding(scope, {
          name: specifier.local.name,
          kind: 'import',
          source,
          ...(imported ? { imported } : {})
        })
      }
      return
    }

    if (node.type === 'FunctionDeclaration') {
      addPattern(node.id, scope, 'function')
      const functionScope = createScope(node, scope, 'function')
      addPattern(node.id, functionScope, 'function')
      for (const parameter of node.params ?? []) addPattern(parameter, functionScope, 'parameter')
      if (asNode(node.body)) walk(node.body as AstNode, functionScope)
      return
    }

    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      const functionScope = createScope(node, scope, 'function')
      if (node.type === 'FunctionExpression') addPattern(node.id, functionScope, 'function')
      for (const parameter of node.params ?? []) addPattern(parameter, functionScope, 'parameter')
      if (asNode(node.body)) walk(node.body as AstNode, functionScope)
      return
    }

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      if (node.type === 'ClassDeclaration') addPattern(node.id, scope, 'class')
      const classScope = createScope(node, scope, 'block')
      addPattern(node.id, classScope, 'class')
      walkChildren(node, classScope)
      return
    }

    if (node.type === 'TSEnumDeclaration' || node.type === 'TSModuleDeclaration') {
      const kind = node.type === 'TSEnumDeclaration' ? 'enum' : 'namespace'
      addPattern(node.id, scope, kind)
      const declarationScope = createScope(node, scope, 'block')
      addPattern(node.id, declarationScope, kind)
      if (node.type === 'TSEnumDeclaration') {
        const enumBody = asNode(node.body)
        for (const member of enumBody?.members ?? []) {
          const name = member.id?.type === 'Identifier'
            ? member.id.name
            : typeof member.id?.value === 'string'
              ? member.id.value
              : undefined
          if (name) addBinding(declarationScope, { name, kind: 'enum' })
        }
      }
      walkChildren(node, declarationScope)
      return
    }

    if (node.type === 'VariableDeclaration') {
      const targetScope = node.kind === 'var' ? nearestFunctionScope(scope) : scope
      for (const declaration of node.declarations ?? []) {
        addPattern(declaration.id, targetScope, 'variable')
        walkChildren(declaration, scope)
      }
      return
    }

    if (node.type === 'CatchClause') {
      const catchScope = createScope(node, scope, 'block')
      addPattern(node.param, catchScope, 'parameter')
      walkChildren(node, catchScope)
      return
    }

    if (createsBlockScope(node)) {
      const blockScope = createScope(node, scope, node.type === 'StaticBlock' ? 'static' : 'block')
      walkChildren(node, blockScope)
      return
    }

    walkChildren(node, scope)
  }

  walkChildren(root, 0)
  return { scopes }
}

/** Returns the binding visible for an identifier at the node's start offset. */
export function resolveLexicalBinding(
  facts: ScriptBindingFacts,
  identifier: unknown
): LexicalBindingFact | undefined {
  const node = asNode(identifier)
  if (node?.type !== 'Identifier' || !node.name) return undefined
  const offset = node.range?.[0]
  if (offset === undefined) return undefined

  const candidates = facts.scopes
    .map((scope, index) => ({ scope, index }))
    .filter(({ scope }) => scope.range[0] <= offset && offset <= scope.range[1])
    .sort((left, right) => scopeDepth(facts, right.index) - scopeDepth(facts, left.index))

  for (const { scope } of candidates) {
    const binding = scope.bindings.find((candidate) => candidate.name === node.name)
    if (binding) return binding
  }
  return undefined
}

/** Resolves only bindings introduced by an ESM import declaration. */
export function resolveImportedBinding(
  facts: ScriptBindingFacts,
  identifier: unknown
): LexicalBindingFact | undefined {
  const binding = resolveLexicalBinding(facts, identifier)
  return binding?.kind === 'import' ? binding : undefined
}

/** True only when no import, parameter, or local declaration owns this identifier. */
export function isUnboundIdentifier(
  facts: ScriptBindingFacts,
  identifier: unknown
): boolean {
  const node = asNode(identifier)
  return node?.type === 'Identifier' && resolveLexicalBinding(facts, node) === undefined
}

const SKIPPED_KEYS = new Set(['parent', 'loc', 'range', 'tokens', 'comments'])

function createsBlockScope(node: AstNode): boolean {
  return node.type === 'BlockStatement'
    || node.type === 'ForStatement'
    || node.type === 'ForInStatement'
    || node.type === 'ForOfStatement'
    || node.type === 'SwitchStatement'
    || node.type === 'StaticBlock'
}

function patternNames(pattern: AstNode | undefined): string[] {
  if (!pattern) return []
  if (pattern.type === 'Identifier') return pattern.name ? [pattern.name] : []
  if (pattern.type === 'RestElement') return patternNames(pattern.argument)
  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left)
  if (pattern.type === 'TSParameterProperty') return patternNames(pattern.parameter as AstNode | undefined)
  if (pattern.type === 'ArrayPattern') {
    return (pattern.elements ?? []).flatMap((element) => patternNames(element ?? undefined))
  }
  if (pattern.type === 'ObjectPattern') {
    return (pattern.properties ?? []).flatMap((property) => {
      if (property.type === 'RestElement') return patternNames(property.argument)
      return patternNames(asNode(property.value) ?? property.argument)
    })
  }
  return []
}

function nodeRange(node: AstNode): [number, number] {
  return node.range ?? [0, Number.MAX_SAFE_INTEGER]
}

function scopeDepth(facts: ScriptBindingFacts, index: number): number {
  let depth = 0
  let current = facts.scopes[index]?.parent
  while (current !== undefined) {
    depth += 1
    current = facts.scopes[current]?.parent
  }
  return depth
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && typeof (value as AstNode).type === 'string'
    ? value as AstNode
    : undefined
}

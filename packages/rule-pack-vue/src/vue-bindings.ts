import {
  collectScriptBindingFacts,
  isUnboundIdentifier,
  resolveImportedBinding,
  resolveLexicalBinding,
  type ScriptBindingFacts
} from '@vue-doctor/source'

type Node = {
  type?: string
  name?: string
  value?: unknown
  range?: [number, number]
  callee?: Node
  object?: Node
  property?: Node
  computed?: boolean
  key?: unknown
  label?: unknown
  shorthand?: boolean
  arguments?: Node[]
  [key: string]: unknown
}

export interface VueAutoImportBinding {
  /** Identifier made available by an auto-import transform. */
  local: string
  /** Vue export represented by the local identifier. */
  imported: string
}

interface VueBindingContext {
  facts: ScriptBindingFacts
  scriptSetup: boolean
  autoImports: readonly VueAutoImportBinding[]
}

const COMPILER_MACROS = new Set([
  'defineEmits',
  'defineExpose',
  'defineModel',
  'defineOptions',
  'defineProps',
  'defineSlots',
  'withDefaults'
])

const bindingContexts = new WeakMap<object, VueBindingContext>()
const parentNodes = new WeakMap<object, Node>()

export function registerVueBindingContext(
  program: Node,
  source: string,
  autoImports: readonly VueAutoImportBinding[] = []
): void {
  const context: VueBindingContext = {
    facts: collectScriptBindingFacts(program),
    scriptSetup: isScriptSetupProgram(program, source),
    autoImports
  }
  walk(program, (node, parent) => {
    bindingContexts.set(node, context)
    if (parent) parentNodes.set(node, parent)
  })
}

export function vueCallName(node: Node | undefined): string | undefined {
  if (node?.type !== 'CallExpression') return undefined
  const callee = node.callee
  const context = callee && bindingContexts.get(callee)
  if (!callee || !context) return undefined

  if (callee.type === 'Identifier' && callee.name) {
    if (COMPILER_MACROS.has(callee.name)) {
      return context.scriptSetup && isUnboundIdentifier(context.facts, callee)
        ? callee.name
        : undefined
    }
    const imported = resolveImportedBinding(context.facts, callee)
    if (imported?.source === 'vue' && imported.imported && imported.imported !== '*') {
      return imported.imported
    }
    if (
      isUnboundIdentifier(context.facts, callee)
    ) {
      return context.autoImports.find((binding) => binding.local === callee.name)?.imported
    }
    return undefined
  }

  if (
    callee.type === 'MemberExpression'
    && !callee.computed
    && callee.object?.type === 'Identifier'
    && callee.property?.type === 'Identifier'
    && callee.property.name
  ) {
    const namespace = resolveImportedBinding(context.facts, callee.object)
    if (
      namespace?.source === 'vue'
      && (namespace.imported === '*' || namespace.imported === 'default')
      && !COMPILER_MACROS.has(callee.property.name)
    ) {
      return callee.property.name
    }
  }
  return undefined
}

export function isVueCall(node: Node | undefined, name: string): boolean {
  return vueCallName(node) === name
}

export function isUnshadowedGlobalCall(node: Node | undefined, name: string): boolean {
  if (
    node?.type !== 'CallExpression'
    || node.callee?.type !== 'Identifier'
    || node.callee.name !== name
  ) {
    return false
  }
  const context = bindingContexts.get(node.callee)
  return Boolean(context && isUnboundIdentifier(context.facts, node.callee))
}

export function isUnshadowedGlobalIdentifier(node: Node | undefined, name: string): boolean {
  if (node?.type !== 'Identifier' || node.name !== name) return false
  const context = bindingContexts.get(node)
  return Boolean(
    context
    && isIdentifierValueReference(node)
    && isUnboundIdentifier(context.facts, node)
  )
}

export function isSameLexicalBinding(left: Node | undefined, right: Node | undefined): boolean {
  if (!left || !right) return false
  const leftContext = bindingContexts.get(left)
  const rightContext = bindingContexts.get(right)
  if (!leftContext || leftContext !== rightContext) return false
  const leftBinding = resolveLexicalBinding(leftContext.facts, left)
  const rightBinding = resolveLexicalBinding(rightContext.facts, right)
  return Boolean(leftBinding && leftBinding === rightBinding)
}

export function isInsideVueCallCallback(
  node: Node,
  names: ReadonlySet<string>
): boolean {
  let current: Node | undefined = node
  while (current) {
    if (isFunction(current)) {
      const parent = parentNodes.get(current)
      if (parent?.type === 'CallExpression' && parent.arguments?.includes(current)) {
        const name = vueCallName(parent)
        if (name && names.has(name)) return true
      }
    }
    current = parentNodes.get(current)
  }
  return false
}

export function isAfterAwaitInVueWatcher(node: Node): boolean {
  let current: Node | undefined = node
  while (current) {
    if (isFunction(current)) {
      const call = parentNodes.get(current)
      const name = vueCallName(call)
      const callbackIndex = name === 'watch' ? 1 : name === 'watchEffect' ? 0 : -1
      if (callbackIndex >= 0 && call?.arguments?.[callbackIndex] === current) {
        const targetOffset = node.range?.[0]
        if (targetOffset === undefined) return false
        let found = false
        walk(current, (child) => {
          if (child.type === 'AwaitExpression' && (child.range?.[0] ?? targetOffset) < targetOffset) {
            found = true
          }
        })
        return found
      }
    }
    current = parentNodes.get(current)
  }
  return false
}

export function programContainsVueCall(node: Node, names: ReadonlySet<string>): boolean {
  const context = bindingContexts.get(node)
  if (context?.facts.scopes.some((scope) => scope.bindings.some((binding) => (
    binding.kind === 'import'
    && binding.source === 'vue'
    && binding.imported !== undefined
    && names.has(binding.imported)
  )))) {
    return true
  }
  let root = node
  let parent = parentNodes.get(root)
  while (parent) {
    root = parent
    parent = parentNodes.get(root)
  }
  let found = false
  walk(root, (candidate) => {
    const name = vueCallName(candidate)
    if (name && names.has(name)) found = true
  })
  return found
}

function isScriptSetupProgram(program: Node, source: string): boolean {
  const start = program.range?.[0]
  if (start === undefined || !source) return false
  const prefix = source.slice(0, start)
  const opening = prefix.slice(prefix.lastIndexOf('<script'))
  return /^<script\b[^>]*\bsetup(?:\s|=|>)/i.test(opening)
}

function isIdentifierValueReference(node: Node): boolean {
  const parent = parentNodes.get(node)
  if (!parent) return true
  if (
    parent.type === 'ImportSpecifier'
    || parent.type === 'ImportDefaultSpecifier'
    || parent.type === 'ImportNamespaceSpecifier'
    || parent.type === 'ExportSpecifier'
  ) {
    return false
  }
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
    return false
  }
  if (
    (parent.type === 'Property'
      || parent.type === 'MethodDefinition'
      || parent.type === 'PropertyDefinition')
    && parent.key === node
    && !parent.computed
  ) {
    return parent.type === 'Property' && parent.shorthand === true
  }
  if (
    (parent.type === 'LabeledStatement'
      || parent.type === 'BreakStatement'
      || parent.type === 'ContinueStatement')
    && parent.label === node
  ) {
    return false
  }
  if (parent.type === 'MetaProperty') return false
  return true
}

function walk(node: Node, visit: (node: Node, parent?: Node) => void, parent?: Node): void {
  visit(node, parent)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) walk(child, visit, node)
      }
    } else if (isNode(value)) {
      walk(value, visit, node)
    }
  }
}

function isFunction(node: Node): boolean {
  return node.type === 'ArrowFunctionExpression'
    || node.type === 'FunctionExpression'
    || node.type === 'FunctionDeclaration'
}

function isNode(value: unknown): value is Node {
  return Boolean(value && typeof value === 'object' && typeof (value as Node).type === 'string')
}

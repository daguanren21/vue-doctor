import {
  isDoctorRuleApplicable,
  resolveVueVersion,
  type Diagnostic,
  type ResolvedVueVersion
} from '@vue-doctor/core'
import type { ParsedVueSource } from '@vue-doctor/source'
import { getVueRuleDefinition, resolveVueRuleSeverity } from './rules.js'
import {
  isUnshadowedGlobalCall,
  isUnshadowedGlobalIdentifier,
  isAfterAwaitInVueWatcher,
  isInsideVueCallCallback,
  isSameLexicalBinding,
  isVueCall,
  programContainsVueCall,
  registerVueBindingContext,
  vueCallName,
  type VueAutoImportBinding
} from './vue-bindings.js'

export { vueRuleDefinitions } from './rules.js'
export type { VueAutoImportBinding } from './vue-bindings.js'

export interface DiagnoseVueSourceOptions {
  file: string
  parsed: ParsedVueSource
  /** Original SFC source text. Required for text-span rules (lifecycle/watch cleanup). */
  source?: string
  /** Installed Vue version used to gate version-specific diagnostics. Defaults to current Vue 3. */
  vueVersion?: string
  /** Treat an unresolvable version as current Vue 3. Defaults true for direct API callers. */
  assumeLatestVueVersion?: boolean
  /** Explicit bindings proven to be provided by a Vue auto-import transform. */
  autoImports?: readonly VueAutoImportBinding[]
}

const MINIMUM_VUE_VERSION_BY_API: Record<string, { major: number; minor: number }> = {
  defineModel: { major: 3, minor: 4 },
  onWatcherCleanup: { major: 3, minor: 5 },
  useId: { major: 3, minor: 5 },
  useModel: { major: 3, minor: 4 },
  useTemplateRef: { major: 3, minor: 5 }
}

const VUE_2_UNSUPPORTED_REACTIVE_CONSTRUCTORS = new Set([
  'Date',
  'Error',
  'Map',
  'Promise',
  'RegExp',
  'Set',
  'WeakMap',
  'WeakSet'
])

const POST_SETUP_LIFECYCLE_NAMES = new Set([
  'onActivated',
  'onBeforeUnmount',
  'onBeforeUpdate',
  'onDeactivated',
  'onMounted',
  'onUnmounted',
  'onUpdated'
])

const SETUP_CONTEXT_API_NAMES = new Set([
  'getCurrentInstance',
  'inject',
  'onActivated',
  'onBeforeMount',
  'onBeforeUnmount',
  'onBeforeUpdate',
  'onDeactivated',
  'onErrorCaptured',
  'onMounted',
  'onRenderTracked',
  'onRenderTriggered',
  'onScopeDispose',
  'onServerPrefetch',
  'onUnmounted',
  'onUpdated',
  'provide'
])

export function isVueRuleAvailable(
  ruleCode: string,
  vueVersion?: string,
  options: { assumeLatest?: boolean } = {}
): boolean {
  const definition = getVueRuleDefinition(ruleCode)
  if (!definition) return true
  const resolvedVersion = resolveVueVersion(vueVersion)
  const vue = definition.applicability?.vue
  if (!resolvedVersion && options.assumeLatest === false) {
    return !vue && definition.requires?.vueVersion !== 'known'
  }
  // Compatibility for the original public helper: any resolved non-Vue-3 major followed
  // the Vue 2 branch, including unsupported majors. Generic applicability remains strict.
  if (resolvedVersion && resolvedVersion.major !== 3) {
    return vue?.only !== 3 && vue?.minimumMinor === undefined
  }
  return isDoctorRuleApplicable(definition, {
    vueVersion,
    assumeLatestVueVersion: options.assumeLatest ?? true
  })
}

type Node = {
  type?: string
  name?: string
  rawName?: string
  key?: {
    name?: string | { name?: string }
    argument?: { name?: string; rawName?: string; value?: string } | null
    modifiers?: Array<string | { name?: string }>
  }
  directive?: boolean
  value?: { expression?: Node | null; raw?: string; value?: unknown } | null
  startTag?: { attributes?: Node[] }
  consequent?: Node
  alternate?: Node | null
  children?: Node[]
  declaration?: Node
  declarations?: Node[]
  body?: Node[] | Node
  id?: Node
  local?: Node
  specifiers?: Node[]
  init?: Node
  callee?: Node
  arguments?: Node[]
  properties?: Node[]
  params?: Node[]
  left?: Node | Node[]
  test?: Node
  right?: Node
  argument?: Node
  property?: Node
  object?: Node
  operator?: string
  computed?: boolean
  async?: boolean
  filters?: Node[]
  expression?: Node
  range?: [number, number]
  loc?: { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } }
  elements?: Node[]
  parent?: Node
}

class TrackedBindings {
  private readonly declarations = new Map<string, Node[]>()

  get size(): number {
    return [...this.declarations.values()].reduce((total, values) => total + values.length, 0)
  }

  add(declaration: Node | undefined): void {
    if (declaration?.type !== 'Identifier' || !declaration.name) return
    const values = this.declarations.get(declaration.name) ?? []
    values.push(declaration)
    this.declarations.set(declaration.name, values)
  }

  has(reference: Node | undefined): boolean {
    return this.resolve(reference) !== undefined
  }

  resolve(reference: Node | undefined): Node | undefined {
    if (reference?.type !== 'Identifier' || !reference.name) return undefined
    return (this.declarations.get(reference.name) ?? []).find(
      (declaration) => isSameLexicalBinding(declaration, reference)
    )
  }

  values(): Node[] {
    return [...this.declarations.values()].flat()
  }
}

interface TemplateRefBinding {
  declaration: Node
  key?: string
  node: Node
}

interface ReactiveBindingAnalysis {
  names: TrackedBindings
  shallowNames: TrackedBindings
  reactiveNames: TrackedBindings
  shallowReactiveNames: TrackedBindings
  readonlyNames: TrackedBindings
  shallowReadonlyNames: TrackedBindings
  detachedEffectScopeNodes: Map<Node, Node>
  triggeredShallowRefs: TrackedBindings
  detachedEffectScopes: TrackedBindings
  runEffectScopes: Set<Node>
  stoppedEffectScopes: Set<Node>
  escapedEffectScopes: Set<Node>
  computedReadonlyNames: TrackedBindings
  templateRefBindings: TemplateRefBinding[]
  effectScopeNames: TrackedBindings
  watchHandleNames: TrackedBindings
  appNames: TrackedBindings
  writeCounts: Map<Node, number>
}

interface AppApiState {
  mounted: Set<string>
  installedPlugins: Set<string>
  registrations: Set<string>
}

export function diagnoseVueSource(options: DiagnoseVueSourceOptions): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const scriptBindings = new Set<string>()
  const source = options.source ?? ''
  const templateRefs = new Set<string>()
  const propObjectNames = new Set<string>()
  const destructuredProps = new Set<string>()
  const optionPropNames = new Set<string>()
  const resolvedVueVersion = resolveVueVersion(options.vueVersion)
    ?? ((options.assumeLatestVueVersion ?? true)
      ? { major: 3, minor: 5, patch: 0 }
      : undefined)
  const templateRoot = (options.parsed.templateAst as { templateBody?: Node } | undefined)?.templateBody
  if (templateRoot) {
    visitTemplate(templateRoot, (node) => {
      collectTemplateRef(node, templateRefs)
      diagnoseTemplateNode(node, options.file, diagnostics)
      diagnoseDataAllowMismatch(node, options.file, diagnostics, source)
    })
    diagnoseIfElseBranchKeys(templateRoot, options.file, diagnostics)
    diagnoseSlotIssues(templateRoot, options.file, diagnostics)
  }

  for (const program of options.parsed.scriptPrograms as Node[]) {
    registerVueBindingContext(program, source, options.autoImports)
    collectScriptBindings(program, scriptBindings)
    const programPropBindings = findDefinePropsBindings(program)
    const programDestructuredProps = findDestructuredDefineProps(program)
    for (const binding of programPropBindings.values()) {
      if (binding.name) propObjectNames.add(binding.name)
    }
    for (const binding of programDestructuredProps.values()) {
      if (binding.name) destructuredProps.add(binding.name)
    }
    for (const name of findDeclaredOptionProps(program)) optionPropNames.add(name)
    diagnoseScriptProgram(
      program,
      options.file,
      diagnostics,
      source,
      templateRefs,
      optionPropNames,
      programPropBindings,
      programDestructuredProps,
      resolvedVueVersion
    )
  }

  if (templateRoot) {
    diagnoseTemplateWithScriptContext(templateRoot, options.file, diagnostics, {
      scriptBindings,
      propObjectNames,
      destructuredProps
    })
  }

  if (source) {
    diagnoseLifecycleCleanup(options.parsed.scriptPrograms as Node[], source, options.file, diagnostics)
  }

  return diagnostics.filter((diagnostic) => isVueRuleAvailable(
    diagnostic.code,
    options.vueVersion,
    { assumeLatest: options.assumeLatestVueVersion ?? true }
  ))
}

function diagnoseTemplateNode(
  node: Node,
  file: string,
  diagnostics: Diagnostic[]
): void {
  const attributes = node.startTag?.attributes ?? []
  const names = new Set(attributes.map(getDirectiveName).filter(Boolean))

  // Aligned with vite-doctor vue/security/restrict-v-html (error).
  if (names.has('html')) {
    diagnostics.push(createDiagnostic(
      'vue-security-restrict-v-html',
      'v-html can execute untrusted markup. Only render sanitized or trusted HTML here.',
      file,
      node,
      'Remove v-html or sanitize the HTML before rendering it.'
    ))
  }

  if (names.has('if') && names.has('for')) {
    diagnostics.push(createDiagnostic(
      'vue-template-v-if-for',
      'v-if and v-for are used on the same element.',
      file,
      node,
      'Move the condition to a wrapper or derive a filtered collection with computed().'
    ))
  }

  // Vue compiler error 28/31: missing expressions.
  for (const attribute of attributes) {
    const dir = getDirectiveName(attribute)
    if ((dir === 'if' || dir === 'else-if') && !hasDirectiveExpression(attribute)) {
      diagnostics.push(createDiagnostic(
        'vue-if-missing-expression',
        'v-if/v-else-if is missing expression.',
        file,
        attribute,
        'Provide a boolean expression for v-if / v-else-if.'
      ))
    }
    if (dir === 'for' && !hasDirectiveExpression(attribute)) {
      diagnostics.push(createDiagnostic(
        'vue-for-missing-expression',
        'v-for is missing expression.',
        file,
        attribute,
        'Provide a valid v-for expression such as "item in items".'
      ))
    }
  }

  if (
    names.has('for')
    && hasDirectiveExpression(attributes.find((attribute) => getDirectiveName(attribute) === 'for'))
    && !attributes.some((attribute) => getDirectiveName(attribute) === 'bind' && getArgumentName(attribute) === 'key')
  ) {
    diagnostics.push(createDiagnostic(
      'vue-template-v-for-key',
      'A v-for element does not declare a stable :key.',
      file,
      node,
      'Add a stable primitive :key such as item.id.'
    ))
  }

  // Vue compiler error 33: <template v-for> key should be placed on the <template> tag.
  if ((node.rawName === 'template' || node.name === 'template') && names.has('for')) {
    const templateHasKey = attributes.some((attribute) => getDirectiveName(attribute) === 'bind' && getArgumentName(attribute) === 'key')
    if (!templateHasKey) {
      const childHasKey = (node.children ?? []).some((child) => {
        if (child.type !== 'VElement') return false
        return (child.startTag?.attributes ?? []).some((attribute) => getDirectiveName(attribute) === 'bind' && getArgumentName(attribute) === 'key')
      })
      if (childHasKey) {
        diagnostics.push(createDiagnostic(
          'vue-template-v-for-key-placement',
          '<template v-for> key should be placed on the <template> tag, not on its children.',
          file,
          node,
          'Move :key to the <template v-for> element.'
        ))
      }
    }
  }

  // vite-doctor: vue/template/html-button-has-type
  if (node.rawName === 'button' || node.name === 'button') {
    const hasType = attributes.some((attribute) => {
      if (!attribute.directive) {
        const name = typeof attribute.key?.name === 'string' ? attribute.key.name : attribute.key?.name?.name
        return name === 'type'
      }
      return getDirectiveName(attribute) === 'bind' && getArgumentName(attribute) === 'type'
    })
    if (!hasType) {
      diagnostics.push(createDiagnostic(
        'vue-html-button-has-type',
        'Native buttons should declare type="button", type="submit", or type="reset".',
        file,
        node,
        'Add type="button" unless this button intentionally submits a form.'
      ))
    }
  }

  // Vue runtime: invalid key NaN
  for (const attribute of attributes) {
    if (getDirectiveName(attribute) === 'bind' && getArgumentName(attribute) === 'key' && isNaNKeyExpression((attribute.value as { expression?: Node | null } | null)?.expression)) {
      diagnostics.push(createDiagnostic(
        'vue-invalid-key-nan',
        'VNode created with invalid key (NaN).',
        file,
        attribute,
        'Use a stable non-NaN key such as a string or number id.'
      ))
    }
  }

  // Vue compiler deprecations / Vue 2 leftovers
  for (const attribute of attributes) {
    const mods = getModifiers(attribute)
    if (getDirectiveName(attribute) === 'bind' && mods.includes('sync')) {
      const arg = getArgumentName(attribute) ?? 'value'
      diagnostics.push(createDiagnostic(
        'vue-v-bind-sync-removed',
        `.sync modifier for v-bind has been removed. Use v-model with argument instead. v-bind:${arg}.sync should be changed to v-model:${arg}.`,
        file,
        attribute,
        `Replace v-bind:${arg}.sync with v-model:${arg}.`
      ))
    }
    if (getDirectiveName(attribute) === 'on' && mods.includes('native')) {
      diagnostics.push(createDiagnostic(
        'vue-v-on-native-removed',
        '.native modifier for v-on has been removed as is no longer necessary.',
        file,
        attribute,
        'Remove the .native modifier.'
      ))
    }

    // Vue compiler error 52: @vnode-* hooks removed in 3.4, use @vue:*
    if (getDirectiveName(attribute) === 'on' && isDeprecatedVnodeHookArg(getArgumentName(attribute))) {
      const arg = getArgumentName(attribute) ?? 'hook'
      const suggested = toVuePrefixedHook(arg)
      diagnostics.push(createDiagnostic(
        'vue-vnode-hook-prefix',
        '@vnode-* hooks in templates are no longer supported. Use the vue: prefix instead. For example, @vnode-mounted should be changed to @vue:mounted.',
        file,
        attribute,
        `Replace @${arg} with @${suggested}.`
      ))
    }
  }

  // Vue 3 filters removed
  diagnoseRemovedFilters(node, file, diagnostics)

  // KeepAlive expects exactly one component child
  if (isKeepAliveElement(node)) {
    const componentChildren = (node.children ?? []).filter((child) => child.type === 'VElement')
    if (componentChildren.length !== 1) {
      diagnostics.push(createDiagnostic(
        'vue-keepalive-single-child',
        '<KeepAlive> expects exactly one child component.',
        file,
        node,
        'Wrap multiple children in a single component, or render only one child.'
      ))
    }
  }
}

/**
 * Vue compiler errors 29/30:
 * - v-if / v-else branches must use unique keys
 * - v-else/v-else-if has no adjacent v-if or v-else-if
 */
function diagnoseIfElseBranchKeys(root: Node, file: string, diagnostics: Diagnostic[]): void {
  const walk = (parent: Node) => {
    const elements = (parent.children ?? []).filter((child) => child.type === 'VElement')
    let chain: Node[] = []
    let chainHasIf = false

    const flush = () => {
      if (chain.length >= 2) {
        const seen = new Map<string, Node>()
        for (const branch of chain) {
          const keyText = getKeyExpressionText(branch)
          if (!keyText) continue
          const previous = seen.get(keyText)
          if (previous) {
            diagnostics.push(createDiagnostic(
              'vue-if-else-duplicate-key',
              `v-if / v-else branches must use unique keys (duplicate key: ${keyText}).`,
              file,
              branch,
              'Give each branch a unique :key value.'
            ))
          } else {
            seen.set(keyText, branch)
          }
        }
      }
      chain = []
      chainHasIf = false
    }

    for (const element of elements) {
      const names = new Set((element.startTag?.attributes ?? []).map(getDirectiveName).filter(Boolean))
      if (names.has('if')) {
        flush()
        chain = [element]
        chainHasIf = true
      } else if (names.has('else-if') || names.has('else')) {
        if (!chainHasIf) {
          diagnostics.push(createDiagnostic(
            'vue-else-without-if',
            'v-else/v-else-if has no adjacent v-if or v-else-if.',
            file,
            element,
            'Place v-else/v-else-if immediately after a v-if or v-else-if branch.'
          ))
          chain = []
          chainHasIf = false
        } else {
          chain.push(element)
        }
      } else {
        flush()
      }
      walk(element)
    }
    flush()
  }

  walk(root)
}

function getKeyExpressionText(node: Node): string | undefined {
  const keyAttr = (node.startTag?.attributes ?? []).find((attribute) =>
    getDirectiveName(attribute) === 'bind' && getArgumentName(attribute) === 'key'
  )
  if (!keyAttr?.value) return undefined
  const expression = (keyAttr.value as { expression?: Node | null }).expression
  if (!expression) return undefined
  if (expression.type === 'Literal') {
    return String((expression as { value?: unknown }).value)
  }
  if (expression.type === 'Identifier' && expression.name) return expression.name
  if (expression.type === 'MemberExpression') {
    const object = expression.object?.name ?? expression.object?.type
    const property = expression.property?.name ?? 'computed'
    return `${object}.${property}`
  }
  return expression.type
}

function diagnoseTemplateWithScriptContext(
  root: Node,
  file: string,
  diagnostics: Diagnostic[],
  context: {
    scriptBindings: Set<string>
    propObjectNames: Set<string>
    destructuredProps: Set<string>
  }
): void {
  const walk = (node: Node, forScopes: string[][]) => {
    diagnoseTemplateShadow(node, file, diagnostics, context.scriptBindings)
    diagnoseIllegalVModel(node, file, diagnostics, forScopes, context.propObjectNames, context.destructuredProps)

    const attributes = node.startTag?.attributes ?? []
    const forAttribute = attributes.find((attribute) => getDirectiveName(attribute) === 'for')
    const aliases = forAttribute ? collectIdentifiers(forAttribute.value?.expression?.left) : []
    const nextScopes = aliases.length > 0 ? [...forScopes, aliases] : forScopes

    for (const child of node.children ?? []) {
      if (child && typeof child === 'object') walk(child, nextScopes)
    }
  }

  walk(root, [])
}

/**
 * Vue compiler errors 43/44/45:
 * - v-model on prop bindings
 * - v-model on v-for / v-slot scope variables
 */
function diagnoseIllegalVModel(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  forScopes: string[][],
  propObjectNames: Set<string>,
  destructuredProps: Set<string>
): void {
  const attributes = node.startTag?.attributes ?? []
  const modelAttrs = attributes.filter((attribute) => getDirectiveName(attribute) === 'model')
  if (modelAttrs.length === 0) return

  const scopeNames = new Set(forScopes.flat())

  for (const attribute of modelAttrs) {
    const expression = (attribute.value as { expression?: Node | null } | null | undefined)?.expression
    if (!expression) continue

    if (expression.type === 'MemberExpression'
      && expression.object?.type === 'Identifier'
      && expression.object.name
      && propObjectNames.has(expression.object.name)
    ) {
      const propName = expression.property?.name ?? 'prop'
      diagnostics.push(createDiagnostic(
        'vue-model-on-prop',
        `v-model cannot be used on prop "${propName}" because local prop bindings are not writable.`,
        file,
        attribute,
        'Use a v-bind binding combined with a v-on listener that emits update:x instead.'
      ))
      continue
    }

    if (expression.type === 'Identifier' && expression.name && destructuredProps.has(expression.name)) {
      diagnostics.push(createDiagnostic(
        'vue-model-on-prop',
        `v-model cannot be used on prop "${expression.name}" because local prop bindings are not writable.`,
        file,
        attribute,
        'Use a v-bind binding combined with a v-on listener that emits update:x instead.'
      ))
      continue
    }

    if (expression.type === 'Identifier' && expression.name && scopeNames.has(expression.name)) {
      diagnostics.push(createDiagnostic(
        'vue-model-on-scope-var',
        `v-model cannot be used on v-for or v-slot scope variable "${expression.name}" because it is not writable.`,
        file,
        attribute,
        'Bind a component data/ref property instead of a scoped template variable.'
      ))
    }
  }
}

function diagnoseTemplateShadow(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  scriptBindings: Set<string>
): void {
  const attributes = node.startTag?.attributes ?? []
  const forAttribute = attributes.find((attribute) => getDirectiveName(attribute) === 'for')
  const aliases = forAttribute ? collectIdentifiers(forAttribute.value?.expression?.left) : []
  if (!aliases.some((alias) => scriptBindings.has(alias))) return
  const shadowed = aliases.filter((alias) => scriptBindings.has(alias)).join(', ')
  if (diagnostics.some((item) => item.code === 'vue-template-shadow' && item.file === file && item.message.includes(shadowed))) {
    return
  }
  diagnostics.push(createDiagnostic(
    'vue-template-shadow',
    `Template v-for scope shadows a script binding (${shadowed}).`,
    file,
    node,
    'Rename the v-for alias or the outer binding so template scope remains explicit.'
  ))
}

function collectTemplateRef(node: Node, refs: Set<string>): void {
  const attributes = node.startTag?.attributes ?? []
  for (const attribute of attributes) {
    if (attribute.directive) continue
    const name = typeof attribute.key?.name === 'string' ? attribute.key.name : attribute.key?.name?.name
    if (name !== 'ref') continue
    const literal = (attribute.value as { value?: unknown; raw?: string } | null | undefined)
    const raw = typeof literal?.value === 'string'
      ? literal.value
      : literal?.raw?.replace(/^['"]|['"]$/g, '')
    if (raw) refs.add(raw)
  }
}

function diagnoseScriptProgram(
  program: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string,
  templateRefs: Set<string>,
  optionPropNames: Set<string>,
  propBindings: TrackedBindings,
  destructuredDefineProps: TrackedBindings,
  vueVersion: ResolvedVueVersion | undefined
): void {
  const propNames = optionPropNames.size > 0 ? optionPropNames : findDeclaredOptionProps(program)
  const refAnalysis = findRefBindings(program)
  const refBindings = refAnalysis.names
  const definePropsNames = new Map<string, Node>()
  const defineEmitNames = new Set<string>()
  const inactiveEffectScopes = new Set<Node>()
  const ssrSignal = hasSsrSignal(program, source, file)
  const appApiState: AppApiState = {
    mounted: new Set(),
    installedPlugins: new Set(),
    registrations: new Set()
  }
  let hasDefineModel = false

  visitScript(program, (node) => {
    if (isVueCall(node, 'defineModel')) hasDefineModel = true
    collectDefinePropsNames(node, definePropsNames)
    collectDefineEmitNames(node, defineEmitNames)

    diagnosePropMutation(node, file, diagnostics, propNames, propBindings, destructuredDefineProps)
    diagnoseSetupPropsDestructure(node, file, diagnostics, source)
    diagnoseRefAsOperand(node, file, diagnostics, refBindings)
    diagnoseDefinePropsWatchGetter(node, file, diagnostics, destructuredDefineProps)
    diagnoseWatcherSideEffectCleanup(node, file, diagnostics, source)
    diagnoseWatchDerivedState(node, file, diagnostics, refBindings, refAnalysis.writeCounts, source)
    diagnoseWatchReactiveProperty(
      node,
      file,
      diagnostics,
      refAnalysis.reactiveNames,
      propBindings,
      refBindings
    )
    diagnoseWatchSelfMutation(node, file, diagnostics, refBindings, source, vueVersion)
    diagnoseWatchAsyncStaleWrite(
      node,
      file,
      diagnostics,
      refBindings,
      refAnalysis.writeCounts,
      source,
      vueVersion
    )
    diagnosePostFlushDomWatch(node, file, diagnostics, source)
    diagnoseAsyncWatchEffectAfterAwait(node, file, diagnostics, source)
    diagnoseOnWatcherCleanupAfterAwait(node, file, diagnostics, source)
    diagnoseMutationInOnUpdated(node, file, diagnostics, source)
    diagnoseShallowRefNestedMutation(
      node,
      file,
      diagnostics,
      refAnalysis.shallowNames,
      refAnalysis.triggeredShallowRefs
    )
    diagnoseReactiveReassignment(node, file, diagnostics, refAnalysis.reactiveNames)
    diagnoseReadonlyMutation(
      node,
      file,
      diagnostics,
      refAnalysis.readonlyNames,
      refAnalysis.shallowReadonlyNames
    )
    diagnoseShallowReactiveNestedMutation(
      node,
      file,
      diagnostics,
      refAnalysis.shallowReactiveNames
    )
    diagnoseCustomRefContract(node, file, diagnostics, source)
    diagnoseToRefsPlainObject(node, file, diagnostics)
    diagnoseVersionedWatchOptions(node, file, diagnostics, source, vueVersion)
    diagnoseVersionedVueApi(node, file, diagnostics, vueVersion)
    diagnoseVue2ReactiveTarget(node, file, diagnostics, vueVersion)
    diagnoseVue2ReadonlyTarget(node, file, diagnostics, vueVersion)
    diagnoseComputedReadonlyWrite(
      node,
      file,
      diagnostics,
      refAnalysis.computedReadonlyNames,
      refAnalysis.templateRefBindings
    )
    diagnoseEffectScopeState(
      node,
      file,
      diagnostics,
      refAnalysis.effectScopeNames,
      inactiveEffectScopes,
      vueVersion
    )
    diagnoseVersionedHandleMethods(
      node,
      file,
      diagnostics,
      refAnalysis.watchHandleNames,
      vueVersion
    )
    diagnoseAsyncComponentUsage(node, file, diagnostics, vueVersion)
    diagnoseAppApiUsage(
      node,
      file,
      diagnostics,
      refAnalysis.appNames,
      appApiState,
      vueVersion
    )
    diagnoseProvideAfterSetup(node, file, diagnostics)
    diagnoseVue2TriggerRef(node, file, diagnostics, refAnalysis, vueVersion)
    diagnosePreferUseTemplateRef(node, file, diagnostics, templateRefs)
    diagnoseBrowserApiInSetup(node, file, diagnostics, source, ssrSignal)
    diagnoseRandomOrLocalTimeRender(node, file, diagnostics, source, ssrSignal)
    diagnoseAsyncSetupWithoutSuspense(node, file, diagnostics)
    diagnoseVue2AsyncSetup(node, file, diagnostics, vueVersion)
    diagnoseStaticIsShallow(node, file, diagnostics, refAnalysis, vueVersion)
    diagnoseVue2ObserverMutation(node, file, diagnostics, vueVersion)
    diagnoseSetupContextExpose(node, file, diagnostics, vueVersion)
    diagnoseInjectionUsage(node, file, diagnostics, vueVersion)
    diagnoseUseModel(node, file, diagnostics, propNames, definePropsNames)
  })

  diagnoseDetachedEffectScopes(file, diagnostics, refAnalysis)
  diagnoseTemplateRefContracts(
    file,
    diagnostics,
    refAnalysis.templateRefBindings,
    templateRefs,
    vueVersion
  )
  diagnoseDuplicateProvideKeys(program, file, diagnostics)
  diagnoseSetupApiOutsideContext(program, file, diagnostics, source, vueVersion)
  diagnoseToRawEscapes(program, file, diagnostics)
  diagnosePreferDefineModel(file, diagnostics, definePropsNames, defineEmitNames, hasDefineModel, source)
}

/**
 * Aligns with runtime-core warn: "Attempting to mutate prop ... Props are readonly."
 * Covers Options API this.prop, props.foo, and destructured defineProps locals.
 */
function diagnosePropMutation(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  propNames: Set<string>,
  propBindings: TrackedBindings,
  destructuredProps: TrackedBindings
): void {
  if (node.type !== 'AssignmentExpression' && node.type !== 'UpdateExpression') return
  const target = node.type === 'AssignmentExpression'
    ? (Array.isArray(node.left) ? undefined : node.left)
    : node.argument
  if (!target) return

  // Destructured defineProps local: count++ / count = 1
  if (target.type === 'Identifier' && target.name && destructuredProps.has(target)) {
    diagnostics.push(createDiagnostic(
      'vue-prop-mutated',
      `Attempting to mutate prop "${target.name}". Props are readonly.`,
      file,
      node,
      'Treat props as read-only and emit an update event or use local state.'
    ))
    return
  }

  if (target.type !== 'MemberExpression') return
  const isOptionProp = target.object?.type === 'ThisExpression'
  const isSetupProp = target.object?.type === 'Identifier'
    && propBindings.has(target.object)
  if (!isOptionProp && !isSetupProp) return
  const name = target.property?.name
  if (!name) return
  // Only report this.prop when the name is a known Options API prop.
  // Empty propNames must not treat plain class fields (this.id = …) as props.
  if (isOptionProp && !propNames.has(name)) return
  diagnostics.push(createDiagnostic(
    'vue-prop-mutated',
    `Attempting to mutate prop "${name}". Props are readonly.`,
    file,
    node,
    'Treat props as read-only and emit an update event or use local state.'
  ))
}

/** vite-doctor: vue/reactivity/no-setup-props-destructure */
function diagnoseSetupPropsDestructure(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string
): void {
  if (node.type !== 'VariableDeclarator' || node.id?.type !== 'ObjectPattern') return
  if (node.init?.type !== 'Identifier' || node.init.name !== 'props') return
  if (!source) return
  const start = node.range?.[0] ?? 0
  const prefix = source.slice(0, start)
  if (!/setup\s*\(\s*props\b/.test(prefix)) return
  diagnostics.push(createDiagnostic(
    'vue-setup-props-destructure',
    'Destructuring setup(props) creates non-reactive local values.',
    file,
    node,
    'Use props.foo, toRefs(props), or migrate to <script setup> reactive props destructuring.'
  ))
}

/**
 * Practical subset of vite-doctor/eslint vue/no-ref-as-operand.
 * Flags arithmetic / unary ops on identifiers known to come from ref()/shallowRef().
 */
function diagnoseRefAsOperand(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  refBindings: TrackedBindings
): void {
  if (refBindings.size === 0) return

  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
    for (const side of [node.left, node.right]) {
      const reference = Array.isArray(side) ? undefined : side
      const id = asIdentifier(side)
      if (id && refBindings.has(reference)) {
        diagnostics.push(createDiagnostic(
          'vue-ref-as-operand',
          `Ref "${id}" is used as an operand without .value.`,
          file,
          (side as Node) ?? node,
          `Use ${id}.value in script expressions.`
        ))
      }
    }
  }

  if (node.type === 'UnaryExpression' || node.type === 'UpdateExpression') {
    const id = asIdentifier(node.argument)
    const reference = Array.isArray(node.argument) ? undefined : node.argument
    if (id && refBindings.has(reference)) {
      diagnostics.push(createDiagnostic(
        'vue-ref-as-operand',
        `Ref "${id}" is used as an operand without .value.`,
        file,
        node.argument ?? node,
        `Use ${id}.value in script expressions.`
      ))
    }
  }
}

/** vite-doctor: vue/watch/require-post-flush-for-dom-read */
function diagnosePostFlushDomWatch(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string
): void {
  if (!isVueCall(node, 'watch')) return
  if (!source || !node.range) return
  const snippet = source.slice(node.range[0], node.range[1])
  if (!hasDomRead(snippet)) return
  if (/flush\s*:\s*['"]post['"]/.test(snippet)) return
  diagnostics.push(createDiagnostic(
    'vue-watch-require-post-flush',
    'This watcher reads DOM state before Vue has flushed owner DOM updates.',
    file,
    node,
    "Pass { flush: 'post' } or use watchPostEffect()."
  ))
}

/** vite-doctor: vue/watch/no-async-watcheffect-after-await-read */
function diagnoseAsyncWatchEffectAfterAwait(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string
): void {
  if (!isVueCall(node, 'watchEffect')) return
  if (!source || !node.range) return
  const snippet = source.slice(node.range[0], node.range[1])
  if (!/\basync\b/.test(snippet)) return
  if (!/\bawait\b[\s\S]*\b[A-Za-z_$][\w$]*(?:\.value|\.)/.test(snippet)) return
  diagnostics.push(createDiagnostic(
    'vue-watch-effect-await-read',
    'watchEffect only tracks dependencies read before the first await.',
    file,
    node,
    'Read dependencies before awaiting or use watch() with an explicit source.'
  ))
}

/** vite-doctor: vue/watch/no-onwatchercleanup-after-await */
function diagnoseOnWatcherCleanupAfterAwait(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string
): void {
  if (!isVueCall(node, 'onWatcherCleanup')) return
  if (!source || !node.range) return
  if (!isAfterAwaitInVueWatcher(node)) return
  diagnostics.push(createDiagnostic(
    'vue-onwatcher-cleanup-after-await',
    'onWatcherCleanup() must be called synchronously before the first await in the watcher callback.',
    file,
    node,
    'Move onWatcherCleanup() before the first await in the watcher callback.'
  ))
}

/**
 * Practical subset of vite-doctor vue/ssr/no-random-or-local-time-render.
 * Only fires when the file has SSR signals.
 */
function diagnoseRandomOrLocalTimeRender(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string,
  ssrSignal: boolean
): void {
  if (!ssrSignal) return
  if (!source || !node.range) return
  if (isInsideClientOnlyGuard(source, node)) return

  const isMathRandom = node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.property?.name === 'random'
    && isUnshadowedGlobalIdentifier(node.callee.object, 'Math')
  const isDateNow = node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.property?.name === 'now'
    && isUnshadowedGlobalIdentifier(node.callee.object, 'Date')
  const isNewDate = node.type === 'NewExpression'
    && isUnshadowedGlobalIdentifier(node.callee, 'Date')
  if (!isMathRandom && !isDateNow && !isNewDate) return

  diagnostics.push(createDiagnostic(
    'vue-ssr-no-random-or-local-time-render',
    'Random or local-time values rendered during SSR can differ during hydration.',
    file,
    node,
    'Create stable server state, defer to mounted client code, or isolate with data-allow-mismatch.'
  ))
}

/** vite-doctor: vue/lifecycle/no-mutation-in-onupdated */
function diagnoseMutationInOnUpdated(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string
): void {
  if (!isVueCall(node, 'onUpdated')) return
  if (!source || !node.range) return
  const snippet = source.slice(node.range[0], node.range[1])
  if (!/(\.value\s*=|\+\+|--|\.push\s*\(|\.splice\s*\(|=)/.test(snippet)) return
  diagnostics.push(createDiagnostic(
    'vue-lifecycle-no-mutation-in-onupdated',
    'Mutating reactive state in onUpdated can create update loops.',
    file,
    node,
    'Move the reactive mutation to the event or state transition that owns it, or keep update bookkeeping in a non-reactive local.'
  ))
}

/** vite-doctor: vue/template/prefer-use-template-ref */
function diagnosePreferUseTemplateRef(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  templateRefs: Set<string>
): void {
  if (node.type !== 'VariableDeclarator' || !node.id?.name) return
  if (!templateRefs.has(node.id.name)) return
  if (!isVueCall(node.init, 'ref')) return
  diagnostics.push(createDiagnostic(
    'vue-prefer-use-template-ref',
    "Vue 3.5 supports useTemplateRef() for template refs, which keeps the ref name tied to the template.",
    file,
    node,
    `Use useTemplateRef('${node.id.name}').`
  ))
}

/**
 * Practical SSR-friendly subset of vite-doctor vue/ssr/no-browser-api-in-setup.
 * Only runs when the file shows SSR signals (vite-doctor also requires project.ssr).
 */
function diagnoseBrowserApiInSetup(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string,
  ssrSignal: boolean
): void {
  if (!ssrSignal) return
  const browserGlobal = browserGlobalName(node)
  if (!browserGlobal) return
  if (!source || !node.range) return
  if (file.includes('.client.')) return
  const start = node.range[0]
  const before = source.slice(Math.max(0, start - 12), start)
  if (/\btypeof\s+$/.test(before)) return
  if (/\bimport\b/.test(before)) return
  if (isInsideClientOnlyGuard(source, node)) return
  // Avoid double-reporting the same global many times per file.
  if (diagnostics.some((item) => item.code === 'vue-ssr-no-browser-api-in-setup' && item.file === file && item.message.startsWith(`${browserGlobal} `))) {
    return
  }
  diagnostics.push(createDiagnostic(
    'vue-ssr-no-browser-api-in-setup',
    `${browserGlobal} is a browser-only API. Access it inside onMounted(), a client-only plugin, or a guarded client branch.`,
    file,
    node,
    `Move ${browserGlobal} access into onMounted(), a client-only plugin, or a guarded client branch.`
  ))
}

function browserGlobalName(node: Node): string | undefined {
  if (
    node.type === 'Identifier'
    && node.name
    && BROWSER_GLOBALS.has(node.name)
    && isUnshadowedGlobalIdentifier(node, node.name)
  ) {
    return node.name
  }
  if (
    node.type !== 'MemberExpression'
    || !isUnshadowedGlobalIdentifier(node.object, 'globalThis')
  ) {
    return undefined
  }
  const property = node.computed
    ? literalString(node.property)
    : node.property?.name
  return property && BROWSER_GLOBALS.has(property) ? property : undefined
}

function hasSsrSignal(node: Node, source: string, file: string): boolean {
  if (/(^|\/)server\//.test(file.replaceAll('\\', '/'))) return true
  if (/\b(import\.meta\.env\.SSR|process\.server)\b/.test(source)) return true
  return programContainsVueCall(node, SSR_API_NAMES)
}

const SSR_API_NAMES = new Set(['createSSRApp', 'onServerPrefetch'])

/** vite-doctor: vue/style/prefer-define-model */
function diagnosePreferDefineModel(
  file: string,
  diagnostics: Diagnostic[],
  props: Map<string, Node>,
  emits: Set<string>,
  hasDefineModel: boolean,
  source: string
): void {
  if (hasDefineModel) return
  if (!source.includes('<script setup')) return
  for (const [prop, node] of props) {
    if (!emits.has(`update:${prop}`)) continue
    diagnostics.push(createDiagnostic(
      'vue-prefer-define-model',
      `${prop} and update:${prop} can be declared with defineModel().`,
      file,
      node,
      prop === 'modelValue' ? 'Use defineModel().' : `Use defineModel('${prop}').`
    ))
  }
}

function collectDefinePropsNames(node: Node, props: Map<string, Node>): void {
  if (!isVueCall(node, 'defineProps')) return
  const arg = node.arguments?.[0]
  if (!arg) return
  if (arg.type === 'ObjectExpression') {
    for (const property of arg.properties ?? []) {
      const name = propertyName(property)
      if (name) props.set(name, property)
    }
  } else if (arg.type === 'ArrayExpression') {
    for (const element of arg.elements ?? []) {
      if (element?.type === 'Literal' && typeof (element as { value?: unknown }).value === 'string') {
        props.set(String((element as { value: string }).value), element)
      } else if (element?.type === 'Identifier' && element.name) {
        // uncommon, ignore
      }
    }
  } else if (arg.type === 'TSAsExpression' || arg.type === 'TSTypeAssertion') {
    // type-only defineProps<{...}> handled via destructuring path elsewhere
  }
}

function collectDefineEmitNames(node: Node, emits: Set<string>): void {
  if (!isVueCall(node, 'defineEmits')) return
  const arg = node.arguments?.[0]
  if (!arg) return
  if (arg.type === 'ArrayExpression') {
    for (const element of arg.elements ?? []) {
      const value = (element as { value?: unknown; type?: string })?.value
      if (typeof value === 'string') emits.add(value)
    }
  } else if (arg.type === 'ObjectExpression') {
    for (const property of arg.properties ?? []) {
      const name = propertyName(property)
      if (name) emits.add(name)
    }
  }
}

function hasDomRead(source: string): boolean {
  return (
    /\b(getBoundingClientRect|offset(?:Width|Height|Left|Top)|client(?:Width|Height|Left|Top)|scroll(?:Width|Height|Left|Top))\b/.test(source)
    || /\bwindow\.(?:innerWidth|innerHeight|outerWidth|outerHeight|getComputedStyle|matchMedia)\b/.test(source)
    || /\bdocument\.(?:querySelector|querySelectorAll|getElementById|getElementsBy|documentElement|body)\b/.test(source)
  )
}

function isInsideClientOnlyGuard(source: string, node: Node): boolean {
  if (isInsideVueCallCallback(node, CLIENT_ONLY_LIFECYCLE_NAMES)) return true
  const offset = node.range?.[0] ?? 0
  const prefix = source.slice(0, offset)
  // Explicit client guards are safe SSR boundaries.
  const openers = [
    ...prefix.matchAll(/\bif\s*\(\s*(?:import\.meta\.client|process\.client|typeof\s+window\s*!==\s*['"]undefined['"])/g)
  ].map((match) => match.index ?? -1).filter((index) => index >= 0)
  if (openers.length === 0) return false
  const last = Math.max(...openers)
  const windowText = source.slice(last, offset)
  const opens = (windowText.match(/\{/g) ?? []).length
  const closes = (windowText.match(/\}/g) ?? []).length
  if (opens > closes) return true
  if (!windowText.includes('=>')) return false
  const parenOpens = (windowText.match(/\(/g) ?? []).length
  const parenCloses = (windowText.match(/\)/g) ?? []).length
  return parenOpens > parenCloses
}

const CLIENT_ONLY_LIFECYCLE_NAMES = new Set([
  'onBeforeMount',
  'onBeforeUnmount',
  'onMounted',
  'onUnmounted'
])

const BROWSER_GLOBALS = new Set([
  'window',
  'document',
  'localStorage',
  'sessionStorage',
  'navigator'
])

/** vite-doctor: vue/reactivity/defineprops-watch-getter */
function diagnoseDefinePropsWatchGetter(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  destructured: TrackedBindings
): void {
  if (!isVueCall(node, 'watch')) return
  const first = node.arguments?.[0]
  if (first?.type !== 'Identifier' || !first.name || !destructured.has(first)) return
  diagnostics.push(createDiagnostic(
    'vue-defineprops-watch-getter',
    `watch(${first.name}, ...) passes the current prop value. Use a getter so Vue tracks the destructured prop.`,
    file,
    first,
    `Use watch(() => ${first.name}, ...).`
  ))
}

/**
 * Detects the Vue equivalent of effect-derived state: a watcher whose only
 * action assigns another ref. A computed ref expresses this dependency without
 * an extra scheduler pass or mutable synchronization state.
 */
function diagnoseWatchDerivedState(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  refBindings: TrackedBindings,
  writeCounts: Map<Node, number>,
  source: string
): void {
  if (!isVueCall(node, 'watch') || refBindings.size === 0) return
  const callback = node.arguments?.[1]
  if (!callback || (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')) {
    return
  }

  const callbackBody = Array.isArray(callback.body) ? undefined : callback.body
  let expression: Node | undefined
  if (callbackBody?.type === 'BlockStatement') {
    const statements = Array.isArray(callbackBody.body) ? callbackBody.body : []
    if (statements.length !== 1 || statements[0]?.type !== 'ExpressionStatement') return
    expression = statements[0].expression
  } else {
    expression = callbackBody
  }
  if (expression?.type !== 'AssignmentExpression' || expression.operator !== '=') return
  const target = Array.isArray(expression.left) ? undefined : expression.left
  if (
    target?.type !== 'MemberExpression'
    || target.object?.type !== 'Identifier'
    || target.property?.name !== 'value'
    || !target.object.name
    || !refBindings.has(target.object)
  ) {
    return
  }
  const targetDeclaration = refBindings.resolve(target.object)
  if (!targetDeclaration || (writeCounts.get(targetDeclaration) ?? 0) !== 1) return
  if (isTemplateWritableBinding(source, target.object.name)) return

  let readsTarget = false
  if (expression.right) {
    visitScript(expression.right, (child) => {
      if (child.type === 'Identifier' && child.name === target.object?.name) {
        readsTarget = true
      }
    })
  }
  if (readsTarget) return

  diagnostics.push(createDiagnostic(
    'vue-watch-derived-state',
    `watch() only assigns derived state to "${target.object.name}".`,
    file,
    node,
    `Replace ${target.object.name} with computed(() => ...), so Vue derives the value without synchronizing a second ref.`
  ))
}

function isTemplateWritableBinding(source: string, name: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const binding = `(?:[^"']*[^\\w$])?${escapedName}(?:[^\\w$][^"']*)?`
  return (
    new RegExp(`\\bv-model(?::[^\\s=]+)?\\s*=\\s*["']${binding}["']`).test(source)
    || new RegExp(`(?:\\bv-bind:|:)[^\\s=]+\\.sync\\s*=\\s*["']${binding}["']`).test(source)
  )
}

const mutatingRefMethods: Record<string, true> = {
  add: true,
  clear: true,
  copyWithin: true,
  delete: true,
  fill: true,
  pop: true,
  push: true,
  reverse: true,
  set: true,
  shift: true,
  sort: true,
  splice: true,
  unshift: true
}

function diagnoseWatchReactiveProperty(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  reactiveNames: TrackedBindings,
  propBindings: TrackedBindings,
  refBindings: TrackedBindings
): void {
  if (!isVueCall(node, 'watch')) return
  const watchSource = node.arguments?.[0]
  if (!watchSource) return
  const candidates = watchSource.type === 'ArrayExpression'
    ? watchSource.elements ?? []
    : [watchSource]
  const invalid = candidates.flatMap((candidate) => {
    if (
      candidate?.type !== 'MemberExpression'
      || candidate.object?.type !== 'Identifier'
      || !candidate.object.name
    ) {
      return []
    }
    const objectName = candidate.object.name
    const property = candidate.property?.name ?? 'property'
    const watchesRefValue = property === 'value' && refBindings.has(candidate.object)
    const watchesReactive = reactiveNames.has(candidate.object)
      || propBindings.has(candidate.object)
    if (!watchesReactive && !watchesRefValue) return []
    return [{
      displayed: `${objectName}.${property}`,
      replacement: watchesRefValue
        ? objectName
        : `() => ${objectName}.${property}`
    }]
  })
  if (invalid.length === 0) return

  const displayed = invalid.map((item) => item.displayed).join(', ')
  const replacement = watchSource.type === 'ArrayExpression'
    ? `[${invalid.map((item) => item.replacement).join(', ')}]`
    : invalid[0]!.replacement
  const message = watchSource.type === 'ArrayExpression'
    ? `watch() receives current property values instead of reactive sources: ${displayed}.`
    : `watch(${displayed}, ...) receives the current property value instead of a reactive source.`
  diagnostics.push(createDiagnostic(
    'vue-watch-reactive-property',
    message,
    file,
    watchSource,
    `Use watch(${replacement}, ...).`
  ))
}

function diagnoseWatchSelfMutation(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  refBindings: TrackedBindings,
  source: string,
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!isVueCall(node, 'watch') || isOnceWatcher(node, source, vueVersion)) return
  const watchSource = node.arguments?.[0]
  if (
    watchSource?.type !== 'Identifier'
    || !watchSource.name
    || !refBindings.has(watchSource)
  ) {
    return
  }
  const expression = getSingleWatchCallbackExpression(node)
  const write = expression ? directRefWriteReference(expression) : undefined
  if (!write || !isSameLexicalBinding(write, watchSource)) return
  diagnostics.push(createDiagnostic(
    'vue-watch-self-mutation',
    `watch(${watchSource.name}, ...) unconditionally mutates its own source.`,
    file,
    node,
    'Move the mutation to the event that owns the state change, derive the value, or add an explicit converging guard.'
  ))
}

function diagnoseWatchAsyncStaleWrite(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  refBindings: TrackedBindings,
  writeCounts: Map<Node, number>,
  source: string,
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!isVueCall(node, 'watch') || isOnceWatcher(node, source, vueVersion)) return
  const callback = getWatchCallback(node)
  if (!callback?.async || !callback.range) return
  if (hasWatcherInvalidation(callback, 2)) return

  let firstAwait = Number.POSITIVE_INFINITY
  const writesAfterAwait = new Set<string>()
  visitScript(callback, (child) => {
    if (
      child.type === 'AwaitExpression'
      && child.range
      && isPotentiallyStaleAwait(child)
    ) {
      firstAwait = Math.min(firstAwait, child.range[0])
      return
    }
    if (child.range && child.range[0] > firstAwait) {
      const reference = directRefWriteReference(child)
      const binding = reference?.name
      if (
        binding
        && refBindings.has(reference)
        && !isMonotonicTrueWrite(child, reference, refBindings, writeCounts)
      ) {
        writesAfterAwait.add(binding)
      }
    }
  })
  if (writesAfterAwait.size === 0) return

  const targets = [...writesAfterAwait].sort().join(', ')
  diagnostics.push(createDiagnostic(
    'vue-watch-async-stale-write',
    `Async watch() writes ${targets} after await without invalidating stale work.`,
    file,
    node,
    'Use the watcher onCleanup callback or onWatcherCleanup() to abort/ignore the previous async operation.'
  ))
}

function diagnoseShallowRefNestedMutation(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  shallowNames: TrackedBindings,
  triggeredShallowRefs: TrackedBindings
): void {
  if (shallowNames.size === 0) return
  const assignmentTarget = node.type === 'AssignmentExpression'
    ? (Array.isArray(node.left) ? undefined : node.left)
    : node.type === 'UpdateExpression'
      ? node.argument
      : undefined
  let bindingReference = assignmentTarget
    ? nestedShallowRefBinding(assignmentTarget, shallowNames)
    : undefined
  if (
    !bindingReference
    && node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.property?.name
    && mutatingRefMethods[node.callee.property.name]
  ) {
    bindingReference = directRefValueReference(node.callee.object)
    if (!shallowNames.has(bindingReference)) bindingReference = undefined
  }
  if (!bindingReference || triggeredShallowRefs.has(bindingReference)) return
  const binding = bindingReference.name
  if (!binding) return
  if (diagnostics.some((diagnostic) => (
    diagnostic.code === 'vue-shallow-ref-nested-mutation'
    && diagnostic.file === file
    && diagnostic.message.includes(`"${binding}"`)
  ))) {
    return
  }
  diagnostics.push(createDiagnostic(
    'vue-shallow-ref-nested-mutation',
    `Nested mutation of shallowRef "${binding}" does not trigger reactive updates.`,
    file,
    node,
    `Replace ${binding}.value, use ref(), or call triggerRef(${binding}) after intentional deep mutation.`
  ))
}
function diagnoseReactiveReassignment(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  reactiveNames: TrackedBindings
): void {
  if (node.type !== 'AssignmentExpression') return
  const target = Array.isArray(node.left) ? undefined : node.left
  if (
    target?.type !== 'Identifier'
    || !target.name
    || !reactiveNames.has(target)
    || isSelfPreservingReactiveAssignment(node.right, target.name)
  ) {
    return
  }
  diagnostics.push(createDiagnostic(
    'vue-reactive-reassignment',
    `Reassigning reactive binding "${target.name}" disconnects consumers holding the original proxy.`,
    file,
    node,
    `Mutate ${target.name}'s properties or store replaceable state in ref().`
  ))
}

function diagnoseReadonlyMutation(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  readonlyNames: TrackedBindings,
  shallowReadonlyNames: TrackedBindings
): void {
  if (readonlyNames.size === 0) return
  const target = mutationTarget(node)
  const methodMutation = isMutatingMethodCall(node)
  let root = target ? memberRoot(target, readonlyNames) : undefined
  let directCollectionMutation = false
  if (!root && methodMutation) {
    const object = node.callee?.object
    if (object?.type === 'Identifier' && object.name && readonlyNames.has(object)) {
      root = { name: object.name, depth: 1, reference: object }
      directCollectionMutation = true
    } else if (object) {
      root = memberRoot(object, readonlyNames)
    }
  }
  if (!root) return
  if (shallowReadonlyNames.has(root.reference)) {
    const nestedMethodMutation = methodMutation
      && !directCollectionMutation
      && root.depth >= 1
    const nestedPropertyMutation = !methodMutation && root.depth > 1
    if (nestedMethodMutation || nestedPropertyMutation) return
  }
  const rootName = root.name
  if (diagnostics.some((diagnostic) => (
    diagnostic.code === 'vue-readonly-mutation'
    && diagnostic.file === file
    && diagnostic.message.includes(`"${rootName}"`)
  ))) {
    return
  }
  diagnostics.push(createDiagnostic(
    'vue-readonly-mutation',
    `Mutation through readonly binding "${rootName}" is ignored by Vue.`,
    file,
    node,
    'Mutate the original state through its owner or expose an explicit update action.'
  ))
}

function diagnoseShallowReactiveNestedMutation(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  shallowReactiveNames: TrackedBindings
): void {
  if (shallowReactiveNames.size === 0) return
  const target = mutationTarget(node)
  let root = target ? memberRoot(target, shallowReactiveNames) : undefined
  let nested = Boolean(root && root.depth > 1)
  if (!nested && isMutatingMethodCall(node) && node.callee?.object) {
    root = memberRoot(node.callee.object, shallowReactiveNames)
    nested = Boolean(root)
  }
  if (!root || !nested) return
  if (diagnostics.some((diagnostic) => (
    diagnostic.code === 'vue-shallow-reactive-nested-mutation'
    && diagnostic.file === file
    && diagnostic.message.includes(`"${root!.name}"`)
  ))) {
    return
  }
  diagnostics.push(createDiagnostic(
    'vue-shallow-reactive-nested-mutation',
    `Nested mutation of shallowReactive "${root.name}" does not trigger reactive updates.`,
    file,
    node,
    `Replace a root property of ${root.name} or use reactive() for deep state.`
  ))
}

function diagnoseDetachedEffectScopes(
  file: string,
  diagnostics: Diagnostic[],
  analysis: ReactiveBindingAnalysis
): void {
  for (const declaration of analysis.detachedEffectScopes.values()) {
    if (
      !analysis.runEffectScopes.has(declaration)
      || analysis.stoppedEffectScopes.has(declaration)
      || analysis.escapedEffectScopes.has(declaration)
    ) {
      continue
    }
    const node = analysis.detachedEffectScopeNodes.get(declaration)
    if (!node) continue
    const name = declaration.name ?? 'scope'
    diagnostics.push(createDiagnostic(
      'vue-detached-effect-scope-require-stop',
      `Detached effectScope "${name}" is run but never stopped or returned to an owner.`,
      file,
      node,
      `Call ${name}.stop() during cleanup or return the scope to an owner that will stop it.`
    ))
  }
}

function diagnoseCustomRefContract(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  _source: string
): void {
  if (!isVueCall(node, 'customRef')) return
  const factory = node.arguments?.[0]
  if (
    !factory
    || (factory.type !== 'ArrowFunctionExpression' && factory.type !== 'FunctionExpression')
  ) {
    return
  }
  const track = factory.params?.[0]?.name
  const trigger = factory.params?.[1]?.name
  const contract = returnedObjectExpression(factory)
  const getter = contract ? propertyValue(findObjectProperty(contract, 'get')) : undefined
  const setter = contract ? propertyValue(findObjectProperty(contract, 'set')) : undefined
  const missing = [
    ...(!track || !getter || !containsNamedCall(getter, track) ? ['track() in get()'] : []),
    ...(!trigger || !setter || !containsNamedCall(setter, trigger) ? ['trigger() in set()'] : [])
  ]
  if (missing.length > 0) {
    diagnostics.push(createDiagnostic(
      'vue-custom-ref-incomplete-contract',
      `customRef is missing ${missing.join(' and ')}.`,
      file,
      node,
      'Track reads in get() and trigger dependents when set() commits a new value.'
    ))
  }
  if (trigger && getter && containsNamedCall(getter, trigger)) {
    diagnostics.push(createDiagnostic(
      'vue-custom-ref-trigger-in-get',
      'customRef get() calls trigger(), causing dependents to update during a read.',
      file,
      getter,
      'Call track() in get() and reserve trigger() for committed setter changes.'
    ))
  }
}

function returnedObjectExpression(factory: Node): Node | undefined {
  if (!Array.isArray(factory.body) && factory.body?.type === 'ObjectExpression') {
    return factory.body
  }
  if (Array.isArray(factory.body) || factory.body?.type !== 'BlockStatement') return undefined
  const statements = Array.isArray(factory.body.body) ? factory.body.body : []
  const returned = statements.find((statement) => statement.type === 'ReturnStatement')
  return returned?.argument?.type === 'ObjectExpression' ? returned.argument : undefined
}

function containsNamedCall(root: Node, name: string): boolean {
  let found = false
  visitScript(root, (node) => {
    if (directCallName(node) === name) found = true
  })
  return found
}

function diagnoseToRefsPlainObject(
  node: Node,
  file: string,
  diagnostics: Diagnostic[]
): void {
  if (!isVueCall(node, 'toRefs')) return
  const target = node.arguments?.[0]
  if (target?.type !== 'ObjectExpression') return
  diagnostics.push(createDiagnostic(
    'vue-to-refs-plain-object',
    'toRefs() received a plain object literal instead of a reactive proxy.',
    file,
    node,
    'Wrap the object with reactive() before toRefs(), or create individual refs.'
  ))
}

function mutationTarget(node: Node): Node | undefined {
  if (node.type === 'AssignmentExpression') {
    return Array.isArray(node.left) ? undefined : node.left
  }
  if (node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) {
    return node.argument
  }
  return undefined
}

function memberRoot(
  node: Node,
  names: TrackedBindings
): { name: string; depth: number; reference: Node } | undefined {
  let current: Node | undefined = node
  let depth = 0
  while (current?.type === 'MemberExpression') {
    depth += 1
    if (current.object?.type === 'Identifier' && current.object.name && names.has(current.object)) {
      return { name: current.object.name, depth, reference: current.object }
    }
    current = current.object
  }
  return undefined
}

function isMutatingMethodCall(node: Node): boolean {
  return Boolean(
    node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.property?.name
    && mutatingRefMethods[node.callee.property.name]
  )
}

function isSelfPreservingReactiveAssignment(
  value: Node | undefined,
  binding: string
): boolean {
  return Boolean(
    value?.type === 'CallExpression'
    && value.callee?.type === 'MemberExpression'
    && value.callee.object?.type === 'Identifier'
    && value.callee.object.name === 'Object'
    && value.callee.property?.name === 'assign'
    && value.arguments?.[0]?.type === 'Identifier'
    && value.arguments[0].name === binding
  )
}

function hasNamedCall(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\s*\\(`).test(source)
}

function isBooleanLiteral(node: Node | undefined, expected: boolean): boolean {
  const literal = node as { type?: string; value?: unknown } | undefined
  return literal?.type === 'Literal' && literal.value === expected
}


function diagnoseVersionedWatchOptions(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  _source: string,
  vueVersion: ResolvedVueVersion | undefined
): void {
  const watchCall = isVueCall(node, 'watch')
  const watchEffectCall = isVueCall(node, 'watchEffect')
  if (!watchCall && !watchEffectCall) return
  const options = node.arguments?.[watchCall ? 2 : 1]
  if (options?.type !== 'ObjectExpression') return
  if (watchEffectCall) {
    const invalidOptions = ['deep', 'immediate', 'once']
      .filter((name) => findObjectProperty(options, name))
    if (invalidOptions.length > 0) {
      diagnostics.push(createDiagnostic(
        'vue-watch-effect-options-invalid',
        `watchEffect() ignores ${invalidOptions.join(', ')} options.`,
        file,
        options,
        'Use watch() when deep, immediate, or once behavior is required.'
      ))
    }
    return
  }
  if (!isKnownVueMajor(vueVersion)) return
  const once = findObjectProperty(options, 'once')
  if (
    once
    && isBooleanLiteral(propertyValue(once), true)
    && !supportsVueFeature(vueVersion, 3, 4)
  ) {
    diagnostics.push(createDiagnostic(
      'vue-watch-once-unsupported',
      'watch() once option requires Vue 3.4 or newer and is ignored by this runtime.',
      file,
      once,
      'Remove once or stop the watcher explicitly after its first callback.'
    ))
  }
  const deep = findObjectProperty(options, 'deep')
  const deepValue = propertyValue(deep)
  const rawDeepValue: unknown = deepValue?.value
  if (
    deep
    && deepValue?.type === 'Literal'
    && typeof rawDeepValue === 'number'
    && !supportsVueFeature(vueVersion, 3, 5)
  ) {
    diagnostics.push(createDiagnostic(
      'vue-watch-numeric-deep-unsupported',
      'Numeric watch() deep limits require Vue 3.5; this runtime treats the value as full deep traversal.',
      file,
      deep,
      'Use a boolean deep option or upgrade to Vue 3.5+.'
    ))
  }
}

function diagnoseVersionedVueApi(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!isKnownVueMajor(vueVersion)) return
  const name = vueCallName(node)
  const minimum = name ? MINIMUM_VUE_VERSION_BY_API[name] : undefined
  if (!name || !minimum || supportsVueFeature(vueVersion, minimum.major, minimum.minor)) return
  diagnostics.push(createDiagnostic(
    'vue-api-version-unsupported',
    `${name}() requires Vue ${minimum.major}.${minimum.minor} or newer.`,
    file,
    node,
    `Upgrade Vue to ${minimum.major}.${minimum.minor}+ or use an API available in the target runtime.`
  ))
}

function diagnoseVue2ReactiveTarget(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!isVue27Runtime(vueVersion) || (!isVueCall(node, 'reactive') && !isVueCall(node, 'shallowReactive'))) return
  const target = node.arguments?.[0]
  const kind = unsupportedVue2ReactiveTarget(target)
  if (!kind) return
  diagnostics.push(createDiagnostic(
    'vue2-reactive-root-unsupported',
    `Vue 2.7 cannot make root ${kind} values reactive with ${node.callee?.property?.name ?? node.callee?.name}().`,
    file,
    node,
    kind === 'Array'
      ? 'Use ref([]) or shallowRef([]) so the array reference can be tracked.'
      : 'Use a Vue 2 compatible object/ref representation instead.'
  ))
}

function diagnoseVue2ReadonlyTarget(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!isVue27Runtime(vueVersion) || (!isVueCall(node, 'readonly') && !isVueCall(node, 'shallowReadonly'))) return
  const target = node.arguments?.[0]
  const kind = unsupportedVue2ReadonlyTarget(target)
  if (!kind) return
  diagnostics.push(createDiagnostic(
    'vue2-readonly-target-unsupported',
    `Vue 2.7 cannot create a readonly proxy for ${kind}.`,
    file,
    node,
    'Use an extensible plain object, or enforce immutability through the owning API.'
  ))
}

function diagnoseComputedReadonlyWrite(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  computedReadonlyNames: TrackedBindings,
  templateRefBindings: TemplateRefBinding[]
): void {
  const target = mutationTarget(node)
  const reference = target
    ? directRefValueReference(target)
    : undefined
  const binding = reference?.name
  if (!reference || !binding) return
  if (computedReadonlyNames.has(reference)) {
    diagnostics.push(createDiagnostic(
      'vue-computed-readonly-write',
      `Write to readonly computed ref "${binding}" is ignored by Vue.`,
      file,
      node,
      'Use computed({ get, set }) or mutate the source state instead.'
    ))
  }
  if (templateRefBindings.some((item) => isSameLexicalBinding(item.declaration, reference))) {
    diagnostics.push(createDiagnostic(
      'vue-use-template-ref-mutation',
      `useTemplateRef binding "${binding}" is readonly.`,
      file,
      node,
      'Let Vue manage the template ref value; do not assign .value directly.'
    ))
  }
}

function diagnoseEffectScopeState(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  effectScopeNames: TrackedBindings,
  inactiveScopes: Set<Node>,
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (
    node.type !== 'CallExpression'
    || node.callee?.type !== 'MemberExpression'
    || node.callee.object?.type !== 'Identifier'
    || !node.callee.object.name
    || !effectScopeNames.has(node.callee.object)
  ) {
    return
  }
  const scope = node.callee.object.name
  const declaration = effectScopeNames.resolve(node.callee.object)
  if (!declaration) return
  const method = node.callee.property?.name
  if (method === 'stop') {
    inactiveScopes.add(declaration)
    return
  }
  if (method === 'run' && inactiveScopes.has(declaration)) {
    diagnostics.push(createDiagnostic(
      'vue-effect-scope-inactive-run',
      `effectScope "${scope}" is run after stop() and will return undefined.`,
      file,
      node,
      'Create a new scope instead of reusing a stopped scope.'
    ))
  }
  if (
    (method === 'pause' || method === 'resume')
    && isKnownVueMajor(vueVersion)
    && !supportsVueFeature(vueVersion, 3, 5)
  ) {
    diagnostics.push(createDiagnostic(
      'vue-effect-scope-pause-resume-unsupported',
      `effectScope.${method}() requires Vue 3.5 or newer.`,
      file,
      node,
      'Upgrade to Vue 3.5+ or avoid pausing the scope.'
    ))
  }
}

function diagnoseVersionedHandleMethods(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  watchHandleNames: TrackedBindings,
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (
    !isKnownVueMajor(vueVersion)
    || supportsVueFeature(vueVersion, 3, 5)
    || node.type !== 'CallExpression'
    || node.callee?.type !== 'MemberExpression'
    || node.callee.object?.type !== 'Identifier'
    || !node.callee.object.name
    || !watchHandleNames.has(node.callee.object)
  ) {
    return
  }
  const method = node.callee.property?.name
  if (method !== 'pause' && method !== 'resume') return
  diagnostics.push(createDiagnostic(
    'vue-watch-handle-pause-resume-unsupported',
    `Watcher handle ${method}() requires Vue 3.5 or newer.`,
    file,
    node,
    'Upgrade to Vue 3.5+ or stop and recreate the watcher.'
  ))
}

function diagnoseAsyncComponentUsage(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!isVueCall(node, 'defineAsyncComponent')) return
  const source = node.arguments?.[0]
  if (!source) return
  let invalidLoader = source.type === 'ImportExpression'
  let loader: Node | undefined
  if (source.type === 'ObjectExpression') {
    const loaderProperty = findObjectProperty(source, 'loader')
    loader = propertyValue(loaderProperty)
    if (!loaderProperty) invalidLoader = true
    const suspensible = findObjectProperty(source, 'suspensible')
    if (
      isVue27Runtime(vueVersion)
      && suspensible
      && isBooleanLiteral(propertyValue(suspensible), true)
    ) {
      diagnostics.push(createDiagnostic(
        'vue2-async-component-suspensible',
        'Vue 2.7 ignores defineAsyncComponent({ suspensible: true }).',
        file,
        suspensible,
        'Remove suspensible or handle loading through Vue 2 async component options.'
      ))
    }
  } else {
    loader = source
    invalidLoader ||= source.type !== 'ArrowFunctionExpression' && source.type !== 'FunctionExpression'
  }
  if (loader && hasBlockBodyWithoutReturn(loader)) invalidLoader = true
  if (!invalidLoader) return
  diagnostics.push(createDiagnostic(
    'vue-async-component-invalid-loader',
    'defineAsyncComponent() requires a loader function that returns a Promise.',
    file,
    node,
    `Use defineAsyncComponent(() => import('./Component.vue')).`
  ))
}

function diagnoseAppApiUsage(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  appNames: TrackedBindings,
  state: AppApiState,
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (vueVersion?.major !== 3) return
  if (isVueCall(node, 'createApp') || isVueCall(node, 'createSSRApp')) {
    const rootProps = node.arguments?.[1]
    if (isNonNullPrimitiveLiteral(rootProps)) {
      diagnostics.push(createContextualDiagnostic(
        'vue-app-api-misuse',
        'error',
        'createApp() root props must be an object.',
        file,
        node,
        'Pass an object or omit the root props argument.'
      ))
    }
  }
  const target = mutationTarget(node)
  if (
    target?.type === 'MemberExpression'
    && target.object?.type === 'Identifier'
    && target.object.name
    && appNames.has(target.object)
    && target.property?.name === 'config'
  ) {
    diagnostics.push(createContextualDiagnostic(
      'vue-app-api-misuse',
      'error',
      'app.config cannot be replaced as a whole.',
      file,
      node,
      'Modify individual app.config properties instead.'
    ))
  }
  if (
    node.type !== 'CallExpression'
    || node.callee?.type !== 'MemberExpression'
    || node.callee.object?.type !== 'Identifier'
    || !node.callee.object.name
    || !appNames.has(node.callee.object)
  ) {
    return
  }
  const app = node.callee.object.name
  const method = node.callee.property?.name
  const minimumMinor = method === 'runWithContext'
    ? 3
    : method === 'onUnmount'
      ? 5
      : undefined
  if (minimumMinor !== undefined && !supportsVueFeature(vueVersion, 3, minimumMinor)) {
    diagnostics.push(createDiagnostic(
      'vue-app-api-version-unsupported',
      `app.${method}() requires Vue 3.${minimumMinor} or newer.`,
      file,
      node,
      `Upgrade to Vue 3.${minimumMinor}+ or avoid this app method.`
    ))
  }
  if (method === 'mount') {
    if (state.mounted.has(app)) {
      diagnostics.push(createContextualDiagnostic(
        'vue-app-api-misuse',
        'error',
        `App "${app}" is mounted more than once.`,
        file,
        node,
        'Create a fresh app instance for each mount.'
      ))
    }
    state.mounted.add(app)
  }
  if (method === 'unmount' && !state.mounted.has(app)) {
    diagnostics.push(createContextualDiagnostic(
      'vue-app-api-misuse',
      'warning',
      `App "${app}" is unmounted before it is mounted.`,
      file,
      node,
      'Call unmount() only after a successful mount().'
    ))
  }
  if (method === 'onUnmount') {
    const callback = node.arguments?.[0]
    if (!callback || (
      callback.type !== 'ArrowFunctionExpression'
      && callback.type !== 'FunctionExpression'
      && callback.type !== 'Identifier'
    )) {
      diagnostics.push(createContextualDiagnostic(
        'vue-app-api-misuse',
        'error',
        'app.onUnmount() expects a function.',
        file,
        node,
        'Pass a cleanup function.'
      ))
    }
  }
  if (method === 'use') {
    const plugin = stableArgumentKey(node.arguments?.[0])
    if (plugin) {
      const key = `${app}:use:${plugin}`
      if (state.installedPlugins.has(key)) {
        diagnostics.push(createContextualDiagnostic(
          'vue-app-api-misuse',
          'warning',
          `Plugin "${plugin}" is applied to app "${app}" more than once.`,
          file,
          node,
          'Remove the duplicate app.use() call.'
        ))
      }
      state.installedPlugins.add(key)
    }
  }
  if (method === 'component' || method === 'directive' || method === 'provide') {
    const name = stableArgumentKey(node.arguments?.[0])
    if (name) {
      const key = `${app}:${method}:${name}`
      if (state.registrations.has(key)) {
        diagnostics.push(createContextualDiagnostic(
          'vue-app-api-misuse',
          'warning',
          `app.${method}() overwrites duplicate key "${name}".`,
          file,
          node,
          'Keep one registration per app and key.'
        ))
      }
      state.registrations.add(key)
    }
  }
}

function diagnoseProvideAfterSetup(
  node: Node,
  file: string,
  diagnostics: Diagnostic[]
): void {
  const lifecycle = vueCallName(node)
  if (!lifecycle || !POST_SETUP_LIFECYCLE_NAMES.has(lifecycle)) return
  const callback = node.arguments?.[0]
  if (!callback) return
  visitScript(callback, (child) => {
    if (vueCallName(child) !== 'provide') return
    diagnostics.push(createDiagnostic(
      'vue-provide-after-setup',
      'provide() is called after setup has finished and cannot establish component injection.',
      file,
      child,
      'Call provide() synchronously during setup().'
    ))
  })
}

function diagnoseVue2TriggerRef(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  analysis: ReactiveBindingAnalysis,
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!isVue27Runtime(vueVersion) || !isVueCall(node, 'triggerRef')) return
  const target = node.arguments?.[0]
  const definitelyInvalid = (
    isPrimitiveLiteral(target)
    || target?.type === 'ObjectExpression'
    || target?.type === 'ArrayExpression'
    || (
      target?.type === 'Identifier'
      && target.name
      && analysis.reactiveNames.has(target)
      && !analysis.names.has(target)
    )
  )
  if (!definitelyInvalid) return
  diagnostics.push(createDiagnostic(
    'vue2-trigger-ref-invalid-target',
    'Vue 2.7 triggerRef() received a value that is not a triggerable ref.',
    file,
    node,
    'Pass a ref or shallowRef binding.'
  ))
}

function diagnoseTemplateRefContracts(
  file: string,
  diagnostics: Diagnostic[],
  bindings: TemplateRefBinding[],
  templateRefs: Set<string>,
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!supportsVueFeature(vueVersion, 3, 5)) return
  const seen = new Map<string, Node>()
  for (const { key, node } of bindings) {
    if (!key) continue
    if (seen.has(key)) {
      diagnostics.push(createDiagnostic(
        'vue-use-template-ref-duplicate',
        `useTemplateRef("${key}") is declared more than once.`,
        file,
        node,
        'Use one binding per template ref key.'
      ))
    } else {
      seen.set(key, node)
    }
    if (!templateRefs.has(key)) {
      diagnostics.push(createDiagnostic(
        'vue-use-template-ref-missing',
        `useTemplateRef("${key}") has no matching ref="${key}" in the template.`,
        file,
        node,
        'Use the exact template ref key or add the missing template ref.'
      ))
    }
  }
}

function diagnoseVue2AsyncSetup(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!isVue27Runtime(vueVersion) || !isAsyncSetupProperty(node)) return
  diagnostics.push(createDiagnostic(
    'vue2-async-setup-unsupported',
    'Vue 2.7 does not await Promise results returned by async setup().',
    file,
    node,
    'Make setup() synchronous and move async work into lifecycle hooks or explicit state actions.'
  ))
}

function unsupportedVue2ReactiveTarget(node: Node | undefined): string | undefined {
  if (node?.type === 'ArrayExpression') return 'Array'
  const constructor = newExpressionName(node)
  if (constructor && VUE_2_UNSUPPORTED_REACTIVE_CONSTRUCTORS.has(constructor)) {
    return constructor
  }
  return isPrimitiveLiteral(node) ? 'primitive' : undefined
}

function unsupportedVue2ReadonlyTarget(node: Node | undefined): string | undefined {
  if (node?.type === 'ArrayExpression') return 'Array'
  const constructor = newExpressionName(node)
  if (constructor && VUE_2_UNSUPPORTED_REACTIVE_CONSTRUCTORS.has(constructor)) {
    return constructor
  }
  if (
    node?.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.object?.type === 'Identifier'
    && node.callee.object.name === 'Object'
    && node.callee.property?.name === 'freeze'
  ) {
    return 'a non-extensible object'
  }
  return isPrimitiveLiteral(node) ? 'primitive' : undefined
}

function isKnownVueMajor(
  version: ResolvedVueVersion | undefined
): version is ResolvedVueVersion {
  return version?.major === 3 || isVue27Runtime(version)
}

function isVue27Runtime(version: ResolvedVueVersion | undefined): version is ResolvedVueVersion {
  return version?.major === 2 && version.minor >= 7
}

function supportsVueFeature(
  version: ResolvedVueVersion | undefined,
  major: number,
  minor: number
): boolean {
  return Boolean(version && version.major === major && version.minor >= minor)
}

function findObjectProperty(object: Node, name: string): Node | undefined {
  return object.properties?.find((property) => propertyName(property) === name)
}

function propertyValue(property: Node | undefined): Node | undefined {
  const value = property?.value
  return isAstNode(value) ? value : undefined
}

function isReadonlyComputedCall(call: Node | undefined): boolean {
  const options = call?.arguments?.[0]
  if (options?.type === 'ArrowFunctionExpression' || options?.type === 'FunctionExpression') {
    return true
  }
  return options?.type === 'ObjectExpression' && !findObjectProperty(options, 'set')
}

function literalString(node: Node | undefined): string | undefined {
  const value: unknown = node?.value
  return node?.type === 'Literal' && typeof value === 'string'
    ? value
    : undefined
}

function isPrimitiveLiteral(node: Node | undefined): boolean {
  const value: unknown = node?.value
  return node?.type === 'Literal'
    && (value === null || typeof value !== 'object')
}

function isNonNullPrimitiveLiteral(node: Node | undefined): boolean {
  const value: unknown = node?.value
  return node?.type === 'Literal'
    && value !== null
    && typeof value !== 'object'
}

function newExpressionName(node: Node | undefined): string | undefined {
  return node?.type === 'NewExpression' && node.callee?.type === 'Identifier'
    ? node.callee.name
    : undefined
}

function hasBlockBodyWithoutReturn(loader: Node): boolean {
  if (
    (loader.type !== 'ArrowFunctionExpression' && loader.type !== 'FunctionExpression')
    || Array.isArray(loader.body)
    || loader.body?.type !== 'BlockStatement'
  ) {
    return false
  }
  const statements = Array.isArray(loader.body.body) ? loader.body.body : []
  return !statements.some((statement) => statement.type === 'ReturnStatement')
}

function stableArgumentKey(node: Node | undefined): string | undefined {
  if (node?.type === 'Identifier') return node.name
  const value: unknown = node?.value
  return node?.type === 'Literal' && (typeof value === 'string' || typeof value === 'number')
    ? String(value)
    : undefined
}

function isAstNode(value: unknown): value is Node {
  return Boolean(value && typeof value === 'object' && 'type' in value)
}


function isAsyncSetupProperty(node: Node): boolean {
  if (node.type !== 'Property' || propertyName(node) !== 'setup') return false
  const value = propertyValue(node)
  return Boolean(
    value
    && (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression')
    && value.async
  )
}

function diagnoseVue2ObserverMutation(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (!isVue27Runtime(vueVersion) || node.type !== 'CallExpression') return
  const directHelper = isVueCall(node, 'set')
    || isVueCall(node, 'del')
    || isVueCall(node, 'delete')
  const instanceHelper = node.callee?.type === 'MemberExpression'
    && (node.callee.property?.name === '$set' || node.callee.property?.name === '$delete')
  if (!directHelper && !instanceHelper) return
  const target = node.arguments?.[0]
  const key = node.arguments?.[1]
  const targetIsArray = target?.type === 'ArrayExpression'
  const invalidArrayKey = targetIsArray && !isStaticArrayIndex(key)
  const invalidTarget = isPrimitiveLiteral(target)
  if (!invalidArrayKey && !invalidTarget) return
  diagnostics.push(createDiagnostic(
    'vue2-observer-set-delete-invalid-target',
    invalidArrayKey
      ? 'Vue 2 set/delete on an Array requires a valid numeric index.'
      : 'Vue 2 set/delete cannot target primitives, a Vue instance, or its root $data object.',
    file,
    node,
    invalidArrayKey
      ? 'Use a non-negative integer array index or splice().'
      : 'Mutate a nested reactive object owned by the component.'
  ))
}

function diagnoseSetupContextExpose(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (vueVersion?.major !== 3 || node.type !== 'Property' || propertyName(node) !== 'setup') return
  const setup = propertyValue(node)
  if (
    !setup
    || (setup.type !== 'FunctionExpression' && setup.type !== 'ArrowFunctionExpression')
  ) {
    return
  }
  const context = setup.params?.[1]
  if (context?.type !== 'ObjectPattern') return
  const exposeProperty = context.properties?.find((property) => propertyName(property) === 'expose')
  if (!exposeProperty) return
  const local = propertyValue(exposeProperty)?.name ?? 'expose'
  const body = Array.isArray(setup.body) ? undefined : setup.body
  if (!body) return
  const calls: Node[] = []
  walkOutsideFunctions(body, (child) => {
    if (directCallName(child) === local) calls.push(child)
  })
  const duplicateCall = calls[1]
  if (duplicateCall) {
    diagnostics.push(createContextualDiagnostic(
      'vue-setup-context-expose-misuse',
      'warning',
      'setup context expose() is called more than once.',
      file,
      duplicateCall,
      'Call expose() once with the complete public instance shape.'
    ))
  }
  for (const call of calls) {
    const exposed = call.arguments?.[0]
    if (!exposed || exposed.type === 'ObjectExpression' || exposed.type === 'Identifier') continue
    diagnostics.push(createContextualDiagnostic(
      'vue-setup-context-expose-misuse',
      'error',
      'setup context expose() expects a plain object.',
      file,
      call,
      'Pass one object containing the public fields and methods.'
    ))
  }
}

function diagnoseInjectionUsage(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  vueVersion: ResolvedVueVersion | undefined
): void {
  const api = vueCallName(node)
  if (vueVersion?.major !== 3 || (api !== 'provide' && api !== 'inject')) return
  const key = node.arguments?.[0]
  const keyValue: unknown = key?.value
  const invalidKey = !key || (
    key.type === 'Literal'
    && typeof keyValue !== 'string'
  )
  if (invalidKey) {
    diagnostics.push(createDiagnostic(
      'vue-injection-key-invalid',
      `${api}() requires a string or Symbol injection key.`,
      file,
      node,
      'Use a string key or a shared typed InjectionKey Symbol.'
    ))
  }
  if (api === 'inject') {
    const treatDefaultAsFactory = node.arguments?.[2]
    const value: unknown = treatDefaultAsFactory?.value
    if (
      treatDefaultAsFactory?.type === 'Literal'
      && typeof value !== 'boolean'
    ) {
      diagnostics.push(createDiagnostic(
        'vue-injection-key-invalid',
        'inject() third argument must be a boolean default-factory flag.',
        file,
        node,
        'Pass true, false, or omit the third argument.'
      ))
    }
  }
}

function diagnoseToRawEscapes(
  program: Node,
  file: string,
  diagnostics: Diagnostic[]
): void {
  const analyzeScope = (root: Node, inherited = new Map<string, Node>()): void => {
    const bindings = new Map(inherited)
    for (const parameter of root.params ?? []) {
      for (const name of collectIdentifiers(parameter)) bindings.delete(name)
    }
    const walk = (node: Node, isRoot = false): void => {
      if (!isRoot && isFunctionNode(node)) {
        analyzeScope(node, bindings)
        return
      }
      if (node.type === 'VariableDeclarator' && node.id) {
        for (const name of collectIdentifiers(node.id)) bindings.delete(name)
        if (node.id.name && isVueCall(node.init, 'toRaw')) {
          bindings.set(node.id.name, node)
        }
      }
      if (node.type === 'ReturnStatement') {
        const directEscape = isVueCall(node.argument, 'toRaw')
          ? node
          : node.argument?.type === 'Identifier' && node.argument.name
            ? bindings.get(node.argument.name)
            : undefined
        if (directEscape) {
          diagnostics.push(createDiagnostic(
            'vue-to-raw-long-lived',
            'A toRaw() result escapes through a return value and can become a long-lived non-reactive reference.',
            file,
            directEscape,
            'Use toRaw() only for immediate identity/read work; do not retain or return the raw object.'
          ))
        }
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'parent' || key === 'loc' || key === 'range') continue
        if (Array.isArray(value)) {
          for (const child of value) {
            if (isAstNode(child)) walk(child)
          }
        } else if (isAstNode(value)) {
          walk(value)
        }
      }
    }
    walk(root, true)
  }
  analyzeScope(program)
}

function isStaticArrayIndex(node: Node | undefined): boolean {
  const value: unknown = node?.value
  const index = typeof value === 'string' && value.trim() !== ''
    ? Number(value)
    : value
  return typeof index === 'number' && Number.isInteger(index) && index >= 0
}
function diagnoseDuplicateProvideKeys(
  program: Node,
  file: string,
  diagnostics: Diagnostic[]
): void {
  const walk = (node: Node, providedKeys: Set<string>, isRoot = false): void => {
    const scope = !isRoot && isFunctionNode(node) ? new Set<string>() : providedKeys
    if (vueCallName(node) === 'provide') {
      const key = stableArgumentKey(node.arguments?.[0])
      if (key) {
        if (scope.has(key)) {
          diagnostics.push(createDiagnostic(
            'vue-duplicate-provide-key',
            `provide() overwrites duplicate key "${key}" in the same setup scope.`,
            file,
            node,
            'Provide each key once or merge the provided value deliberately.'
          ))
        }
        scope.add(key)
      }
    }
    if (node.type === 'IfStatement') {
      if (node.test) walk(node.test, scope)
      if (node.consequent) walk(node.consequent, new Set(scope))
      if (node.alternate) walk(node.alternate, new Set(scope))
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) walk(child, scope)
        }
      } else if (isAstNode(value)) {
        walk(value, scope)
      }
    }
  }
  walk(program, new Set(), true)
}

function diagnoseSetupApiOutsideContext(
  program: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string,
  vueVersion: ResolvedVueVersion | undefined
): void {
  if (vueVersion?.major !== 3 || /<script\b[^>]*\bsetup\b/.test(source)) return
  walkOutsideFunctions(program, (node) => {
    const name = vueCallName(node)
    if (name && SETUP_CONTEXT_API_NAMES.has(name)) {
      diagnostics.push(createDiagnostic(
        'vue-setup-api-outside-context',
        'A setup-context API is called at module scope without an active component instance.',
        file,
        node,
        'Move the call into setup() or a composable invoked synchronously by setup().'
      ))
    }
    if (name === 'resolveComponent' || name === 'resolveDirective') {
      diagnostics.push(createDiagnostic(
        'vue-asset-resolution-outside-context',
        'resolveComponent()/resolveDirective() is called outside setup or render context.',
        file,
        node,
        'Resolve the asset inside setup() or render(), or import it directly.'
      ))
    }
  })
}

function walkOutsideFunctions(node: Node, visit: (node: Node) => void, isRoot = true): void {
  if (!isRoot && isFunctionNode(node)) return
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) walkOutsideFunctions(child, visit, false)
      }
    } else if (isAstNode(value)) {
      walkOutsideFunctions(value, visit, false)
    }
  }
}

function isFunctionNode(node: Node): boolean {
  return node.type === 'ArrowFunctionExpression'
    || node.type === 'FunctionExpression'
    || node.type === 'FunctionDeclaration'
}


function getWatchCallback(node: Node): Node | undefined {
  const callback = node.arguments?.[1]
  return callback?.type === 'ArrowFunctionExpression' || callback?.type === 'FunctionExpression'
    ? callback
    : undefined
}

function diagnoseStaticIsShallow(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  analysis: ReactiveBindingAnalysis,
  vueVersion: ResolvedVueVersion | undefined
): void {
  const test = node.test
  if (
    vueVersion?.major !== 3
    || (node.type !== 'IfStatement' && node.type !== 'ConditionalExpression')
    || !test
    || vueCallName(test) !== 'isShallow'
  ) {
    return
  }
  const target = test.arguments?.[0]
  if (target?.type !== 'Identifier' || !target.name) return
  const name = target.name
  const knownDeep = (
    analysis.names.has(target)
    || analysis.reactiveNames.has(target)
    || analysis.readonlyNames.has(target)
  ) && !analysis.shallowNames.has(target)
    && !analysis.shallowReactiveNames.has(target)
    && !analysis.shallowReadonlyNames.has(target)
  if (!knownDeep) return
  diagnostics.push(createDiagnostic(
    'vue-is-shallow-static-false',
    `isShallow(${name}) is statically false, so this branch is unreachable.`,
    file,
    test,
    'Remove the branch or pass a value that can actually be shallow.'
  ))
}

function getSingleWatchCallbackExpression(node: Node): Node | undefined {
  const callback = getWatchCallback(node)
  const callbackBody = callback && !Array.isArray(callback.body) ? callback.body : undefined
  if (callbackBody?.type !== 'BlockStatement') return callbackBody
  const statements = Array.isArray(callbackBody.body) ? callbackBody.body : []
  return statements.length === 1 && statements[0]?.type === 'ExpressionStatement'
    ? statements[0].expression
    : undefined
}

function directRefWriteReference(node: Node): Node | undefined {
  const assignmentTarget = node.type === 'AssignmentExpression'
    ? (Array.isArray(node.left) ? undefined : node.left)
    : node.type === 'UpdateExpression'
      ? node.argument
      : undefined
  if (
    assignmentTarget?.type === 'MemberExpression'
    && assignmentTarget.object?.type === 'Identifier'
    && assignmentTarget.property?.name === 'value'
  ) {
    return assignmentTarget.object
  }
  if (
    node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.property?.name
    && mutatingRefMethods[node.callee.property.name]
  ) {
    return directRefValueReference(node.callee.object)
  }
  return undefined
}

function directRefValueReference(node: Node | undefined): Node | undefined {
  return node?.type === 'MemberExpression'
    && node.object?.type === 'Identifier'
    && node.property?.name === 'value'
    ? node.object
    : undefined
}

function nestedShallowRefBinding(node: Node, shallowNames: TrackedBindings): Node | undefined {
  let current: Node | undefined = node
  let depth = 0
  while (current?.type === 'MemberExpression') {
    const reference = directRefValueReference(current)
    if (reference && shallowNames.has(reference)) return depth >= 1 ? reference : undefined
    current = current.object
    depth += 1
  }
  return undefined
}

function hasWatcherInvalidation(callback: Node, cleanupParameterIndex: number): boolean {
  const cleanupParameter = callback.params?.[cleanupParameterIndex]
  let found = false
  visitScript(callback, (node) => {
    if (found) return
    if (isVueCall(node, 'onWatcherCleanup')) {
      found = true
      return
    }
    if (
      node.type === 'CallExpression'
      && node.callee?.type === 'Identifier'
      && cleanupParameter?.type === 'Identifier'
      && isSameLexicalBinding(cleanupParameter, node.callee)
    ) {
      found = true
      return
    }
    if (
      node.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && node.callee.property?.name === 'abort'
    ) {
      found = true
    }
  })
  return found
}

function isPotentiallyStaleAwait(node: Node): boolean {
  const awaited = node.argument
  if (!awaited || isVueCall(awaited, 'nextTick')) return false
  return awaited.type === 'CallExpression' || awaited.type === 'NewExpression'
}

function isMonotonicTrueWrite(
  node: Node,
  reference: Node,
  bindings: TrackedBindings,
  writeCounts: Map<Node, number>
): boolean {
  const declaration = bindings.resolve(reference)
  if (
    node.type !== 'AssignmentExpression'
    || node.operator !== '='
    || !declaration
    || (writeCounts.get(declaration) ?? 0) !== 1
  ) {
    return false
  }
  const value = node.right as { type?: string; value?: unknown } | undefined
  return value?.type === 'Literal' && value.value === true
}

function isOnceWatcher(
  node: Node,
  source: string,
  vueVersion: ResolvedVueVersion | undefined
): boolean {
  if (vueVersion?.major !== 3 || vueVersion.minor < 4) return false
  return Boolean(
    node.range
    && /\bonce\s*:\s*true\b/.test(source.slice(node.range[0], node.range[1]))
  )
}

/** vite-doctor: vue/watch/require-side-effect-cleanup */
function diagnoseWatcherSideEffectCleanup(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string
): void {
  if (!isVueCall(node, 'watch') && !isVueCall(node, 'watchEffect')) return
  if (!source || !node.range) return
  const snippet = source.slice(node.range[0], node.range[1])
  if (!/(addEventListener|setInterval|setTimeout|new\s+(ResizeObserver|IntersectionObserver|WebSocket))/.test(snippet)) {
    return
  }
  const name = vueCallName(node)
  const callbackIndex = name === 'watch' ? 1 : 0
  const cleanupParameterIndex = name === 'watch' ? 2 : 0
  const callback = node.arguments?.[callbackIndex]
  if (
    callback
    && (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression')
    && hasWatcherSideEffectCleanup(callback, cleanupParameterIndex)
  ) return
  diagnostics.push(createDiagnostic(
    'vue-watch-require-cleanup',
    'This watcher creates a side effect without registering cleanup.',
    file,
    node,
    'Use onWatcherCleanup(), the watcher onCleanup argument, or onScopeDispose().'
  ))
}

function hasWatcherSideEffectCleanup(callback: Node, cleanupParameterIndex: number): boolean {
  if (hasWatcherInvalidation(callback, cleanupParameterIndex)) return true
  let found = false
  visitScript(callback, (node) => {
    if (found) return
    if (isVueCall(node, 'onScopeDispose')) {
      found = true
      return
    }
    if (isUnshadowedGlobalCall(node, 'clearInterval') || isUnshadowedGlobalCall(node, 'clearTimeout')) {
      found = true
      return
    }
    if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return
    if (['removeEventListener', 'disconnect', 'close'].includes(node.callee.property?.name ?? '')) {
      found = true
    }
  })
  return found
}

type LongLivedResourceKind = 'interval' | 'listener' | 'observer' | 'websocket'

type LongLivedResource = {
  node: Node
  kind: LongLivedResourceKind
  owner?: string
  listenerKey?: string
}

class ExpressionAliases {
  private readonly targets = new Map<string, string>()

  assign(alias: string, target: string): void {
    this.targets.set(alias, this.resolve(target))
  }

  reset(alias: string): void {
    this.targets.delete(alias)
  }

  resolve(value: string): string {
    let current = value
    const seen = new Set<string>()
    while (this.targets.has(current) && !seen.has(current)) {
      seen.add(current)
      current = this.targets.get(current)!
    }
    return current
  }
}

class ResourceOwners {
  private readonly versions = new Map<string, number>()

  assign(owner: string): string {
    const version = (this.versions.get(owner) ?? 0) + 1
    this.versions.set(owner, version)
    return `${owner}#${version}`
  }

  current(owner: string): string | undefined {
    const version = this.versions.get(owner)
    return version === undefined ? undefined : `${owner}#${version}`
  }
}

/** vite-doctor: vue/lifecycle/require-cleanup */
function diagnoseLifecycleCleanup(
  programs: Node[],
  source: string,
  file: string,
  diagnostics: Diagnostic[]
): void {
  const aliases = new ExpressionAliases()
  const owners = new ResourceOwners()
  const resources: LongLivedResource[] = []
  const handledResources = new Set<Node>()
  const escapedNodes = new Set<Node>()
  const escapedOwners = new Set<string>()
  const clearedIntervals = new Set<string>()
  const disposedOwners = new Set<string>()
  const teardown = collectLifecycleTeardown(programs)
  const removedListeners = new Set<string>()

  const addResource = (node: Node, owner?: string): void => {
    const kind = longLivedResourceKind(node)
    if (!kind || handledResources.has(node)) return
    handledResources.add(node)
    resources.push({
      node,
      kind,
      ...(owner ? { owner } : {}),
      ...(kind === 'listener'
        ? { listenerKey: listenerKey(node, source, aliases) }
        : {})
    })
  }

  for (const program of programs) {
    visitScript(program, (node) => {
      if (node.type === 'ReturnStatement' && node.argument) {
        if (longLivedResourceKind(node.argument)) {
          addResource(node.argument)
          escapedNodes.add(node.argument)
        }
        const returned = expressionKey(node.argument, source)
        if (returned) {
          const owner = owners.current(aliases.resolve(returned))
          if (owner) escapedOwners.add(owner)
        }
      }

      if (node.type === 'VariableDeclarator' && node.init && node.id) {
        const declared = expressionKey(node.id, source)
        if (declared) {
          if (isAliasExpression(node.init)) {
            const target = expressionKey(node.init, source)
            if (target) aliases.assign(declared, target)
          } else {
            aliases.reset(declared)
          }
          if (longLivedResourceKind(node.init)) {
            addResource(node.init, owners.assign(aliases.resolve(declared)))
          }
        }
      }

      if (
        node.type === 'AssignmentExpression'
        && node.right
        && !Array.isArray(node.left)
        && node.left
      ) {
        const assigned = expressionKey(node.left, source)
        if (assigned) {
          if (isAliasExpression(node.right)) {
            const target = expressionKey(node.right, source)
            if (target) aliases.assign(assigned, target)
          } else {
            aliases.reset(assigned)
          }
          if (longLivedResourceKind(node.right)) {
            addResource(node.right, owners.assign(aliases.resolve(assigned)))
          }
        }
      }

      if (longLivedResourceKind(node)) addResource(node)

      if (isUnshadowedGlobalCall(node, 'clearInterval')) {
        const rawOwner = expressionKey(node.arguments?.[0], source)
        if (rawOwner) {
          const owner = owners.current(aliases.resolve(rawOwner))
          if (owner) clearedIntervals.add(owner)
        }
      }

      if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return
      const method = node.callee.property?.name
      if (method === 'disconnect' || method === 'close') {
        const rawOwner = expressionKey(node.callee.object, source)
        if (rawOwner) {
          const owner = owners.current(aliases.resolve(rawOwner))
          if (owner) disposedOwners.add(owner)
        }
      }
      if (method === 'removeEventListener') {
        const key = listenerKey(node, source, aliases)
        if (key) removedListeners.add(key)
      }
    })
  }

  for (const call of teardown.intervals) {
    const rawOwner = expressionKey(call.arguments?.[0], source)
    if (!rawOwner) continue
    const owner = owners.current(aliases.resolve(rawOwner))
    if (owner) clearedIntervals.add(owner)
  }
  for (const call of teardown.disposables) {
    const rawOwner = call.callee?.type === 'MemberExpression'
      ? expressionKey(call.callee.object, source)
      : undefined
    if (!rawOwner) continue
    const owner = owners.current(aliases.resolve(rawOwner))
    if (owner) disposedOwners.add(owner)
  }
  for (const call of teardown.listeners) {
    const key = listenerKey(call, source, aliases)
    if (key) removedListeners.add(key)
  }

  for (const resource of resources) {
    const escaped = escapedNodes.has(resource.node)
      || Boolean(resource.owner && escapedOwners.has(resource.owner))
    const cleaned = resource.kind === 'interval'
      ? Boolean(resource.owner && clearedIntervals.has(resource.owner))
      : resource.kind === 'listener'
        ? Boolean(resource.listenerKey && removedListeners.has(resource.listenerKey))
        : Boolean(resource.owner && disposedOwners.has(resource.owner))
    if (escaped || cleaned) continue
    diagnostics.push(createDiagnostic(
      'vue-lifecycle-require-cleanup',
      'This component creates a long-lived browser resource without lifecycle cleanup.',
      file,
      resource.node,
      'Register cleanup with onUnmounted(), onScopeDispose(), beforeDestroy(), or beforeUnmount().'
    ))
  }
}

function collectLifecycleTeardown(programs: Node[]): {
  intervals: Node[]
  disposables: Node[]
  listeners: Node[]
} {
  const intervals: Node[] = []
  const disposables: Node[] = []
  const listeners: Node[] = []
  const collect = (root: Node | undefined): void => {
    if (!root) return
    visitScript(root, (node) => {
      if (isUnshadowedGlobalCall(node, 'clearInterval')) intervals.push(node)
      if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return
      const method = node.callee.property?.name
      if (method === 'disconnect' || method === 'close') disposables.push(node)
      if (method === 'removeEventListener') listeners.push(node)
    })
  }
  for (const program of programs) {
    visitScript(program, (node) => {
      if (
        node.type === 'Property'
        && ['beforeDestroy', 'beforeUnmount', 'destroyed', 'unmounted'].includes(propertyName(node) ?? '')
      ) {
        collect(propertyValue(node))
      }
      if (
        node.type === 'CallExpression'
        && node.callee?.type === 'MemberExpression'
        && node.callee.property?.name === '$once'
        && ['hook:beforeDestroy', 'hook:destroyed'].includes(literalString(node.arguments?.[0]) ?? '')
      ) {
        collect(node.arguments?.[1])
      }
    })
  }
  return { intervals, disposables, listeners }
}

function longLivedResourceKind(node: Node): LongLivedResourceKind | undefined {
  if (isUnshadowedGlobalCall(node, 'setInterval')) return 'interval'
  if (
    node.type === 'CallExpression'
    && node.callee?.type === 'MemberExpression'
    && node.callee.property?.name === 'addEventListener'
  ) {
    return 'listener'
  }
  if (node.type !== 'NewExpression') return undefined
  const constructor = unshadowedGlobalConstructorName(node.callee)
  if (constructor === 'WebSocket') return 'websocket'
  if (constructor === 'IntersectionObserver' || constructor === 'ResizeObserver') {
    return 'observer'
  }
  return undefined
}

function unshadowedGlobalConstructorName(callee: Node | undefined): string | undefined {
  if (callee?.type === 'Identifier' && callee.name) {
    return isUnshadowedGlobalIdentifier(callee, callee.name) ? callee.name : undefined
  }
  if (
    callee?.type !== 'MemberExpression'
    || !isUnshadowedGlobalIdentifier(callee.object, 'globalThis')
  ) {
    return undefined
  }
  return callee.computed ? literalString(callee.property) : callee.property?.name
}

function listenerKey(
  node: Node,
  source: string,
  aliases: ExpressionAliases
): string | undefined {
  if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return undefined
  const rawTarget = expressionKey(node.callee.object, source)
  const event = expressionKey(node.arguments?.[0], source)
  const rawHandler = expressionKey(node.arguments?.[1], source)
  const target = rawTarget ? aliases.resolve(rawTarget) : undefined
  const handler = rawHandler ? aliases.resolve(rawHandler) : undefined
  return target && event && handler ? `${target}|${event}|${handler}` : undefined
}

function isAliasExpression(node: Node): boolean {
  return node.type === 'Identifier'
    || node.type === 'MemberExpression'
    || node.type === 'ThisExpression'
}

function expressionKey(node: Node | undefined, source: string): string | undefined {
  if (!node) return undefined
  if (node.type === 'Identifier') return node.name
  if (!node.range) return undefined
  const text = source.slice(node.range[0], node.range[1]).trim()
  return text || undefined
}
function findRefBindings(program: Node): ReactiveBindingAnalysis {
  const names = new TrackedBindings()
  const shallowNames = new TrackedBindings()
  const reactiveNames = new TrackedBindings()
  const shallowReactiveNames = new TrackedBindings()
  const readonlyNames = new TrackedBindings()
  const shallowReadonlyNames = new TrackedBindings()
  const triggeredShallowRefs = new TrackedBindings()
  const detachedEffectScopes = new TrackedBindings()
  const detachedEffectScopeNodes = new Map<Node, Node>()
  const runEffectScopes = new Set<Node>()
  const stoppedEffectScopes = new Set<Node>()
  const escapedEffectScopes = new Set<Node>()
  const computedReadonlyNames = new TrackedBindings()
  const templateRefBindings: TemplateRefBinding[] = []
  const effectScopeNames = new TrackedBindings()
  const watchHandleNames = new TrackedBindings()
  const appNames = new TrackedBindings()
  const writeCounts = new Map<Node, number>()
  visitScript(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.name) {
      if (isVueCall(node.init, 'ref') || isVueCall(node.init, 'shallowRef')) {
        names.add(node.id)
      }
      if (isVueCall(node.init, 'shallowRef')) {
        shallowNames.add(node.id)
      }
      if (isVueCall(node.init, 'reactive') || isVueCall(node.init, 'shallowReactive')) {
        reactiveNames.add(node.id)
      }
      if (isVueCall(node.init, 'shallowReactive')) {
        shallowReactiveNames.add(node.id)
      }
      if (isVueCall(node.init, 'readonly') || isVueCall(node.init, 'shallowReadonly')) {
        readonlyNames.add(node.id)
      }
      if (isVueCall(node.init, 'shallowReadonly')) {
        shallowReadonlyNames.add(node.id)
      }
      if (isVueCall(node.init, 'computed')) {
        names.add(node.id)
        if (isReadonlyComputedCall(node.init)) {
          computedReadonlyNames.add(node.id)
        }
      }
      if (isVueCall(node.init, 'useTemplateRef')) {
        names.add(node.id)
        shallowNames.add(node.id)
        readonlyNames.add(node.id)
        templateRefBindings.push({
          declaration: node.id,
          key: literalString(node.init?.arguments?.[0]),
          node
        })
      }
      if (isVueCall(node.init, 'effectScope')) {
        effectScopeNames.add(node.id)
      }
      if (
        isVueCall(node.init, 'watch')
        || isVueCall(node.init, 'watchEffect')
        || isVueCall(node.init, 'watchPostEffect')
        || isVueCall(node.init, 'watchSyncEffect')
      ) {
        watchHandleNames.add(node.id)
      }
      if (isVueCall(node.init, 'createApp') || isVueCall(node.init, 'createSSRApp')) {
        appNames.add(node.id)
      }
      if (
        isVueCall(node.init, 'effectScope')
        && isBooleanLiteral(node.init?.arguments?.[0], true)
      ) {
        detachedEffectScopes.add(node.id)
        detachedEffectScopeNodes.set(node.id, node)
      }
      return
    }

    if (isVueCall(node, 'triggerRef')) {
      const target = node.arguments?.[0]
      if (target?.type === 'Identifier' && target.name) {
        triggeredShallowRefs.add(target)
      }
    }

    if (
      node.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && node.callee.object?.type === 'Identifier'
      && node.callee.object.name
    ) {
      const declaration = detachedEffectScopes.resolve(node.callee.object)
      if (declaration && node.callee.property?.name === 'run') runEffectScopes.add(declaration)
      if (declaration && node.callee.property?.name === 'stop') stoppedEffectScopes.add(declaration)
    }

    if (node.type === 'CallExpression') {
      for (const argument of node.arguments ?? []) {
        if (
          argument.type === 'Identifier'
          && argument.name
          && detachedEffectScopes.has(argument)
        ) {
          const declaration = detachedEffectScopes.resolve(argument)
          if (declaration) escapedEffectScopes.add(declaration)
        }
      }
    }
    if (node.type === 'ReturnStatement') {
      if (node.argument) visitScript(node.argument, (reference) => {
        if (reference.type !== 'Identifier') return
        const declaration = detachedEffectScopes.resolve(reference)
        if (declaration) escapedEffectScopes.add(declaration)
      })
    }

    const assignmentTarget = node.type === 'AssignmentExpression'
      ? (Array.isArray(node.left) ? undefined : node.left)
      : node.type === 'UpdateExpression'
        ? node.argument
        : undefined
    const assignedRef = assignmentTarget?.type === 'MemberExpression'
      && assignmentTarget.object?.type === 'Identifier'
      && assignmentTarget.property?.name === 'value'
      ? assignmentTarget.object
      : undefined
    const assignedDeclaration = names.resolve(assignedRef)
    if (assignedDeclaration) {
      writeCounts.set(assignedDeclaration, (writeCounts.get(assignedDeclaration) ?? 0) + 1)
      return
    }

    const mutableMember = node.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && node.callee.object?.type === 'MemberExpression'
      && node.callee.object.object?.type === 'Identifier'
      && node.callee.object.property?.name === 'value'
      && mutatingRefMethods[node.callee.property?.name ?? '']
      ? node.callee.object.object
      : undefined
    const mutableDeclaration = names.resolve(mutableMember)
    if (mutableDeclaration) {
      writeCounts.set(mutableDeclaration, (writeCounts.get(mutableDeclaration) ?? 0) + 1)
    }
  })
  return {
    names,
    shallowNames,
    reactiveNames,
    shallowReactiveNames,
    readonlyNames,
    shallowReadonlyNames,
    detachedEffectScopeNodes,
    triggeredShallowRefs,
    detachedEffectScopes,
    runEffectScopes,
    stoppedEffectScopes,
    escapedEffectScopes,
    computedReadonlyNames,
    templateRefBindings,
    effectScopeNames,
    watchHandleNames,
    appNames,
    writeCounts
  }
}

function findDestructuredDefineProps(program: Node): TrackedBindings {
  const bindings = new TrackedBindings()
  visitScript(program, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'ObjectPattern') return
    if (!isDefinePropsInitializer(node.init)) return
    for (const declaration of collectBindingIdentifiers(node.id)) bindings.add(declaration)
  })
  return bindings
}

function collectScriptBindings(program: Node, bindings: Set<string>): void {
  for (const statement of program.body as Node[] ?? []) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.local?.name) bindings.add(specifier.local.name)
      }
      continue
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations ?? []) {
        for (const name of collectIdentifiers(declaration.id)) bindings.add(name)
      }
      continue
    }
    if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id?.name) {
      bindings.add(statement.id.name)
    }
  }
}

function findDefinePropsBindings(program: Node): TrackedBindings {
  const bindings = new TrackedBindings()
  visitScript(program, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return
    if (isDefinePropsInitializer(node.init)) bindings.add(node.id)
  })
  return bindings
}

function isDefinePropsInitializer(node: Node | undefined): boolean {
  if (isVueCall(node, 'defineProps')) return true
  return isVueCall(node, 'withDefaults')
    && isVueCall(node?.arguments?.[0], 'defineProps')
}

function collectBindingIdentifiers(pattern: Node | undefined): Node[] {
  if (!pattern) return []
  if (pattern.type === 'Identifier') return [pattern]
  if (pattern.type === 'RestElement') return collectBindingIdentifiers(pattern.argument)
  if (pattern.type === 'AssignmentPattern') {
    return collectBindingIdentifiers(Array.isArray(pattern.left) ? undefined : pattern.left)
  }
  if (pattern.type === 'ArrayPattern') {
    return (pattern.elements ?? []).flatMap((element) => collectBindingIdentifiers(element))
  }
  if (pattern.type === 'ObjectPattern') {
    return (pattern.properties ?? []).flatMap((property) => {
      if (property.type === 'RestElement') return collectBindingIdentifiers(property.argument)
      const value = (property as unknown as { value?: Node }).value
      return collectBindingIdentifiers(value ?? property.argument)
    })
  }
  return []
}

function collectIdentifiers(value: Node | Node[] | undefined): string[] {
  const names: string[] = []
  const visit = (node: Node | undefined) => {
    if (!node) return
    if (node.type === 'Identifier' && node.name) {
      names.push(node.name)
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item))
      return
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue
      if (Array.isArray(child)) child.forEach((item) => item && typeof item === 'object' && visit(item as Node))
      else if (child && typeof child === 'object') visit(child as Node)
    }
  }
  visit(value as Node | undefined)
  return [...new Set(names)]
}

function findDeclaredOptionProps(program: Node): Set<string> {
  const names = new Set<string>()
  visitScript(program, (node) => {
    if (node.type !== 'Property' || propertyName(node) !== 'props') return
    const value = node.value as Node | null | undefined
    if (value?.type === 'ObjectExpression') {
      for (const property of value.properties ?? []) {
        const name = propertyName(property)
        if (name) names.add(name)
      }
    } else if (value?.type === 'ArrayExpression') {
      for (const element of value.elements ?? value.children ?? []) {
        if (element?.name) names.add(element.name)
      }
    }
  })
  return names
}

function createDiagnostic(
  code: string,
  message: string,
  file: string,
  node: Node,
  fix: string
): Diagnostic {
  return createResolvedDiagnostic(code, resolveVueRuleSeverity(code), message, file, node, fix)
}

function createContextualDiagnostic(
  code: 'vue-app-api-misuse' | 'vue-setup-context-expose-misuse',
  severity: Diagnostic['severity'],
  message: string,
  file: string,
  node: Node,
  fix: string
): Diagnostic {
  return createResolvedDiagnostic(code, resolveVueRuleSeverity(code, severity), message, file, node, fix)
}

function createResolvedDiagnostic(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  file: string,
  node: Node,
  fix: string
): Diagnostic {
  const loc = node.loc?.start
  return {
    code,
    severity,
    message,
    file,
    evidence: [{
      kind: 'vue-source',
      file,
      ...(loc?.line ? {
        line: loc.line,
        ...(typeof loc.column === 'number' ? { column: loc.column + 1 } : {})
      } : {}),
      message
    }],
    fixes: [{ title: fix }],
    confidence: 'high'
  }
}

function visitTemplate(node: Node, visit: (node: Node) => void): void {
  visit(node)
  for (const child of node.children ?? []) visitTemplate(child, visit)
}

function visitScript(node: Node, visit: (node: Node) => void): void {
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === 'object') visitScript(child as Node, visit)
    } else if (value && typeof value === 'object') {
      visitScript(value as Node, visit)
    }
  }
}

function getDirectiveName(attribute: Node): string | undefined {
  if (!attribute.directive) return undefined
  const name = attribute.key?.name
  return typeof name === 'string' ? name : name?.name
}

function getArgumentName(attribute: Node): string | undefined {
  const argument = attribute.key?.argument
  return argument?.rawName ?? argument?.name
}

function getModifiers(attribute: Node): string[] {
  return (attribute.key?.modifiers ?? []).map((modifier) =>
    typeof modifier === 'string' ? modifier : modifier.name ?? ''
  ).filter(Boolean)
}

function hasDirectiveExpression(attribute: Node | undefined): boolean {
  if (!attribute?.value) return false
  const value = attribute.value as { expression?: Node | null; value?: unknown; raw?: string }
  if (value.expression) return true
  if (typeof value.value === 'string' && value.value.trim().length > 0) return true
  if (typeof value.raw === 'string' && value.raw.replace(/^['"]|['"]$/g, '').trim().length > 0) return true
  return false
}

/**
 * vite-doctor: vue/ssr/data-allow-mismatch-surgical
 * data-allow-mismatch should be a narrow escape hatch with an explicit reason.
 */
function diagnoseDataAllowMismatch(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  source: string
): void {
  if (!source) return
  const attributes = node.startTag?.attributes ?? []
  const attr = attributes.find((attribute) => {
    if (attribute.directive) return false
    const name = typeof attribute.key?.name === 'string' ? attribute.key.name : attribute.key?.name?.name
    return name === 'data-allow-mismatch'
  })
  if (!attr) return

  const start = attr.range?.[0] ?? node.range?.[0] ?? 0
  const end = attr.range?.[1] ?? node.range?.[1] ?? start
  const snippet = source.slice(Math.max(0, start - 120), Math.min(source.length, end + 80))
  if (/doctor-allow-mismatch|allow-mismatch-reason|hydration mismatch reason/i.test(snippet)) return

  diagnostics.push(createDiagnostic(
    'vue-data-allow-mismatch-surgical',
    'data-allow-mismatch should be a narrow hydration escape hatch with an explicit reason.',
    file,
    attr,
    'Add a nearby reason comment or fix the underlying SSR/client divergence.'
  ))
}

function isNaNKeyExpression(expression: Node | null | undefined): boolean {
  if (!expression) return false
  if (expression.type === 'Identifier' && expression.name === 'NaN') return true
  if (
    expression.type === 'MemberExpression'
    && expression.object?.type === 'Identifier'
    && expression.object.name === 'Number'
    && expression.property?.name === 'NaN'
  ) return true
  if (isUnshadowedGlobalCall(expression, 'Number') && expression.arguments?.[0]) {
    // Number(undefined) etc. is too broad; only flag Number('x') style if literal NaN-producing? skip.
  }
  return false
}

function isKeepAliveElement(node: Node): boolean {
  const name = node.rawName ?? node.name
  return name === 'KeepAlive' || name === 'keep-alive'
}

function isDeprecatedVnodeHookArg(arg: string | undefined): boolean {
  if (!arg) return false
  const lower = arg.toLowerCase()
  if (lower.startsWith('vue:')) return false
  if (lower.startsWith('vnode-')) return true
  // @vnodeMounted becomes argument "vnodemounted"
  return lower.startsWith('vnode') && lower.length > 'vnode'.length
}

function toVuePrefixedHook(arg: string): string {
  const lower = arg.toLowerCase()
  if (lower.startsWith('vnode-')) return `vue:${lower.slice('vnode-'.length)}`
  if (lower.startsWith('vnode')) {
    // vnodemounted -> vue:mounted, vnodebeforemount -> vue:before-mount
    const rest = lower.slice('vnode'.length)
    const dashed = rest
      .replace(/before/g, 'before-')
      .replace(/unmount/g, 'unmount')
      .replace(/mounted/g, 'mounted')
      .replace(/updated/g, 'updated')
      .replace(/mount(?!ed)/g, 'mount')
      .replace(/update(?!d)/g, 'update')
      .replace(/--+/g, '-')
    return `vue:${dashed.replace(/^-|-$/g, '') || rest}`
  }
  return `vue:${arg}`
}

/**
 * Runtime-core useModel warnings:
 * - useModel() called with prop "x" which is not declared
 * - useModel() without required arguments
 */
function diagnoseUseModel(
  node: Node,
  file: string,
  diagnostics: Diagnostic[],
  optionPropNames: Set<string>,
  definePropsNames: Map<string, Node>
): void {
  if (!isVueCall(node, 'useModel')) return
  const args = node.arguments ?? []
  if (args.length < 2) {
    diagnostics.push(createDiagnostic(
      'vue-usemodel-missing-prop',
      'useModel() requires props and a declared prop name.',
      file,
      node,
      'Call useModel(props, "propName") with a prop declared via defineProps/props.'
    ))
    return
  }

  const nameArg = args[1]
  if (nameArg?.type !== 'Literal' || typeof (nameArg as { value?: unknown }).value !== 'string') return
  const propName = String((nameArg as { value: string }).value)
  const known = new Set<string>([...optionPropNames, ...definePropsNames.keys()])
  // If we could not recover any prop names, avoid false positives.
  if (known.size === 0) return
  if (known.has(propName)) return
  diagnostics.push(createDiagnostic(
    'vue-usemodel-undeclared-prop',
    `useModel() called with prop "${propName}" which is not declared.`,
    file,
    nameArg,
    `Declare "${propName}" in defineProps/props, or pass a declared prop name.`
  ))
}

function diagnoseRemovedFilters(node: Node, file: string, diagnostics: Diagnostic[]): void {
  const walk = (value: Node | undefined) => {
    if (!value) return
    if (value.type === 'VFilterSequenceExpression') {
      diagnostics.push(createDiagnostic(
        'vue-filters-removed',
        'filters have been removed in Vue 3. The "|" symbol will be treated as native JavaScript bitwise OR operator.',
        file,
        value,
        'Use method calls or computed properties instead of filters.'
      ))
      return
    }
    if (value.type === 'VExpressionContainer') {
      walk(value.expression ?? undefined)
    }
  }

  for (const attribute of node.startTag?.attributes ?? []) {
    walk((attribute.value as { expression?: Node | null } | null | undefined)?.expression ?? undefined)
  }
  for (const child of node.children ?? []) {
    if (child.type === 'VExpressionContainer') walk(child.expression ?? undefined)
  }
}

/**
 * Vue compiler errors 37-38 (practical subset):
 * - mixed v-slot on the component element + nested <template> slots
 * - duplicate named slots
 */
function diagnoseSlotIssues(root: Node, file: string, diagnostics: Diagnostic[]): void {
  const walk = (node: Node) => {
    if (node.type === 'VElement') {
      const elementChildren = (node.children ?? []).filter((child) => child.type === 'VElement')
      const templateSlots = elementChildren.filter((child) => {
        const name = child.rawName ?? child.name
        if (name !== 'template') return false
        return (child.startTag?.attributes ?? []).some((attribute) => getDirectiveName(attribute) === 'slot')
      })
      const hasDirectSlotOnSelf = (node.startTag?.attributes ?? []).some((attribute) => getDirectiveName(attribute) === 'slot')

      // Official compiler 37: v-slot on the component itself mixed with nested template slots.
      if (hasDirectSlotOnSelf && templateSlots.length > 0) {
        diagnostics.push(createDiagnostic(
          'vue-slot-mixed-usage',
          'Mixed v-slot usage on both the component and nested <template>. When there are multiple named slots, all slots should use <template> syntax.',
          file,
          node,
          'Move all slots to nested <template #name> syntax.'
        ))
      }

      if (templateSlots.length > 0) {
        const seen = new Map<string, Node>()
        for (const slotTemplate of templateSlots) {
          const slotAttr = (slotTemplate.startTag?.attributes ?? []).find((attribute) => getDirectiveName(attribute) === 'slot')
          const slotName = getArgumentName(slotAttr ?? {}) || 'default'
          const previous = seen.get(slotName)
          if (previous) {
            diagnostics.push(createDiagnostic(
              'vue-slot-duplicate-name',
              `Duplicate slot name "${slotName}" found.`,
              file,
              slotTemplate,
              'Keep a single template for each slot name.'
            ))
          } else {
            seen.set(slotName, slotTemplate)
          }
        }
      }
    }

    for (const child of node.children ?? []) {
      if (child && typeof child === 'object') walk(child)
    }
  }

  walk(root)
}

/**
 * Runtime warning: async setup() without Suspense.
 * Static approximation: Options API `async setup()` is reported.
 */
function diagnoseAsyncSetupWithoutSuspense(
  node: Node,
  file: string,
  diagnostics: Diagnostic[]
): void {
  if (node.type !== 'Property') return
  if (propertyName(node) !== 'setup') return
  const value = propertyValue(node)
  if (!value || (value.type !== 'FunctionExpression' && value.type !== 'ArrowFunctionExpression')) return
  if (!value.async) return
  diagnostics.push(createDiagnostic(
    'vue-async-setup-without-suspense',
    'async setup() requires a parent <Suspense> boundary to render.',
    file,
    node,
    'Wrap the component in <Suspense>, or avoid returning a Promise from setup().'
  ))
}

function propertyName(property: Node): string | undefined {
  const key = property.key?.name
  return (typeof key === 'string' ? key : key?.name) ?? property.name
}

function directCallName(node: Node): string | undefined {
  return node.type === 'CallExpression' && node.callee?.type === 'Identifier'
    ? node.callee.name
    : undefined
}

function asIdentifier(node: Node | Node[] | undefined): string | undefined {
  if (!node || Array.isArray(node)) return undefined
  if (node.type === 'Identifier' && node.name) return node.name
  return undefined
}

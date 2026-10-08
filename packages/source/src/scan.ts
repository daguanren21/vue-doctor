import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import tsParser from '@typescript-eslint/parser'
import { collectScriptBindingFacts, resolveLexicalBinding } from './bindings.js'
import { discoverSourceFiles } from './files.js'
import { collectDirectImportOrigins } from './origins.js'
import { collectGlobalPlugins } from './plugins.js'
import { parseVueSource } from './sfc.js'
import { resolveStaticValue } from './static-value.js'
import { collectOptionsConstants, collectSetupBindings, resolveStaticKnowledge, walkReferences } from './static-knowledge.js'
import type {
  AnalyzedSourceFile,
  AnalyzeSourceTextOptions,
  StaticKnowledge,
  ScanVueSourceUsageOptions,
  SourceLocation,
  VueComponentUsage,
  VueDirectiveUsage,
  VueEventUsage,
  VueModelUsage,
  VuePropUsage,
  VuePropSpreadUsage,
  VueSlotUsage,
  VueSourceUsageReport,
  VueGlobalPluginUsage,
  VueSourceFileResult
} from './types.js'
import type { VueEventHandlerSignature } from './types.js'

type TemplateNode = {
  type: string
  name?: string
  rawName?: string
  value?: string
  loc?: {
    start: ParserLocation
  }
  startTag?: {
    attributes?: TemplateAttribute[]
  }
  children?: TemplateNode[]
  variables?: Array<{ id?: { name?: string } }>
}

type TemplateAttribute = {
  directive?: boolean
  key: {
    name?: string | { name?: string }
    argument?: { name?: string | null; rawName?: string | null } | null
    modifiers?: Array<{ name: string }>
    loc?: {
      start: ParserLocation
    }
  }
  value?: {
    value?: string
    expression?: TemplateExpressionNode | null
  } | null
}

type TemplateExpressionNode = {
  type?: string
  name?: string
  raw?: string
  params?: ScriptParameterNode[]
  range?: [number, number]
  body?: unknown
  expression?: TemplateExpressionNode
}

type ParserLocation = {
  line: number
  /** ESTree columns are zero-based. */
  column: number
}

type ScriptProgramNode = {
  body?: ScriptStatementNode[]
}

type ScriptStatementNode = {
  type?: string
  id?: {
    type?: string
    name?: string
  } | null
  declaration?: ScriptObjectNode | null
  params?: ScriptParameterNode[]
  declarations?: Array<{
    id?: {
      type?: string
      name?: string
    }
    init?: {
      type?: string
      params?: ScriptParameterNode[]
    } | null
  }>
}

type ScriptObjectNode = {
  type?: string
  properties?: ScriptPropertyNode[]
}

type ScriptPropertyNode = {
  type?: string
  computed?: boolean
  kind?: string
  key?: {
    type?: string
    name?: string
    value?: string
  }
  value?: ScriptObjectNode & {
    params?: ScriptParameterNode[]
  }
}

type ScriptParameterNode = {
  type?: string
  name?: string
  optional?: boolean
  argument?: ScriptParameterNode
  left?: ScriptParameterNode
}

export async function scanVueSourceUsage(options: ScanVueSourceUsageOptions = {}): Promise<VueSourceUsageReport> {
  const root = resolve(options.root ?? process.cwd())
  const discovery = await discoverSourceFiles(root, options.scope)
  const files = discovery.files
  const components: VueComponentUsage[] = []
  const globalPlugins: VueGlobalPluginUsage[] = []
  const fileResults: VueSourceFileResult[] = []

  for (const file of files) {
    try {
      const source = await readFile(file, 'utf8')
      const analyzed = analyzeSourceText(file, source)
      if (analyzed.parsed) {
        options.onVueFile?.({ file, source, parsed: analyzed.parsed })
      }
      components.push(...analyzed.components)
      globalPlugins.push(...analyzed.globalPlugins)
      fileResults.push(analyzed.fileResult)
    } catch (error) {
      fileResults.push({
        file,
        blocks: [{
          kind: file.endsWith('.vue') ? 'template' : 'script',
          status: 'failed',
          message: getErrorMessage(error)
        }]
      })
    }
  }

  return {
    root,
    files,
    discoveryIssues: discovery.issues,
    components,
    globalPlugins,
    fileResults
  }
}

export function analyzeSourceText(
  file: string,
  source: string,
  options: AnalyzeSourceTextOptions = {},
  parsedVueSource?: ReturnType<typeof parseVueSource>
): AnalyzedSourceFile {
  if (file.endsWith('.vue')) {
    const scanned = scanVueFile(file, source, options, parsedVueSource)
    return {
      fileResult: { file, blocks: scanned.blocks },
      components: scanned.components,
      globalPlugins: scanned.globalPlugins,
      parsed: scanned.parsed,
      preparedDocument: {
        file,
        language: 'vue',
        blocks: structuredClone(scanned.parsed.document.blocks),
        errors: structuredClone(scanned.parsed.document.errors),
        ...(scanned.parsed.document.structuralFailures ? { structuralFailures: structuredClone(scanned.parsed.document.structuralFailures) } : {})
      }
    }
  }

  try {
    const program = parseScript(source, file)
    const fileResult = { file, blocks: [{ kind: 'script' as const, status: 'available' as const }] }
    return {
      fileResult,
      components: [],
      globalPlugins: collectGlobalPlugins(file, program),
      preparedDocument: scriptPreparedDocument(file, source, [])
    }
  } catch (error) {
    const errors = [sourceDocumentError(error)]
    return {
      fileResult: {
        file,
        blocks: [{ kind: 'script', status: 'failed', message: getErrorMessage(error) }]
      },
      components: [],
      globalPlugins: [],
      preparedDocument: scriptPreparedDocument(file, source, errors)
    }
  }
}

function scanVueFile(
  file: string,
  source: string,
  options: AnalyzeSourceTextOptions,
  parsedVueSource?: ReturnType<typeof parseVueSource>
) {
  const parsed = parsedVueSource ?? parseVueSource(source, file)
  const templateSource = parsed.templateSource ?? source
  const scriptPrograms = parsed.scriptPrograms as ScriptProgramNode[]
  const templateBody = (parsed.templateAst as { templateBody?: TemplateNode } | undefined)?.templateBody
  const globalPlugins = deduplicatePlugins(
    scriptPrograms.flatMap((program) => collectGlobalPlugins(file, program))
  )
  if (!templateBody) {
    return { components: [], globalPlugins, blocks: parsed.blocks, parsed }
  }

  const origins = new Map(scriptPrograms.flatMap((program) => [...collectDirectImportOrigins(program)]))
  const components: VueComponentUsage[] = []
  const setupIndex = parsed.blocks.find((block) => block.kind === 'script')?.status === 'available' ? 1 : 0
  const setupProgram = parsed.blocks.find((block) => block.kind === 'script-setup')?.status === 'available'
    ? scriptPrograms[setupIndex] : undefined
  const setupConstants = setupProgram ? collectSetupBindings(setupProgram, templateBody) : undefined
  const handlers = new Map(scriptPrograms.flatMap((program) => [
    ...collectHandlerDeclarations(program, templateBody, program === setupProgram ? setupConstants : undefined)
  ]))
  const constants = options.resolveConstants
    ? setupProgram
      ? setupConstants
      : collectOptionsConstants(setupIndex === 1 ? scriptPrograms[0] : undefined, templateBody)
    : undefined
  visitTemplateNode(templateBody, (node, parent, shadowed) => {
    if (!isComponentNode(node) && !(options.includeNativeElements && node.type === 'VElement' && node.name !== 'template')) {
      return
    }

    const tag = node.rawName ?? node.name ?? ''
    const componentName = normalizeComponentName(tag)
    const attributes = node.startTag?.attributes ?? []
    const origin = origins.get(componentName) ?? origins.get(tag)
    components.push({
      file,
      tag,
      componentName,
      loc: toLoc(node),
      ...(parent ? { parent: toLoc(parent) } : {}),
      ...(options.includeNativeElements && tag === 'button' ? { childContent: classifyButtonContent(node) } : {}),
      props: attributes.flatMap((attribute) => toProp(attribute, templateSource, constants, shadowed)),
      propSpreads: attributes.flatMap((attribute) => toPropSpread(attribute, templateSource)),
      events: attributes.flatMap((attribute) => toEvent(attribute, templateSource, handlers, shadowed)),
      models: attributes.flatMap((attribute) => toModel(attribute, templateSource)),
      slots: toSlots(node, templateSource),
      directives: attributes.flatMap((attribute) => toDirective(attribute, templateSource, constants, shadowed)),
      ...(origin ? { origin } : {})
    })
  })

  return { components, globalPlugins, blocks: parsed.blocks, parsed }
}

function scriptPreparedDocument(
  file: string,
  source: string,
  errors: Array<{ message: string; line?: number; column?: number }>
): AnalyzedSourceFile['preparedDocument'] {
  const language = file.slice(file.lastIndexOf('.') + 1)
  return {
    file,
    language,
    blocks: [{
      kind: 'document',
      lang: language,
      content: source,
      start: 0,
      end: source.length,
      loc: { line: 1, column: 1 },
      attributes: {}
    }],
    errors
  }
}

function sourceDocumentError(error: unknown) {
  const detail = error as {
    message?: string
    lineNumber?: number
    column?: number
    loc?: { start?: { line?: number; column?: number } }
  }
  return {
    message: detail?.message ?? String(error),
    ...(detail?.loc?.start?.line !== undefined
      ? { line: detail.loc.start.line }
      : detail?.lineNumber !== undefined
        ? { line: detail.lineNumber }
        : {}),
    ...(detail?.loc?.start?.column !== undefined
      ? { column: detail.loc.start.column }
      : detail?.column !== undefined
        ? { column: detail.column + 1 }
        : {})
  }
}

function classifyButtonContent(button: TemplateNode): NonNullable<VueComponentUsage['childContent']> {
  const replacesContent = (node: TemplateNode) => (node.startTag?.attributes ?? []).some((attribute) => {
    const directive = getDirectiveName(attribute)
    if (attribute.directive && ['html', 'text'].includes(directive ?? '')) return true
    if (attribute.directive && directive === 'bind' && !getArgumentName(attribute)) return true
    const name = attribute.directive ? getArgumentName(attribute) : getStaticAttributeName(attribute)
    return ['innerhtml', 'textcontent'].includes(name?.toLowerCase() ?? '')
  })
  const visit = (node: TemplateNode): NonNullable<VueComponentUsage['childContent']> => {
    if (node.type === 'VText') return node.value?.trim() ? 'text' : 'empty'
    if (node.type === 'VExpressionContainer') return 'unknown'
    if (node.type !== 'VElement') return 'empty'
    const tag = node.rawName ?? node.name ?? ''
    if (node !== button) {
      const conditional = (node.startTag?.attributes ?? []).some((attribute) => {
        if (attribute.directive && !['bind', 'on'].includes(getDirectiveName(attribute) ?? '')) return true
        const name = attribute.directive ? getArgumentName(attribute) : getStaticAttributeName(attribute)
        return name?.toLowerCase() === 'hidden'
      })
      if (conditional || replacesContent(node)) return 'unknown'
      if (tag === 'svg') {
        const pending = [...(node.children ?? [])]
        while (pending.length > 0) {
          const child = pending.pop()
          if (!child) continue
          const childTag = child.rawName ?? child.name ?? ''
          // Only title/desc are metadata; SVG text, foreign HTML and referenced symbols may label the button.
          if (['title', 'desc'].includes(childTag)) continue
          if (child.type === 'VExpressionContainer' || ['text', 'foreignObject', 'foreignobject', 'use'].includes(childTag)
            || isComponentNode(child) || replacesContent(child)) return 'unknown'
          pending.push(...(child.children ?? []))
        }
        return 'graphic-only'
      }
      if (!['template', 'span', 'div', 'p', 'strong', 'b', 'em', 'small', 'label', 'a', 'u', 's', 'mark',
        'code', 'kbd', 'sub', 'sup', 'abbr', 'cite', 'q', 'br', 'wbr', 'i'].includes(tag)) return 'unknown'
    }
    let graphic = false
    let unknown = tag === 'i'
    for (const child of node.children ?? []) {
      const content = visit(child)
      if (content === 'text') return 'text'
      if (content === 'graphic-only') graphic = true
      if (content === 'unknown') unknown = true
    }
    return unknown ? 'unknown' : graphic ? 'graphic-only' : 'empty'
  }
  return replacesContent(button) ? 'unknown' : visit(button)
}

function parseScript(source: string, file: string): ScriptProgramNode {
  return tsParser.parse(source, {
    sourceType: 'module',
    ecmaVersion: 'latest',
    filePath: file
  }) as ScriptProgramNode
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function visitTemplateNode(
  node: TemplateNode,
  visit: (node: TemplateNode, parent: TemplateNode | undefined, shadowed: ReadonlySet<string>) => void,
  parent?: TemplateNode,
  inherited: ReadonlySet<string> = new Set()
) {
  const shadowed = node.variables?.length ? new Set([...inherited, ...node.variables.flatMap((variable) => variable.id?.name ? [variable.id.name] : [])]) : inherited
  visit(node, parent, shadowed)

  for (const child of node.children ?? []) {
    visitTemplateNode(child, visit, isComponentNode(node) ? node : parent, shadowed)
  }
}

function isComponentNode(node: TemplateNode) {
  const tag = node.rawName ?? node.name ?? ''
  return node.type === 'VElement' && tag !== 'template' && (isPascalCase(tag) || tag.includes('-') || tag === 'Component')
}

function toProp(attribute: TemplateAttribute, source: string, constants?: ReadonlyMap<string, StaticKnowledge>, shadowed?: ReadonlySet<string>): VuePropUsage[] {
  if (!attribute.directive) {
    const name = getStaticAttributeName(attribute)
    if (!name) {
      return []
    }

    if (!attribute.value) {
      return [{
        name,
        kind: 'boolean',
        loc: toLoc(attribute.key)
      }]
    }

    return [{
      name,
      kind: 'static',
      value: attribute.value.value,
      loc: toLoc(attribute.key)
    }]
  }

  if (getDirectiveName(attribute) !== 'bind') {
    return []
  }

  const argument = getArgumentName(attribute)
  if (!argument) {
    return []
  }

  const staticEvidence = constants ? resolveStaticKnowledge(attribute.value?.expression, constants, shadowed) : undefined
  const staticValue = staticEvidence ? (staticEvidence.complete ? staticEvidence.value : undefined) : resolveStaticValue(attribute.value?.expression)
  return [{
    name: argument,
    kind: 'dynamic',
    expression: getExpression(attribute, source),
    ...(staticValue !== undefined ? { staticValue } : {}),
    ...(staticEvidence ? { staticEvidence } : {}),
    loc: toLoc(attribute.key)
  }]
}

function toPropSpread(attribute: TemplateAttribute, source: string): VuePropSpreadUsage[] {
  if (!attribute.directive || getDirectiveName(attribute) !== 'bind') {
    return []
  }
  if (getArgumentName(attribute)) {
    return []
  }

  return [{
    expression: getExpression(attribute, source),
    loc: toLoc(attribute.key)
  }]
}

function toEvent(
  attribute: TemplateAttribute,
  source: string,
  handlers: Map<string, VueEventHandlerSignature>,
  shadowed: ReadonlySet<string>
): VueEventUsage[] {
  if (attribute.directive && getDirectiveName(attribute) === 'on') {
    const argument = getArgumentName(attribute)
    if (!argument) {
      return []
    }

    return [{
      name: argument,
      modifiers: attribute.key.modifiers?.map((modifier) => modifier.name) ?? [],
      expression: getExpression(attribute, source),
      handler: getEventHandlerSignature(attribute, handlers, shadowed),
      loc: toLoc(attribute.key)
    }]
  }

  return []
}

function toModel(attribute: TemplateAttribute, source: string): VueModelUsage[] {
  if (!attribute.directive || getDirectiveName(attribute) !== 'model') {
    return []
  }

  return [{
    argument: getArgumentName(attribute),
    expression: getExpression(attribute, source),
    modifiers: attribute.key.modifiers?.map((modifier) => modifier.name) ?? [],
    loc: toLoc(attribute.key)
  }]
}

function toSlots(node: TemplateNode, source: string): VueSlotUsage[] {
  return (node.children ?? []).flatMap((child) => {
    if ((child.rawName ?? child.name) !== 'template') {
      return []
    }

    const attributes = child.startTag?.attributes ?? []
    return attributes.flatMap((attribute) => toSlot(attribute, source))
  })
}

function toSlot(attribute: TemplateAttribute, source: string): VueSlotUsage[] {
  if (!attribute.directive) {
    const name = getStaticAttributeName(attribute)
    if (!name?.startsWith('#')) {
      return []
    }

    return [{
      name: name.slice(1) || 'default',
      loc: toLoc(attribute.key)
    }]
  }

  if (getDirectiveName(attribute) !== 'slot') {
    return []
  }

  return [{
    name: getArgumentName(attribute) ?? 'default',
    expression: getExpression(attribute, source),
    loc: toLoc(attribute.key)
  }]
}

function toDirective(attribute: TemplateAttribute, source: string, constants?: ReadonlyMap<string, StaticKnowledge>, shadowed?: ReadonlySet<string>): VueDirectiveUsage[] {
  if (!attribute.directive) {
    return []
  }
  const name = getDirectiveName(attribute)
  if (!name || ['bind', 'on', 'model', 'slot'].includes(name)) {
    return []
  }
  return [{
    name,
    argument: getArgumentName(attribute),
    modifiers: attribute.key.modifiers?.map((modifier) => modifier.name) ?? [],
    expression: getExpression(attribute, source),
    ...(constants ? { staticEvidence: resolveStaticKnowledge(attribute.value?.expression, constants, shadowed) } : {}),
    loc: toLoc(attribute.key)
  }]
}

function getStaticAttributeName(attribute: TemplateAttribute) {
  if (typeof attribute.key.name === 'string') {
    return attribute.key.name
  }

  return attribute.key.name?.name
}

function getDirectiveName(attribute: TemplateAttribute) {
  const name = attribute.key.name
  if (typeof name === 'string') {
    return name
  }

  return name?.name
}

function getArgumentName(attribute: TemplateAttribute) {
  return attribute.key.argument?.rawName ?? attribute.key.argument?.name ?? undefined
}

function getExpression(attribute: TemplateAttribute, source: string) {
  const expression = attribute.value?.expression
  if (!expression) {
    return attribute.value?.value
  }

  if (expression.range) {
    return source.slice(expression.range[0], expression.range[1])
  }

  return expression.raw ?? expression.name
}

function getEventHandlerSignature(
  attribute: TemplateAttribute,
  handlers: Map<string, VueEventHandlerSignature>,
  shadowed: ReadonlySet<string>
): VueEventHandlerSignature | undefined {
  let expression = attribute.value?.expression
  // The template parser can wrap a function with call/default syntax in VOnExpression.
  // Inspect its actual AST instead of treating a function-valued listener as statements.
  if (expression?.type === 'VOnExpression' && Array.isArray(expression.body) && expression.body.length === 1) {
    const statement = expression.body[0] as TemplateExpressionNode
    let candidate = statement.type === 'ExpressionStatement' ? statement.expression : undefined
    while (candidate && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ChainExpression'].includes(candidate.type ?? '')) {
      candidate = candidate.expression
    }
    if (candidate && ['ArrowFunctionExpression', 'FunctionExpression', 'Identifier', 'MemberExpression'].includes(candidate.type ?? '')) {
      expression = candidate
    }
  }
  if (!expression || (expression.type === 'VOnExpression' && getHandlerPayloadUsage(expression, []) === 'ignored')) {
    return {
      kind: 'inline',
      parameters: [],
      minArity: 0,
      maxArity: 0,
      payloadUsage: 'ignored'
    }
  }
  if (expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression') {
    return createHandlerSignature('inline', expression.params ?? [], expression)
  }
  if (expression.type === 'Identifier' && expression.name) {
    return shadowed.has(expression.name) ? undefined : handlers.get(expression.name)
  }
  return undefined
}

function collectHandlerDeclarations(
  program: ScriptProgramNode,
  template: TemplateNode,
  constants?: ReadonlyMap<string, StaticKnowledge>
): Map<string, VueEventHandlerSignature> {
  const handlers = new Map<string, VueEventHandlerSignature>()

  for (const statement of program.body ?? []) {
    if (statement.type === 'FunctionDeclaration' && statement.id?.name && constants?.has(statement.id.name)) {
      handlers.set(statement.id.name, createHandlerSignature('reference', statement.params ?? [], statement))
    }

    if (constants && statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations ?? []) {
        if (!declaration.id?.name || !declaration.init || !constants?.has(declaration.id.name)) {
          continue
        }

        if (declaration.init.type === 'ArrowFunctionExpression' || declaration.init.type === 'FunctionExpression') {
          handlers.set(declaration.id.name, createHandlerSignature('reference', declaration.init.params ?? [], declaration.init))
        }
      }
    }

    if (!constants && statement.type === 'ExportDefaultDeclaration' && statement.declaration) {
      collectOptionsApiMethods(statement.declaration, handlers)
    }
  }

  const invalidate = (node: HandlerAstNode): void => {
    if (['AssignmentExpression', 'UpdateExpression', 'ForOfStatement', 'ForInStatement'].includes(node.type ?? '')
      || (node.type === 'UnaryExpression' && node.operator === 'delete')) {
      visitHandlerNodes(node.left ?? node.argument, (target) => {
        if (target.type === 'Identifier' && target.name) handlers.delete(target.name)
        if (target.type === 'MemberExpression' && target.computed
          && (target.object as HandlerAstNode | undefined)?.type === 'ThisExpression') handlers.clear()
      })
    }
    if (node.type === 'CallExpression' && (node.callee as HandlerAstNode | undefined)?.name === 'eval') handlers.clear()
  }
  visitHandlerNodes(program, invalidate)
  visitHandlerNodes(template, invalidate)

  return handlers
}

function collectOptionsApiMethods(
  declaration: ScriptObjectNode,
  handlers: Map<string, VueEventHandlerSignature>
) {
  if (declaration.type !== 'ObjectExpression' || declaration.properties?.some((property) => property.type !== 'Property' || property.computed)) {
    return
  }

  const options = new Map((declaration.properties ?? []).map((property) => [getPropertyName(property), property]))
  if (options.has('mixins') || options.has('extends')) return
  const exposed = collectOptionsExposedNames(options)
  if (!exposed) return
  const methods = options.get('methods')
  if (methods?.value?.type !== 'ObjectExpression' || methods.value.properties?.some((property) => property.type !== 'Property' || property.computed || property.kind !== 'init')) {
    return
  }
  const methodValues = new Map((methods.value.properties ?? []).map((property) => [getPropertyName(property), property.value]))
  let instanceEscapes = false
  visitHandlerNodes(declaration, (node, parent) => {
    if (node.type === 'ThisExpression'
      && !(parent?.type === 'MemberExpression' && parent.object === node && !parent.computed)) {
      instanceEscapes = true
    }
    if (node.type === 'CallExpression' || node.type === 'TaggedTemplateExpression') {
      const callee = (node.callee ?? node.tag) as HandlerAstNode | undefined
      if (callee?.type !== 'MemberExpression' || (callee.object as HandlerAstNode | undefined)?.type !== 'ThisExpression') return
      const name = !callee.computed ? (callee.property as HandlerAstNode | undefined)?.name : undefined
      const target = methodValues.get(name)
      if (!name || exposed.has(name) || !target || !['FunctionExpression', 'ArrowFunctionExpression'].includes(target.type ?? '')) instanceEscapes = true
    }
  })
  if (instanceEscapes) return

  for (const method of methods.value.properties ?? []) {
    const name = getPropertyName(method)
    if (!name || !method.value || exposed.has(name)) {
      continue
    }

    handlers.delete(name)
    if (method.value.type === 'FunctionExpression' || method.value.type === 'ArrowFunctionExpression') {
      handlers.set(name, createHandlerSignature('reference', method.value.params ?? [], method.value))
    }
  }
}

/** Other instance namespaces must have closed shapes before a methods binding can be trusted. */
function collectOptionsExposedNames(
  options: ReadonlyMap<string | undefined, ScriptPropertyNode>
): Set<string> | undefined {
  const names = new Set<string>()
  for (const option of ['data', 'setup', 'computed', 'props', 'inject']) {
    const property = options.get(option)
    if (!property) continue
    if (property.kind !== 'init') return undefined
    let value = property.value as HandlerAstNode | undefined
    if (option === 'data' || option === 'setup') {
      if (!value || !['FunctionExpression', 'ArrowFunctionExpression'].includes(value.type ?? '') || value.async || value.generator) return undefined
      const body = value.body as HandlerAstNode | undefined
      if (body?.type === 'BlockStatement') {
        const statements = body.body as HandlerAstNode[]
        const last = statements.at(-1)
        if (last?.type !== 'ReturnStatement' || statements.slice(0, -1).some((statement) => !['VariableDeclaration', 'FunctionDeclaration', 'ExpressionStatement', 'EmptyStatement'].includes(statement.type ?? ''))) return undefined
        value = last.argument as HandlerAstNode | undefined
      } else {
        value = body
      }
    }
    if ((option === 'props' || option === 'inject') && value?.type === 'ArrayExpression') {
      for (const element of (value.elements ?? []) as Array<HandlerAstNode | null>) {
        if (element?.type !== 'Literal' || typeof element.value !== 'string') return undefined
        names.add(element.value)
      }
      continue
    }
    if (value?.type !== 'ObjectExpression') return undefined
    for (const field of (value.properties ?? []) as ScriptPropertyNode[]) {
      const name = getPropertyName(field)
      if (field.type !== 'Property' || field.computed || !name || name === '__proto__') return undefined
      names.add(name)
    }
  }
  return names
}

function getPropertyName(property: ScriptPropertyNode): string | undefined {
  if (property.key?.name) {
    return property.key.name
  }

  if (typeof property.key?.value === 'string') {
    return property.key.value
  }

  return undefined
}

function createHandlerSignature(
  kind: VueEventHandlerSignature['kind'],
  params: ScriptParameterNode[],
  node: unknown
): VueEventHandlerSignature {
  const parameters = params.map((param, index) => getParameterName(param) ?? `arg${index + 1}`)

  return {
    kind,
    parameters,
    minArity: countLeadingRequiredParameters(params),
    maxArity: params.some((param) => param.type === 'RestElement') ? null : params.length,
    payloadUsage: getHandlerPayloadUsage(node, params)
  }
}

type HandlerAstNode = {
  type?: string
  name?: string
  computed?: boolean
  range?: [number, number]
  [key: string]: unknown
}

function getHandlerPayloadUsage(value: unknown, params: ScriptParameterNode[]): 'ignored' | 'unknown' {
  // Destructuring/defaults may read the payload before the function body runs.
  const bindings = params.map((param) => param.type === 'RestElement' ? param.argument : param)
  if (bindings.some((binding) => binding?.type !== 'Identifier')) return 'unknown'
  const node = value as HandlerAstNode
  const body = node.type === 'VOnExpression' ? node : node.body
  if (!body) return 'unknown'
  const facts = collectScriptBindingFacts({ type: 'Program', body: [value] })
  const parameters = new Set(bindings.map((binding) => resolveLexicalBinding(facts, binding)).filter(Boolean))
  const parameterNames = new Set(bindings.map((binding) => binding?.name))
  let unknown = false
  walkReferences(body, (name, reference) => {
    if (name === 'arguments' || name === 'eval' || name === 'Function') unknown = true
    const binding = resolveLexicalBinding(facts, reference)
    if (name === '$event' && !binding) unknown = true
    if (parameterNames.has(name) && (!binding || parameters.has(binding))) unknown = true
  })
  visitHandlerNodes(body, (child) => {
    if (child.type === 'SpreadElement' || (child.type === 'MemberExpression' && child.computed)) unknown = true
  })
  return unknown ? 'unknown' : 'ignored'
}

function visitHandlerNodes(
  value: unknown,
  visit: (node: HandlerAstNode, parent?: HandlerAstNode) => void,
  parent?: HandlerAstNode
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const child of value) visitHandlerNodes(child, visit, parent)
    return
  }
  const node = value as HandlerAstNode
  if (typeof node.type === 'string') visit(node, parent)
  for (const [key, child] of Object.entries(node)) {
    if (['parent', 'tokens', 'comments', 'references', 'variables', 'loc', 'range', 'typeAnnotation', 'typeParameters', 'typeArguments', 'returnType'].includes(key)) continue
    visitHandlerNodes(child, visit, node)
  }
}

function countLeadingRequiredParameters(params: ScriptParameterNode[]) {
  let count = 0
  for (const param of params) {
    if (!isRequiredParameter(param)) {
      break
    }
    count += 1
  }
  return count
}

function isRequiredParameter(param: ScriptParameterNode) {
  return param.type !== 'RestElement' && param.type !== 'AssignmentPattern' && param.optional !== true
}

function deduplicatePlugins(plugins: VueGlobalPluginUsage[]) {
  return [...new Map(
    plugins.map((plugin) => [`${plugin.package.specifier}\0${plugin.localName}`, plugin])
  ).values()]
}

function getParameterName(param: ScriptParameterNode): string | undefined {
  if (param.type === 'Identifier') {
    return param.name
  }

  if (param.type === 'RestElement') {
    return getParameterName(param.argument ?? {})
  }

  if (param.type === 'AssignmentPattern') {
    return getParameterName(param.left ?? {})
  }

  return undefined
}

function normalizeComponentName(tag: string) {
  if (!tag.includes('-')) {
    return tag
  }

  return tag
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
}

function isPascalCase(value: string) {
  return /^[A-Z]/.test(value)
}

function toLoc(node: { loc?: { start: ParserLocation } }): SourceLocation {
  return {
    line: node.loc?.start.line ?? 1,
    column: (node.loc?.start.column ?? 0) + 1
  }
}

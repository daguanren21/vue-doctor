import { readFile, realpath } from 'node:fs/promises'
import { SourceMap, type SourceMapPayload } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { babelParse } from '@vue/compiler-sfc'
import type { EvidenceFile } from '../types.js'

type BundleNode = { type: string; [key: string]: unknown }

interface GeneratedPosition {
  line: number
  column: number
}

interface GeneratedLocation {
  start: GeneratedPosition
  end: GeneratedPosition
}

export interface MappedRuntimeEntry {
  file: string
  source: string
  mapFile: string
  defaultOnly: boolean
}

/** Trace a webpack 3/4 public entry to its mapped ESM source, without evaluating the bundle. */
export async function readMappedRuntimeEntry(
  entry: EvidenceFile,
  packageRoot: string,
  available: ReadonlySet<string>
): Promise<MappedRuntimeEntry | undefined> {
  try {
    const source = await readFile(entry.path, 'utf8')
    const reference = /\/\/[#@]\s*sourceMappingURL=([^\s]+)\s*$/.exec(source)?.[1]
    if (!reference || basename(reference) !== reference || !reference.endsWith('.map')) return undefined
    const physicalRoot = await realpath(packageRoot)
    for (const file of [entry.path, resolve(dirname(entry.path), reference)]) {
      const path = relative(physicalRoot, await realpath(file))
      if (isAbsolute(path) || path === '..' || path.startsWith('../')) return undefined
    }
    const mapFile = resolve(dirname(entry.path), reference)
    const payload = JSON.parse(await readFile(mapFile, 'utf8')) as SourceMapPayload
    if (payload.version !== 3 || !Array.isArray(payload.sources) || !Array.isArray(payload.sourcesContent)
      || (payload.sourceRoot && payload.sourceRoot !== '')) return undefined
    const body = babelParse(source, { sourceType: 'unambiguous' }).program.body as unknown as BundleNode[]
    const publicExpression = publicBundleExpression(body)
    const module = publicExpression && webpackEntry(publicExpression)
    if (!module) return undefined
    const exportsName = node(list(module.params)[1])?.name
    if (typeof exportsName !== 'string') return undefined
    const map = new SourceMap(payload)
    const mappingLines = payload.mappings.split(';')
    const mappedColumns = new Map<number, Set<number>>()
    const mapped = new Map<string, MappedRuntimeEntry>()
    const originalPrograms = new Map<string, BundleNode[]>()
    let replacedExports = false
    visit(node(module.body), value => {
      if (value.type !== 'AssignmentExpression' || value.operator !== '=') return
      const left = node(value.left)
      if (left?.type === 'Identifier' && left.name === exportsName) replacedExports = true
      if (left?.type === 'MemberExpression' && node(left.object)?.name === node(list(module.params)[0])?.name
        && (left.computed ? node(left.property)?.value : node(left.property)?.name) === 'exports') replacedExports = true
      if (left?.type !== 'MemberExpression' || node(left.object)?.name !== exportsName) return
      const targets: Array<{ node: BundleNode; kind?: 'import' | 'local' }> = [{ node: value }]
      if ((left.computed ? node(left.property)?.value : node(left.property)?.name) === 'default') {
        const binding = tracePublicDefaultValue(module, node(value.right))
        if (binding) targets.push(binding)
      }
      for (const target of targets) {
        const loc = target.node.loc as GeneratedLocation | undefined
        const rightLoc = node(target.node.right)?.loc as GeneratedLocation | undefined
        if (!loc?.start || !loc.end) continue
        const probes = [loc.start, ...(rightLoc?.start ? [rightLoc.start] : [])]
        if (loc.end.column > 0) probes.push({ line: loc.end.line, column: loc.end.column - 1 })
        for (const probe of probes) {
          const location = map.findEntry(probe.line - 1, probe.column)
          if (!('originalSource' in location) || typeof location.originalSource !== 'string') continue
          // A greatest-lower-bound lookup cannot borrow another expression's mapping.
          if (!containsPosition(target.node, location.generatedLine + 1, location.generatedColumn)) continue
          let columns = mappedColumns.get(location.generatedLine)
          if (!columns) {
            columns = readMappedColumns(mappingLines[location.generatedLine] ?? '')
            mappedColumns.set(location.generatedLine, columns)
          }
          // Node retains original coordinates for some one-field unmapped segments.
          if (!columns.has(location.generatedColumn)) continue
          const index = payload.sources.indexOf(location.originalSource)
          const content = payload.sourcesContent?.[index]
          const relativePath = location.originalSource.replace(/^webpack:\/\/[^/]*\/(?:\.\/)?/, '')
          if (relativePath === location.originalSource || /[?#]/.test(relativePath)) continue
          const file = resolve(packageRoot, relativePath)
          if (!available.has(file) || typeof content !== 'string') continue
          let original = originalPrograms.get(file)
          if (!original) {
            original = babelParse(content, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program.body as unknown as BundleNode[]
            originalPrograms.set(file, original)
          }
          const line = location.originalLine + 1
          const column = location.originalColumn
          const proven = target.kind
            ? isOriginalDefaultBinding(original, line, column, target.kind)
            : original.some(statement => statement.type.startsWith('Export') && containsPosition(statement, line, column))
          if (!proven) continue
          const defaultOnly = target.kind !== undefined || publicExpression?.type === 'MemberExpression'
          const existing = mapped.get(file)
          mapped.set(file, { file, source: content, mapFile, defaultOnly: existing ? existing.defaultOnly && defaultOnly : defaultOnly })
        }
      }
    })
    if (replacedExports || mapped.size !== 1) return undefined
    const candidate = [...mapped.values()][0]!
    const path = relative(physicalRoot, await realpath(candidate.file))
    if (isAbsolute(path) || path === '..' || path.startsWith('../')) return undefined
    const published = await readFile(candidate.file, 'utf8')
    if (normalizedEntrySource(candidate.source) !== normalizedEntrySource(published)) return undefined
    return { ...candidate, source: published }
  } catch {
    // Unreadable, malformed, unsupported or ambiguous maps cannot prove a public identity.
    return undefined
  }
}

function containsPosition(value: BundleNode, line: number, column: number): boolean {
  const loc = value.loc as GeneratedLocation | undefined
  return !!loc && line >= loc.start.line && line <= loc.end.line
    && (line !== loc.start.line || column >= loc.start.column)
    && (line !== loc.end.line || column < loc.end.column)
}

/** Follow only identity-preserving aliases and Babel's default-import interop. */
function tracePublicDefaultValue(
  module: BundleNode,
  value: BundleNode | undefined
): { node: BundleNode; kind: 'import' | 'local' } | undefined {
  const bindings = new Map<string, BundleNode | undefined>()
  for (const statement of list(node(module.body)?.body)) {
    if (statement.type !== 'VariableDeclaration') continue
    for (const declaration of list(statement.declarations)) {
      const name = node(declaration.id)?.name
      if (typeof name === 'string') bindings.set(name, bindings.has(name) ? undefined : node(declaration.init))
    }
  }
  const names = new Set<string>()
  const loader = node(list(module.params)[2])?.name
  let imported = false
  let selectedDefault = false
  while (value) {
    if (value.type === 'Identifier' && typeof value.name === 'string') {
      if (names.has(value.name)) return undefined
      names.add(value.name)
      value = bindings.get(value.name)
      continue
    }
    if (value.type === 'MemberExpression' && !selectedDefault
      && (value.computed ? node(value.property)?.value : node(value.property)?.name) === 'default') {
      selectedDefault = true
      value = node(value.object)
      continue
    }
    if (selectedDefault && !imported && isDefaultInterop(value)) {
      imported = true
      value = list(value.arguments)[0]
      continue
    }
    break
  }
  const kind = imported && typeof loader === 'string' && value?.type === 'CallExpression' && node(value.callee)?.name === loader
    && !bindings.has(String(loader)) && list(value.arguments).length === 1
    && ['StringLiteral', 'NumericLiteral'].includes(list(value.arguments)[0]?.type ?? '')
    ? 'import' : !selectedDefault && value?.type === 'ObjectExpression' ? 'local' : undefined
  if (!kind || !value) return undefined
  if (kind === 'import' && typeof loader === 'string') names.add(loader)
  let mutated = false
  visit(node(module.body), current => {
    let target = current.type === 'AssignmentExpression' ? node(current.left)
      : current.type === 'UpdateExpression' || (current.type === 'UnaryExpression' && current.operator === 'delete')
        ? node(current.argument) : undefined
    while (target?.type === 'MemberExpression') target = node(target.object)
    if (target?.type === 'Identifier' && names.has(String(target.name))) mutated = true
    if (current.type === 'VariableDeclarator' && !names.has(String(node(current.id)?.name))
      && referencesBinding(node(current.init), names)) mutated = true
    if (current.type === 'CallExpression' || current.type === 'NewExpression') {
      const callee = node(current.callee)
      const args = list(current.arguments)
      const vue = node(callee?.object)
      const registration = callee?.type === 'MemberExpression' && !callee.computed
        && node(callee.property)?.name === 'component' && vue?.type === 'MemberExpression' && !vue.computed
        && node(vue.property)?.name === 'Vue' && node(vue.object)?.name === 'window'
        && !bindings.has('window') && !list(module.params).some(parameter => parameter.name === 'window')
        && args.length === 2 && args[0]?.type === 'StringLiteral'
      if (callee?.type === 'Identifier' && callee.name === 'eval') mutated = true
      if (!registration && !isDefaultInterop(current)
        && (args.some(argument => referencesBinding(argument, names))
          || (callee?.name !== loader && referencesBinding(callee, names)))) mutated = true
    }
  })
  return mutated ? undefined : { node: value, kind }
}

function referencesBinding(value: BundleNode | undefined, names: ReadonlySet<string>): boolean {
  if (!value) return false
  if (value.type === 'Identifier') return names.has(String(value.name))
  for (const [key, child] of Object.entries(value)) {
    if (key === 'id' || (key === 'key' && !value.computed)
      || (key === 'property' && value.type === 'MemberExpression' && !value.computed)) continue
    if (Array.isArray(child)) {
      if (list(child).some(item => referencesBinding(item, names))) return true
    } else if (referencesBinding(node(child), names)) return true
  }
  return false
}

function isDefaultInterop(value: BundleNode): boolean {
  if (value.type !== 'CallExpression' || list(value.arguments).length !== 1) return false
  const fn = node(value.callee)
  const parameters = list(fn?.params)
  const statements = list(node(fn?.body)?.body)
  const parameter = parameters[0]
  if (fn?.type !== 'FunctionExpression' || fn.async || fn.generator
    || parameters.length !== 1 || parameter?.type !== 'Identifier'
    || statements.length !== 1 || statements[0]?.type !== 'ReturnStatement') return false
  const returned = node(statements[0].argument)
  const test = node(returned?.test)
  const marker = node(test?.right)
  const alternate = node(returned?.alternate)
  const properties = list(alternate?.properties)
  return returned?.type === 'ConditionalExpression' && test?.type === 'LogicalExpression' && test.operator === '&&'
    && node(test.left)?.name === parameter.name && marker?.type === 'MemberExpression' && !marker.computed
    && node(marker.object)?.name === parameter.name && node(marker.property)?.name === '__esModule'
    && node(returned.consequent)?.name === parameter.name && alternate?.type === 'ObjectExpression'
    && properties.length === 1 && properties[0]?.type === 'ObjectProperty' && !properties[0].computed
    && node(properties[0].key)?.name === 'default' && node(properties[0].value)?.name === parameter.name
}

function isOriginalDefaultBinding(
  body: BundleNode[],
  line: number,
  column: number,
  kind: 'import' | 'local'
): boolean {
  const exported = body.find(statement => statement.type === 'ExportDefaultDeclaration')
  const value = node(exported?.declaration)
  if (kind === 'local' && value?.type === 'ObjectExpression') return containsPosition(value, line, column)
  if (value?.type !== 'Identifier') return false
  for (const statement of body) {
    if (kind === 'import' && statement.type === 'ImportDeclaration' && containsPosition(statement, line, column)
      && list(statement.specifiers).some(specifier => specifier.type === 'ImportDefaultSpecifier'
        && node(specifier.local)?.name === value.name)) return true
    if (kind === 'local' && statement.type === 'VariableDeclaration'
      && list(statement.declarations).some(declaration => node(declaration.id)?.name === value.name
        && node(declaration.init)?.type === 'ObjectExpression' && containsPosition(declaration, line, column))) return true
  }
  return false
}

function readMappedColumns(line: string): Set<number> {
  const mapped = new Set<number>()
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let column = 0
  for (const segment of line.split(',')) {
    if (!segment) continue
    let fields = 0
    let encodedColumn = 0
    let multiplier = 1
    let continuation = false
    for (const character of segment) {
      const digit = alphabet.indexOf(character)
      if (digit < 0) return new Set()
      if (fields === 0) {
        encodedColumn += (digit & 31) * multiplier
        if (!Number.isSafeInteger(encodedColumn)) return new Set()
        multiplier *= 32
      }
      continuation = (digit & 32) !== 0
      if (!continuation) fields++
    }
    if (continuation || (fields !== 1 && fields !== 4 && fields !== 5)) return new Set()
    // Generated columns are delta-encoded independently on each line.
    if (encodedColumn % 2 !== 0) return new Set()
    column += encodedColumn / 2
    if (!Number.isSafeInteger(column)) return new Set()
    if (fields === 1) mapped.delete(column)
    else mapped.add(column)
  }
  return mapped
}

function normalizedEntrySource(source: string): string {
  const body = babelParse(source, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program.body
  for (const statement of body) {
    // Babel may downlevel a module-scope const/let while preserving its static exports.
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (declaration?.type === 'VariableDeclaration') declaration.kind = 'var'
  }
  return JSON.stringify(body, (key, value) => (
    ['start', 'end', 'loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)
      ? undefined : value
  ))
}

function publicBundleExpression(body: BundleNode[]): BundleNode | undefined {
  if (body.some(statement => statement.type !== 'ExpressionStatement' && statement.type !== 'EmptyStatement')) return undefined
  for (const statement of body) {
    let expression = node(statement.expression)
    if (expression?.type === 'UnaryExpression') expression = node(expression.argument)
    if (expression?.type === 'AssignmentExpression' && isModuleExports(node(expression.left))) return node(expression.right)
    if (expression?.type !== 'CallExpression') continue
    const wrapper = node(expression.callee)
    if (wrapper?.type !== 'FunctionExpression') continue
    const parameters = list(wrapper.params)
    const arguments_ = list(expression.arguments)
    let factory: BundleNode | undefined
    let ambiguous = false
    visit(node(wrapper.body), value => {
      if (value.type !== 'AssignmentExpression' || !isModuleExports(node(value.left))) return
      const call = node(value.right)
      const callee = node(call?.callee)
      if (call?.type !== 'CallExpression' || callee?.type !== 'Identifier') { ambiguous = true; return }
      const index = parameters.findIndex(parameter => parameter.type === 'Identifier' && parameter.name === callee.name)
      const candidate = arguments_[index]
      if (candidate?.type !== 'FunctionExpression' || (factory && factory !== candidate)) { ambiguous = true; return }
      factory = candidate
    })
    if (ambiguous || !factory) continue
    const returns = list(node(factory.body)?.body).filter(statement => statement.type === 'ReturnStatement')
    if (returns.length === 1) return node(returns[0]?.argument)
  }
  return undefined
}

function webpackEntry(expression: BundleNode): BundleNode | undefined {
  // Some UMD wrappers expose only the entry module's default export.
  if (expression.type === 'MemberExpression') {
    const property = node(expression.property)
    if ((expression.computed ? property?.value : property?.name) !== 'default') return undefined
    const object = node(expression.object)
    return object && webpackEntry(object)
  }
  if (expression.type !== 'CallExpression') return undefined
  const bootstrap = node(expression.callee)
  const table = list(expression.arguments)[0]
  if (bootstrap?.type !== 'FunctionExpression' || !table || list(bootstrap.params).length !== 1) return undefined
  const statements = list(node(bootstrap.body)?.body)
  const returns = statements.filter(statement => statement.type === 'ReturnStatement')
  if (returns.length !== 1) return undefined
  let returned = node(returns[0]?.argument)
  if (returned?.type === 'SequenceExpression') returned = list(returned.expressions).at(-1)
  if (returned?.type !== 'CallExpression') return undefined
  const requireName = node(returned.callee)?.name
  const assignment = list(returned.arguments)[0]
  const target = node(assignment?.left)
  if (typeof requireName !== 'string' || assignment?.type !== 'AssignmentExpression' || assignment.operator !== '='
    || target?.type !== 'MemberExpression' || node(target.object)?.name !== requireName
    || (target.computed ? node(target.property)?.value : node(target.property)?.name) !== 's') return undefined
  const requireFunction = statements.find(statement => statement.type === 'FunctionDeclaration' && node(statement.id)?.name === requireName)
  if (!requireFunction || !canonicalModuleLoader(requireFunction, list(bootstrap.params)[0]!)) return undefined
  const key = node(assignment.right)?.value
  if (table.type === 'ArrayExpression' && typeof key === 'number' && Array.isArray(table.elements)) {
    const value = node(table.elements[key])
    return value?.type === 'FunctionExpression' ? value : undefined
  }
  if (table.type === 'ObjectExpression' && (typeof key === 'string' || typeof key === 'number')) {
    const property = list(table.properties).find(property => !property.computed
      && String(node(property.key)?.value ?? node(property.key)?.name) === String(key))
    const value = node(property?.value)
    return value?.type === 'FunctionExpression' ? value : undefined
  }
  return undefined
}

function canonicalModuleLoader(loader: BundleNode, table: BundleNode): boolean {
  const parameter = list(loader.params)[0]
  if (parameter?.type !== 'Identifier' || table.type !== 'Identifier') return false
  const statements = list(node(loader.body)?.body)
  const final = statements.at(-1)
  let returned = node(final?.argument)
  if (returned?.type === 'SequenceExpression') returned = list(returned.expressions).at(-1)
  if (final?.type !== 'ReturnStatement' || returned?.type !== 'MemberExpression'
    || node(returned.property)?.name !== 'exports' || node(returned.object)?.type !== 'Identifier') return false
  const moduleName = node(returned.object)?.name
  let calls = 0
  let unsupported = false
  visit(node(loader.body), value => {
    if (value.type === 'AssignmentExpression') {
      const left = node(value.left)
      if (left?.type === 'MemberExpression' && node(left.object)?.name === moduleName
        && (left.computed ? node(left.property)?.value : node(left.property)?.name) === 'exports') unsupported = true
    }
    if (value.type !== 'CallExpression') return
    const callee = node(value.callee)
    const member = node(callee?.object)
    const args = list(value.arguments)
    if (callee?.type !== 'MemberExpression' || node(callee.property)?.name !== 'call'
      || member?.type !== 'MemberExpression' || node(member.object)?.name !== table.name
      || node(member.property)?.name !== parameter.name
      || args.length !== 4 || args[1]?.name !== moduleName || args[3]?.name !== node(loader.id)?.name
      || node(args[0]?.object)?.name !== moduleName || node(args[0]?.property)?.name !== 'exports'
      || node(args[2]?.object)?.name !== moduleName || node(args[2]?.property)?.name !== 'exports') unsupported = true
    else calls++
  })
  return calls === 1 && !unsupported
}

function isModuleExports(value: BundleNode | undefined): boolean {
  return value?.type === 'MemberExpression' && node(value.object)?.name === 'module'
    && (value.computed ? node(value.property)?.value : node(value.property)?.name) === 'exports'
}

function visit(value: BundleNode | undefined, callback: (value: BundleNode) => void): void {
  if (!value || ['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression', 'ObjectMethod'].includes(value.type)) return
  callback(value)
  for (const [key, child] of Object.entries(value)) {
    if (key === 'loc' || key.includes('comment') || key.includes('Comment')) continue
    if (Array.isArray(child)) for (const value of list(child)) visit(value, callback)
    else visit(node(child), callback)
  }
}

function node(value: unknown): BundleNode | undefined {
  return value && typeof value === 'object' && typeof (value as BundleNode).type === 'string' ? value as BundleNode : undefined
}

function list(value: unknown): BundleNode[] {
  return Array.isArray(value) ? value.filter(item => node(item)) : []
}

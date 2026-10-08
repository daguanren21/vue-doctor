import tsParser from '@typescript-eslint/parser'
import { parse as parseSfcDescriptor, type SFCDescriptor } from '@vue/compiler-sfc'
import { parse as parseJavaScript, parseForESLint } from 'vue-eslint-parser'
import type {
  ParsedVueDocument,
  ParsedVueSource,
  SourceBlockKind,
  SourceBlockResult,
  SourceDocumentBlock
} from './types.js'


export function parseVueSource(source: string, file: string): ParsedVueSource {
  const { descriptor, errors } = parseSfcDescriptor(source, { filename: file, ignoreEmpty: false })
  const { failures: descriptorFailures, blocksByError } = collectDescriptorFailures(errors, source)
  const template = withDescriptorFailure(
    'template',
    parseTemplateBlock(descriptor.template?.content, descriptor.template?.lang, descriptor.template?.src),
    descriptorFailures
  )
  const { script, scriptSetup, scriptPrograms } = parseScripts(descriptor, source, file, descriptorFailures)


  const blocks = [template.result, script.result, scriptSetup.result]
  return {
    blocks,
    ...(template.ast
      ? {
          templateAst: remapTemplateLocations(template.ast, source, descriptor.template?.loc.start.offset ?? 0),
          templateSource: template.source
        }
      : {}),
    scriptPrograms,
    document: createParsedVueDocument(descriptor, errors, blocks, blocksByError)
  }
}

/** Application context needs script facts, not template expressions or their remapped AST. */
export function parseVueScriptContext(source: string, file: string) {
  const { descriptor, errors } = parseSfcDescriptor(source, { filename: file, ignoreEmpty: false, sourceMap: false })
  const { failures } = collectDescriptorFailures(errors, source)
  const { script, scriptSetup, scriptPrograms } = parseScripts(descriptor, source, file, failures)
  return {
    scriptPrograms,
    errors: [script.result, scriptSetup.result]
      .filter(block => block.status === 'failed')
      .map(block => `${block.kind}: ${block.message ?? 'parse failed'}`)
  }
}

function parseScripts(
  descriptor: SFCDescriptor,
  source: string,
  file: string,
  failures: Map<SourceBlockKind, unknown>
) {
  const script = withDescriptorFailure(
    'script',
    parseScriptBlock('script', descriptor.script?.content, descriptor.script?.lang, file, descriptor.script?.src),
    failures
  )
  const scriptSetup = withDescriptorFailure(
    'script-setup',
    parseScriptBlock('script-setup', descriptor.scriptSetup?.content, descriptor.scriptSetup?.lang, file, descriptor.scriptSetup?.src),
    failures
  )
  const scriptPrograms = [
    script.ast ? remapScriptLocations(script.ast, source, descriptor.script?.loc.start.offset ?? 0) : undefined,
    scriptSetup.ast ? remapScriptLocations(scriptSetup.ast, source, descriptor.scriptSetup?.loc.start.offset ?? 0) : undefined
  ].filter(ast => ast !== undefined)
  return { script, scriptSetup, scriptPrograms }
}

function createParsedVueDocument(
  descriptor: SFCDescriptor,
  descriptorErrors: Array<unknown>,
  parsedBlocks: SourceBlockResult[],
  blocksByError: ReadonlyMap<unknown, SourceBlockKind>
): ParsedVueDocument {
  const blocks: SourceDocumentBlock[] = []
  const errors = descriptorErrors.map(sourceError)
  for (const block of [
    descriptor.template,
    descriptor.script,
    descriptor.scriptSetup,
    ...descriptor.styles,
    ...descriptor.customBlocks
  ]) {
    if (!block) continue
    const kind: SourceDocumentBlock['kind'] = block.type === 'template'
      || block.type === 'script'
      || block.type === 'style'
      ? block.type
      : 'document'
    const attributes: Record<string, string | boolean> = {}
    for (const [name, value] of Object.entries(block.attrs)) {
      if (value !== undefined) attributes[name] = value
    }
    blocks.push({
      kind,
      lang: block.lang ?? (kind === 'template'
        ? 'html'
        : kind === 'script'
          ? 'js'
          : kind === 'style'
            ? 'css'
            : block.type),
      content: block.content,
      start: block.loc.start.offset,
      end: block.loc.end.offset,
      loc: { line: block.loc.start.line, column: block.loc.start.column },
      attributes
    })
    if (block.src) {
      errors.push({
        message: `External ${block.type} source is unavailable: ${block.src}`,
        line: block.loc.start.line,
        column: block.loc.start.column
      })
    }
  }
  blocks.sort((left, right) => left.start - right.start)
  for (const block of parsedBlocks) {
    if (block.status !== 'failed' || !block.message) continue
    if (errors.some((error) => error.message === block.message)) continue
    const sourceBlock = block.kind === 'template'
      ? descriptor.template
      : block.kind === 'script'
        ? descriptor.script
        : descriptor.scriptSetup
    errors.push({
      message: block.message,
      ...(sourceBlock ? {
        line: sourceBlock.loc.start.line,
        column: sourceBlock.loc.start.column
      } : {})
    })
  }
  const structuralFailures = descriptorErrors.map(error => {
    const block = blocksByError.get(error)
    return { ...sourceError(error), ...(block ? { block } : {}) }
  })
  return { blocks, errors, ...(structuralFailures.length ? { structuralFailures } : {}) }
}

function sourceError(error: unknown): ParsedVueDocument['errors'][number] {
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

function collectDescriptorFailures(errors: Array<unknown>, originalSource: string) {
  const failures = new Map<SourceBlockKind, unknown>()
  const blocksByError = new Map<unknown, SourceBlockKind>()
  for (const error of errors) {
    const typedError = error as { loc?: { source?: string; start?: { offset?: number } } } | undefined
    const source = typedError?.loc?.source || getErrorMessage(error)
    const match = source.match(/<\s*(template|script)(\s+setup)?\b/i) ?? inferBlockFromOffset(originalSource, typedError?.loc?.start?.offset)
    if (!match) {
      continue
    }
    const kind = match[1]?.toLowerCase() === 'template' ? 'template' : match[2] ? 'script-setup' : 'script'
    failures.set(kind, error)
    blocksByError.set(error, kind)
  }
  return { failures, blocksByError }
}

function inferBlockFromOffset(source: string, offset: number | undefined) {
  if (offset === undefined) return undefined
  const tags = [...source.matchAll(/<\s*(template|script)(?:\s+setup)?\b/gi)]
    .map((match) => ({ match, offset: match.index ?? 0 }))
  const nearest = tags.sort((left, right) => Math.abs(left.offset - offset) - Math.abs(right.offset - offset))[0]
  if (!nearest) return undefined
  const match = nearest.match
  return [match[0], match[1], match[0].includes('setup') ? 'setup' : undefined] as RegExpMatchArray
}

function withDescriptorFailure<T extends { result: SourceBlockResult; ast?: unknown }>(
  kind: SourceBlockKind,
  parsed: T,
  failures: Map<SourceBlockKind, unknown>
): T {
  const failure = failures.get(kind)
  if (failure === undefined) {
    return parsed
  }
  const { ast: _ast, ...withoutAst } = parsed
  return {
    ...withoutAst,
    result: blockResult(kind, 'failed', parsed.result.lang, failure)
  } as T
}

function parseTemplateBlock(content: string | undefined, lang: string | undefined, src?: string) {
  if (src) return { result: blockResult('template', 'failed', lang, `External template source is unavailable: ${src}`) }
  if (content === undefined) {
    return { result: blockResult('template', 'absent') }
  }

  if (lang && !['html', 'vue'].includes(lang)) {
    return { result: blockResult('template', 'failed', lang, `Unsupported Vue template language: ${lang}`) }
  }

  try {
    const source = `<template>${content}</template>`
    const parsed = parseForESLint(source, {
      sourceType: 'module',
      ecmaVersion: 'latest',
      ecmaFeatures: { jsx: true },
      parser: {
        js: 'espree',
        jsx: 'espree',
        ts: tsParser,
        tsx: tsParser,
        '<template>': tsParser
      }
    })
    const templateErrors = ((parsed.ast.templateBody as { errors?: unknown[] } | undefined)?.errors ?? [])
      .filter((error) => !isValidVueRecovery(error, source))
    if (templateErrors.length > 0) {
      throw templateErrors[0]
    }
    return {
      result: blockResult('template', 'available', lang),
      ast: parsed.ast,
      source
    }
  } catch (error) {
    return { result: blockResult('template', 'failed', lang, error) }
  }
}

function isValidVueRecovery(error: unknown, source: string) {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  if (error.code === 'non-void-html-element-start-tag-with-trailing-solidus') return true
  // Vue treats a literal "<" as text; malformed "</" instead recovers as a bogus comment.
  return error.code === 'invalid-first-character-of-tag-name'
    && 'index' in error && typeof error.index === 'number'
    && source[error.index - 1] === '<'
}

function parseScriptBlock(
  kind: Exclude<SourceBlockKind, 'template'>,
  content: string | undefined,
  lang: string | undefined,
  file: string,
  src?: string
) {
  if (src) return { result: blockResult(kind, 'failed', lang, `External script source is unavailable: ${src}`) }
  if (content === undefined) {
    return { result: blockResult(kind, 'absent') }
  }

  if (lang && !['js', 'jsx', 'ts', 'tsx'].includes(lang)) {
    return { result: blockResult(kind, 'failed', lang, `Unsupported Vue script language: ${lang}`) }
  }

  try {
    const ast = lang === 'ts' || lang === 'tsx'
      ? tsParser.parse(content, {
          sourceType: 'module',
          ecmaVersion: 'latest',
          filePath: scriptFilePath(file, lang),
          ecmaFeatures: { jsx: lang === 'tsx' }
        })
      : parseJavaScriptBlock(content)
    return {
      result: blockResult(kind, 'available', lang),
      ast
    }
  } catch (error) {
    return { result: blockResult(kind, 'failed', lang, error) }
  }
}

function parseJavaScriptBlock(content: string) {
  return parseJavaScript(content, {
    sourceType: 'module',
    ecmaVersion: 'latest',
    ecmaFeatures: { jsx: true }
  })
}

function createLocationResolver(source: string) {
  const lineStarts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1)
  }
  return (offset: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >>> 1
      if (lineStarts[middle]! <= offset) low = middle
      else high = middle - 1
    }
    return { line: low + 1, column: offset - lineStarts[low]! }
  }
}

function remapTemplateLocations(ast: unknown, originalSource: string, contentOffset: number) {
  const syntheticPrefixLength = '<template>'.length
  const toLocation = createLocationResolver(originalSource)
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = value as { range?: [number, number]; loc?: { start: { line: number; column: number }; end: { line: number; column: number } }; parent?: unknown }
    if (node.range && node.loc) {
      const startOffset = contentOffset + Math.max(0, node.range[0] - syntheticPrefixLength)
      const endOffset = contentOffset + Math.max(0, node.range[1] - syntheticPrefixLength)
      node.loc = { start: toLocation(startOffset), end: toLocation(endOffset) }
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'parent') visit(child)
  }
  visit(ast)
  return ast
}

function remapScriptLocations(ast: unknown, originalSource: string, contentOffset: number) {
  const toLocation = createLocationResolver(originalSource)
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = value as {
      range?: [number, number]
      loc?: {
        start: { line: number; column: number }
        end: { line: number; column: number }
      }
      parent?: unknown
    }
    if (node.range && node.loc) {
      const startOffset = contentOffset + node.range[0]
      const endOffset = contentOffset + node.range[1]
      node.range = [startOffset, endOffset]
      node.loc = { start: toLocation(startOffset), end: toLocation(endOffset) }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'parent') visit(child)
    }
  }
  visit(ast)
  return ast
}

function scriptFilePath(file: string, lang: string | undefined) {
  const extension = lang === 'tsx' ? '.tsx' : lang === 'jsx' ? '.jsx' : lang === 'ts' ? '.ts' : '.js'
  return file.replace(/\.vue$/i, extension)
}

function blockResult(
  kind: SourceBlockKind,
  status: SourceBlockResult['status'],
  lang?: string,
  error?: unknown
): SourceBlockResult {
  return {
    kind,
    status,
    ...(lang ? { lang } : {}),
    ...(error === undefined ? {} : { message: getErrorMessage(error) })
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

import tsParser from '@typescript-eslint/parser'
import { parse as parseSfcDescriptor } from '@vue/compiler-sfc'
import { parseForESLint } from 'vue-eslint-parser'
import { extname } from 'node:path'

const DIRECTIVE_PREFIX = 'vue-doctor-disable-'
const DIRECTIVE_PATTERN = /^(vue-doctor-disable-(line|next-line))\s+(\S+)\s+--\s+(.+?)\s*$/
const SCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'])
const HTML_EXTENSIONS = new Set(['.html', '.htm'])
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.stylus', '.pcss', '.postcss'])

export interface SourceSuppressionPosition {
  /** One-based source line. */
  line: number
  /** One-based source column. */
  column: number
}

export interface SourceSuppressionLocation {
  start: SourceSuppressionPosition
  /** Exclusive one-based end position. */
  end: SourceSuppressionPosition
}

export interface SourceSuppressionDirective {
  file: string
  text: string
  location: SourceSuppressionLocation
  status: 'valid' | 'invalid'
  mode?: 'line' | 'next-line'
  targetLine?: number
  ruleCode?: string
  reason?: string
  message?: string
}

export interface SourceSuppressionIssue {
  message: string
  line?: number
  column?: number
}

export interface SourceSuppressionScan {
  file: string
  /** False means no directive from this scan is safe to apply. */
  complete: boolean
  directives: SourceSuppressionDirective[]
  issues: SourceSuppressionIssue[]
}

type LexicalComment = {
  value: string
  openerLength: number
  range: [number, number]
  loc: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
}

/** Extract suppression directives only from parser-confirmed comments. */
export function extractDoctorSuppressions(file: string, source: string): SourceSuppressionScan {
  if (!source.includes(DIRECTIVE_PREFIX)) {
    return { file, complete: true, directives: [], issues: [] }
  }

  const extension = extname(file).toLowerCase()
  if (extension === '.vue') return extractVueSuppressions(file, source)
  if (SCRIPT_EXTENSIONS.has(extension)) return extractScriptSuppressions(file, source)
  if (HTML_EXTENSIONS.has(extension)) return extractHtmlSuppressions(file, source)
  if (STYLE_EXTENSIONS.has(extension)) return extractStandaloneStyleSuppressions(file, source, extension)

  const message = `Suppression directives are unsupported in ${extension || 'extensionless'} source files.`
  return failedScan(file, source, message)
}

function extractHtmlSuppressions(file: string, source: string): SourceSuppressionScan {
  const prefix = '<template>\n'
  try {
    const parsed = parseForESLint(`${prefix}${sanitizeHtmlForTemplate(source)}\n</template>`, {
      sourceType: 'module',
      ecmaVersion: 'latest',
      parser: { js: 'espree', jsx: 'espree', ts: tsParser, tsx: tsParser, '<template>': tsParser }
    }) as unknown as { ast: { templateBody?: { comments?: ParserComment[]; errors?: unknown[] } } }
    const errors = (parsed.ast.templateBody?.errors ?? []).filter((error) => !isIgnorableTemplateError(error))
    if (errors.length > 0) return failedScan(file, source, parseFailureMessage(errors[0]))
    const comments = (parsed.ast.templateBody?.comments ?? []).map((comment) => ({
      ...toLexicalComment(comment),
      range: [comment.range[0] - prefix.length, comment.range[1] - prefix.length] as [number, number],
      loc: {
        start: { line: comment.loc.start.line - 1, column: comment.loc.start.column },
        end: { line: comment.loc.end.line - 1, column: comment.loc.end.column }
      }
    }))
    return completeScan(file, comments)
  } catch (error) {
    return failedScan(file, source, parseFailureMessage(error))
  }
}

function sanitizeHtmlForTemplate(source: string) {
  return source.replace(/<!doctype\b[^>]*>|<\?xml\b[^?]*(?:\?>|$)/gi, (declaration) => (
    declaration.replace(/[^\r\n]/g, ' ')
  ))
}

function extractStandaloneStyleSuppressions(file: string, source: string, extension: string): SourceSuppressionScan {
  const result = extractStyleComments(source, 0, source.length, extension !== '.css')
  const scan = completeScan(file, result.comments)
  if (result.complete) return scan
  return {
    ...scan,
    complete: false,
    directives: scan.directives.map((directive) => ({
      ...directive,
      status: 'invalid',
      message: 'Suppression ignored because the stylesheet could not be parsed completely.'
    })),
    issues: result.issues
  }
}

function extractScriptSuppressions(file: string, source: string): SourceSuppressionScan {
  try {
    const ast = tsParser.parse(source, {
      sourceType: 'module',
      ecmaVersion: 'latest',
      filePath: file,
      ecmaFeatures: { jsx: ['.jsx', '.tsx'].includes(extname(file).toLowerCase()) }
    }) as unknown as { comments?: ParserComment[] }
    return completeScan(file, (ast.comments ?? []).map(toLexicalComment))
  } catch (error) {
    return failedScan(file, source, parseFailureMessage(error))
  }
}

function extractVueSuppressions(file: string, source: string): SourceSuppressionScan {
  try {
    const parsedSfc = parseSfcDescriptor(source, { filename: file, ignoreEmpty: false })
    if (parsedSfc.errors.length > 0) {
      return failedScan(file, source, parseFailureMessage(parsedSfc.errors[0]))
    }

    const parsed = parseForESLint(source, {
      sourceType: 'module',
      ecmaVersion: 'latest',
      parser: {
        js: 'espree',
        jsx: 'espree',
        ts: tsParser,
        tsx: tsParser,
        '<template>': tsParser
      }
    }) as unknown as {
      ast: {
        comments?: ParserComment[]
        templateBody?: { comments?: ParserComment[]; errors?: unknown[] }
      }
    }
    const templateErrors = (parsed.ast.templateBody?.errors ?? [])
      .filter((error) => !isIgnorableTemplateError(error))
    if (templateErrors.length > 0) {
      return failedScan(file, source, parseFailureMessage(templateErrors[0]))
    }

    const comments = [
      ...(parsed.ast.comments ?? []).map(toLexicalComment),
      ...(parsed.ast.templateBody?.comments ?? []).map(toLexicalComment)
    ]
    let complete = true
    const issues: SourceSuppressionIssue[] = []
    for (const style of parsedSfc.descriptor.styles) {
      // The src file is a separate source target; there is no inline style text to classify here.
      if (style.src) continue
      const styleResult = extractStyleComments(
        source,
        style.loc.start.offset,
        style.loc.end.offset,
        Boolean(style.lang && style.lang !== 'css')
      )
      comments.push(...styleResult.comments)
      if (!styleResult.complete) {
        complete = false
        issues.push(...styleResult.issues)
      }
    }

    const result = completeScan(file, deduplicateComments(comments))
    if (complete) return result
    return {
      ...result,
      complete: false,
      directives: result.directives.map((directive) => ({
        ...directive,
        status: 'invalid',
        message: 'Suppression ignored because the source could not be parsed completely.'
      })),
      issues
    }
  } catch (error) {
    return failedScan(file, source, parseFailureMessage(error))
  }
}

type ParserComment = {
  type?: string
  value: string
  range: [number, number]
  loc: {
    start: { line: number; column: number }
    end: { line: number; column: number }
  }
}

function toLexicalComment(comment: ParserComment): LexicalComment {
  return {
    value: comment.value,
    openerLength: comment.type === 'HTMLComment' ? 4 : 2,
    range: comment.range,
    loc: comment.loc
  }
}

function completeScan(file: string, comments: LexicalComment[]): SourceSuppressionScan {
  const directives = comments
    .flatMap((comment) => directivesFromComment(file, comment))
    .sort(compareDirectives)
  return { file, complete: true, directives, issues: [] }
}

function directivesFromComment(file: string, comment: LexicalComment): SourceSuppressionDirective[] {
  const lines = comment.value.split(/\r?\n/)
  const directives: SourceSuppressionDirective[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const tokenIndex = line.indexOf(DIRECTIVE_PREFIX)
    if (tokenIndex < 0) continue

    const text = line.slice(tokenIndex).trimEnd()
    const sourceLine = comment.loc.start.line + index
    const contentColumn = index === 0
      ? comment.loc.start.column + comment.openerLength + 1
      : 1
    const startColumn = contentColumn + tokenIndex
    const directive = /^\s*(?:\*\s*)?$/.test(line.slice(0, tokenIndex))
      ? parseDirective(file, text, sourceLine, startColumn)
      : {
          ...parseDirective(file, text, sourceLine, startColumn),
          status: 'invalid' as const,
          message: 'A suppression directive must begin the comment line.'
        }
    directives.push(directive.mode === 'next-line' && directive.status === 'valid'
      ? { ...directive, targetLine: comment.loc.end.line + 1 }
      : directive)
  }
  return directives
}

function parseDirective(
  file: string,
  text: string,
  line: number,
  column: number
): SourceSuppressionDirective {
  const location = {
    start: { line, column },
    end: { line, column: column + text.length }
  }
  const match = DIRECTIVE_PATTERN.exec(text)
  if (!match) {
    return {
      file,
      text,
      location,
      status: 'invalid',
      message: 'Expected "vue-doctor-disable-line <rule-code> -- <reason>" or the next-line form.'
    }
  }

  const mode = match[2] as 'line' | 'next-line'
  const ruleCode = match[3]!
  const reason = match[4]!.trim()
  if (!reason) {
    return { file, text, location, status: 'invalid', mode, ruleCode, message: 'A non-empty suppression reason is required.' }
  }
  return {
    file,
    text,
    location,
    status: 'valid',
    mode,
    targetLine: mode === 'next-line' ? line + 1 : line,
    ruleCode,
    reason
  }
}

function failedScan(file: string, source: string, message: string): SourceSuppressionScan {
  const directives = source.split(/\r?\n/).flatMap((lineText, index) => {
    const tokenIndex = lineText.indexOf(DIRECTIVE_PREFIX)
    if (tokenIndex < 0) return []
    const text = lineText.slice(tokenIndex).trimEnd()
    const directive = parseDirective(file, text, index + 1, tokenIndex + 1)
    return [{
      ...directive,
      status: 'invalid' as const,
      message: `Suppression ignored because comments could not be parsed reliably: ${message}`
    }]
  })
  return {
    file,
    complete: false,
    directives: directives.sort(compareDirectives),
    issues: [{ message }]
  }
}

function extractStyleComments(source: string, start: number, end: number, allowLineComments = false): {
  complete: boolean
  comments: LexicalComment[]
  issues: SourceSuppressionIssue[]
} {
  const comments: LexicalComment[] = []
  const issues: SourceSuppressionIssue[] = []
  let quote: '"' | "'" | undefined
  let escaped = false
  let index = start
  while (index < end) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = undefined
      index += 1
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      index += 1
      continue
    }
    if (allowLineComments && character === '/' && source[index + 1] === '/') {
      const lineStart = source.lastIndexOf('\n', index - 1) + 1
      const previous = index > lineStart ? source[index - 1] : undefined
      // Sass-family line comments may follow declarations. Requiring a lexical
      // boundary avoids treating http:// and url(//...) as comments.
      if (source.slice(lineStart, index).trim() === ''
        || (previous !== undefined && /[\s;{}]/.test(previous))) {
        const newline = source.indexOf('\n', index + 2)
        const commentEnd = newline < 0 || newline > end ? end : newline
        comments.push(commentFromOffsets(source, index, commentEnd, 2, 0))
        index = commentEnd
        continue
      }
    }
    if (character !== '/' || source[index + 1] !== '*') {
      index += 1
      continue
    }

    const commentStart = index
    const close = source.indexOf('*/', index + 2)
    const commentEnd = close >= 0 && close < end ? close + 2 : end
    comments.push(commentFromOffsets(source, commentStart, commentEnd, 2))
    if (close < 0 || close >= end) {
      const position = positionAt(source, commentStart)
      issues.push({ message: 'Unterminated style comment.', ...position })
      return { complete: false, comments, issues }
    }
    index = commentEnd
  }
  if (quote) {
    const position = positionAt(source, Math.max(start, end - 1))
    issues.push({ message: 'Unterminated style string.', ...position })
    return { complete: false, comments, issues }
  }
  return { complete: true, comments, issues }
}

function commentFromOffsets(
  source: string,
  start: number,
  end: number,
  openerLength: number,
  closerLength = 2
): LexicalComment {
  return {
    value: source.slice(start + openerLength, Math.max(start + openerLength, end - closerLength)),
    openerLength,
    range: [start, end],
    loc: { start: zeroBasedPositionAt(source, start), end: zeroBasedPositionAt(source, end) }
  }
}

function zeroBasedPositionAt(source: string, offset: number) {
  const position = positionAt(source, offset)
  return { line: position.line, column: position.column - 1 }
}

function positionAt(source: string, offset: number): SourceSuppressionPosition {
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

function deduplicateComments(comments: LexicalComment[]) {
  const unique = new Map<string, LexicalComment>()
  for (const comment of comments) unique.set(`${comment.range[0]}:${comment.range[1]}`, comment)
  return [...unique.values()].sort((left, right) => left.range[0] - right.range[0])
}

function compareDirectives(left: SourceSuppressionDirective, right: SourceSuppressionDirective) {
  return left.location.start.line - right.location.start.line
    || left.location.start.column - right.location.start.column
    || left.text.localeCompare(right.text)
}

function parseFailureMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isIgnorableTemplateError(error: unknown) {
  return (error as { code?: string } | undefined)?.code === 'non-void-html-element-start-tag-with-trailing-solidus'
}

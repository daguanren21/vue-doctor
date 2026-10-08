import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import tsParser from '@typescript-eslint/parser'
import { discoverSourceFiles } from './files.js'
import { parseVueSource } from './sfc.js'
import type {
  ParsedVueSource,
  ReadSourceDocumentsOptions,
  SourceDocument
} from './types.js'

/** Read only the authoritative project targets; external SFC sources are reported, never followed. */
export async function readSourceDocuments(
  root: string,
  options: ReadSourceDocumentsOptions = {}
): Promise<SourceDocument[]> {
  const normalizedRoot = resolve(root)
  const files = options.targetFiles?.files ?? (await discoverSourceFiles(
    normalizedRoot,
    options.scope,
    options.extensions,
    options.files
  )).files
  const documents: SourceDocument[] = new Array(files.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
    while (nextIndex < files.length) {
      const index = nextIndex++
      const file = files[index]
      if (file !== undefined) documents[index] = await readDocument(file, options)
    }
  }))
  return documents
}

/** Build one document from text already read by a Doctor run. */
export function createSourceDocument(
  file: string,
  text: string,
  parsedVueSource?: ParsedVueSource
): SourceDocument {
  const language = extname(file).slice(1)
  if (language === 'vue') {
    const parsed = parsedVueSource ?? parseVueSource(text, file)
    return {
      file,
      text,
      language,
      blocks: structuredClone(parsed.document.blocks),
      errors: structuredClone(parsed.document.errors),
      ...(parsed.document.structuralFailures ? { structuralFailures: structuredClone(parsed.document.structuralFailures) } : {})
    }
  }
  const document: SourceDocument = {
    file,
    text,
    language,
    blocks: [{
      kind: 'document',
      lang: language,
      content: text,
      start: 0,
      end: text.length,
      loc: { line: 1, column: 1 },
      attributes: {}
    }],
    errors: []
  }
  if (['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'mts', 'cts'].includes(language)) {
    try {
      tsParser.parse(text, {
        filePath: file,
        sourceType: 'module',
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: ['jsx', 'tsx'].includes(language) }
      })
    } catch (error) {
      document.errors.push(sourceError(error))
    }
  }
  return document
}

async function readDocument(
  file: string,
  options: ReadSourceDocumentsOptions
): Promise<SourceDocument> {
  try {
    if (options.readFailures?.has(file)) throw options.readFailures.get(file)
    if (options.sourceTexts && !options.sourceTexts.has(file)) {
      throw new Error('Source text is missing from the authoritative snapshot.')
    }
    const supplied = options.sourceTexts?.get(file)
    const decoded = supplied === undefined
      ? decodeSource(await readFile(file))
      : { text: supplied, invalidEncoding: options.invalidEncodingFiles?.has(file) === true }
    const prepared = options.preparedDocuments?.get(file)
    const document = prepared
      ? { ...structuredClone(prepared), text: decoded.text }
      : createSourceDocument(file, decoded.text, options.parsedVueSources?.get(file))
    if (decoded.invalidEncoding) {
      document.textUnavailable = 'invalid-encoding'
      document.errors.unshift({ message: 'Invalid UTF-8 source encoding' })
    }
    return document
  } catch (error) {
    return {
      file,
      text: '',
      textUnavailable: 'read-failed',
      language: extname(file).slice(1),
      blocks: [],
      errors: [sourceError(error)]
    }
  }
}

function decodeSource(bytes: Uint8Array): { text: string; invalidEncoding: boolean } {
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      invalidEncoding: false
    }
  } catch {
    return { text: Buffer.from(bytes).toString('utf8'), invalidEncoding: true }
  }
}

function sourceError(error: unknown): SourceDocument['errors'][number] {
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

import type { EvidenceLocation } from '@vue-doctor/core'
import type { SourceDocument, SourceDocumentBlock } from '@vue-doctor/source'
import type {
  RuleSourceLocation,
  RuleSourcePosition,
  RuleSourceRange
} from './types.js'

interface OffsetNode {
  start?: number | null
  end?: number | null
}

export function sourceRange(value: OffsetNode | RuleSourceRange, block: Readonly<SourceDocumentBlock>): RuleSourceRange {
  const start = value.start
  const end = value.end
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === null || end === null
    || start === undefined || end === undefined || start < 0 || end < start || end > block.content.length) {
    throw new Error('Rule locations must use valid block-relative UTF-16 start/end offsets.')
  }
  return { start, end }
}

export function sourceLocation(
  document: Readonly<SourceDocument>,
  block: Readonly<SourceDocumentBlock>,
  value: OffsetNode | RuleSourceRange
): RuleSourceLocation {
  const range = sourceRange(value, block)
  const start = block.start + range.start
  const end = block.start + range.end
  return {
    file: document.file,
    start: positionAt(document.text, start),
    end: positionAt(document.text, end)
  }
}

export function fillEvidenceLocation(
  evidence: EvidenceLocation,
  location: RuleSourceLocation
): EvidenceLocation {
  if (evidence.file !== undefined && evidence.file !== location.file) return { ...evidence }
  return {
    ...evidence,
    file: evidence.file ?? location.file,
    line: evidence.line ?? location.start.line,
    column: evidence.column ?? location.start.column,
    endLine: evidence.endLine ?? location.end.line,
    endColumn: evidence.endColumn ?? location.end.column
  }
}

function positionAt(text: string, requestedOffset: number): RuleSourcePosition {
  const offset = Math.max(0, Math.min(text.length, requestedOffset))
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1
      lineStart = index + 1
    }
  }
  return { offset, line, column: offset - lineStart + 1 }
}


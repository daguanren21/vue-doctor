import type { Diagnostic, EvidenceLocation } from '@vue-doctor/core'
import { primarySourceLocation } from './evidence'

export interface SnippetLine {
  number: number | string
  text: string
  kind?: 'context' | 'hit' | 'suggested'
}

export interface SnippetPayload {
  file: string
  line: number
  column?: number
  lines: SnippetLine[]
}

export function primaryHitLocation(item: Diagnostic): EvidenceLocation | undefined {
  return primarySourceLocation(item)
}

/** Fallback when host cannot serve source text yet. */
export function syntheticSnippet(item: Diagnostic): SnippetPayload | null {
  const hit = primaryHitLocation(item)
  if (!hit?.file || hit.line === undefined) return null

  const line = hit.line
  const hitText = hit.message?.trim()
    || extractInlineCode(item.message)
    || item.message

  return {
    file: hit.file,
    line,
    column: hit.column,
    lines: [
      { number: Math.max(1, line - 1), text: '…', kind: 'context' },
      { number: line, text: hitText, kind: 'hit' },
      { number: line + 1, text: '…', kind: 'context' }
    ]
  }
}

function extractInlineCode(message: string): string | undefined {
  const match = message.match(/`([^`]+)`/)
  return match?.[1]
}

export function snippetEndpointFromOpen(openEndpoint: string): string {
  // api/open -> api/snippet ; /vue-doctor/api/open -> /vue-doctor/api/snippet
  return openEndpoint.replace(/\/open\/?$/, '/snippet')
}

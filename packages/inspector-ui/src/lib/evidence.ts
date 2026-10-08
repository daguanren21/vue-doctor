import type {
  ComponentLibraryCoverage,
  Diagnostic,
  DoctorReport,
  EvidenceLocation
} from '@vue-doctor/core'
import { packageNameFromDiagnostic } from './categories'

export type EvidenceTab = 'evidence' | 'fix' | 'rule'

export function formatLocation(file?: string, line?: number, column?: number): string {
  if (!file) return ''
  if (line === undefined) return file
  if (column === undefined) return `${file}:${line}`
  return `${file}:${line}:${column}`
}

export function relativePath(file: string | undefined, root: string | undefined): string {
  if (!file) return ''
  const normalizedRoot = root?.replaceAll('\\', '/')
  const normalized = file.replaceAll('\\', '/')
  if (normalizedRoot === normalized) return ''
  return normalizedRoot && normalized.startsWith(`${normalizedRoot}/`)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized
}

export function primarySourceLocation(item: Diagnostic): EvidenceLocation | undefined {
  if (item.primaryLocation) {
    const location = item.primaryLocation
    const canonicalFile = location.file.replaceAll('\\', '/')
    const diagnosticFile = item.file?.replaceAll('\\', '/')
    const representsDiagnosticFile = diagnosticFile === canonicalFile
      || (!canonicalFile.startsWith('/') && !/^[A-Za-z]:\//.test(canonicalFile)
        && diagnosticFile?.endsWith(`/${canonicalFile}`))
    const sameFile = (entry: EvidenceLocation) => {
      const file = entry.file?.replaceAll('\\', '/')
      return file === canonicalFile || (representsDiagnosticFile && file === diagnosticFile)
    }
    const evidence = item.evidence.find(entry => sameFile(entry)
      && entry.line === location.start?.line)
      ?? item.evidence.find(sameFile)
    return {
      kind: evidence?.kind ?? 'source',
      ...(evidence?.message ? { message: evidence.message } : {}),
      ...(evidence?.git ? { git: evidence.git } : {}),
      file: location.file,
      ...(location.start ? { line: location.start.line, column: location.start.column } : {}),
      ...(location.end ? { endLine: location.end.line, endColumn: location.end.column } : {})
    }
  }
  if (item.file) {
    const fromFile = item.evidence.find((entry) => (
      entry.file === item.file && entry.line !== undefined
    )) ?? item.evidence.find((entry) => entry.file === item.file)
    return fromFile
      ? { ...fromFile, file: item.file }
      : { kind: 'source', file: item.file }
  }
  return item.evidence.find((entry) => entry.file)
}

export function packageLabelFromDiagnostic(item: Diagnostic): string | null {
  const fromMessage = packageNameFromDiagnostic(item)
  if (fromMessage) return fromMessage
  const contract = item.evidence.find((entry) => entry.kind === 'component-contract' && entry.file)
  if (!contract?.file) return null
  const match = contract.file.replaceAll('\\', '/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
  return match?.[1] ?? null
}

export function packageVersionFromMessage(item: Diagnostic, packageName: string | null): string | undefined {
  if (!packageName) return undefined
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return item.message.match(new RegExp(`${escaped}@([^\\s]+)`))?.[1]
}

export function findLibraryCoverage(
  report: DoctorReport | null | undefined,
  packageName: string | null
): ComponentLibraryCoverage | undefined {
  if (!report || !packageName) return undefined
  return report.coverage.componentLibraries.find((library) => {
    const identity = library.package
    return identity.dependencyName === packageName
      || identity.canonicalName === packageName
  })
}

export function severityBadgeClass(severity: Diagnostic['severity']): string {
  if (severity === 'error') return 'bg-red-950 text-red-200 border-red-900/60'
  if (severity === 'warning') return 'bg-amber-950 text-amber-200 border-amber-900/60'
  return 'bg-sky-950 text-sky-200 border-sky-900/60'
}

export function confidenceDotClass(confidence: Diagnostic['confidence'] | undefined): string {
  if (confidence === 'high') return 'bg-[var(--doctor-accent)]'
  if (confidence === 'medium') return 'bg-amber-400'
  return 'bg-[var(--doctor-muted)]'
}

export function knowledgeLabel(value: string): string {
  if (value === 'known') return 'known'
  if (value === 'partial') return 'partial'
  return 'unknown'
}

export function knowledgeClass(value: string): string {
  if (value === 'known') return 'text-[var(--doctor-accent)]'
  if (value === 'partial') return 'text-amber-300'
  return 'text-[var(--doctor-muted)]'
}

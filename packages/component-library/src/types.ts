import type { PackageResolution } from '@vue-doctor/core'

export interface ComponentLibraryEvidenceOptions {
  package: PackageResolution
  observedSubpaths?: string[]
  /** Parse package runtime sources in addition to metadata and declarations. */
  runtime?: boolean
  /** Persist extracted contracts for versioned installed packages. */
  cache?: boolean
  cacheDirectory?: string
}

export interface EvidenceFile {
  path: string
  relativePath: string
  source: 'package-json' | 'exports' | 'discovered'
  entry?: string
}

export interface ArtifactIssue {
  code: 'public-entry-unresolved'
  entry: string
  message: string
}

export interface ComponentLibraryArtifacts {
  types?: EvidenceFile
  declarationEntries: EvidenceFile[]
  webTypes?: EvidenceFile
  veturTags?: EvidenceFile
  veturAttributes?: EvidenceFile
  runtimeEntries: EvidenceFile[]
  issues: ArtifactIssue[]
}

export interface ComponentLibraryEvidence {
  package: PackageResolution
  artifacts: ComponentLibraryArtifacts
  runtime?: boolean
  cache?: boolean
  cacheDirectory?: string
}

export interface FindPackageTextEvidenceOptions extends ComponentLibraryEvidenceOptions {
  query: string | RegExp
}

export interface PackageTextEvidence {
  kind: 'package-text-match'
  packageName: string
  path: string
  relativePath: string
  line: number
  column: number
  text: string
}

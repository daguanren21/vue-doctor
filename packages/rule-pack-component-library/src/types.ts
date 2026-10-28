import type {
  ComponentContract,
  ComponentContractMap,
  ComponentLibraryEvidence
} from '@daguanren21/vue-doctor-component-library'
import type { Diagnostic, SkippedCheck } from '@daguanren21/vue-doctor-core'
import type { VueComponentUsage } from '@daguanren21/vue-doctor-source'

export interface DiagnoseComponentLibraryUsageOptions {
  matches: ComponentUsageContractMatch[]
  vueVersion?: string
  /** Own entries, including undefined, override the root-project fallback. */
  vueVersions?: Readonly<Record<string, string | undefined>>
}

export type ComponentLibraryUsageDiagnostic = Diagnostic

export interface ComponentLibraryUsageResult {
  diagnostics: ComponentLibraryUsageDiagnostic[]
  skippedChecks: SkippedCheck[]
}

export interface ComponentUsageContractMatch {
  usage: VueComponentUsage
  library: ComponentLibraryEvidence
  contract: ComponentContract
  contracts?: ComponentContractMap
}

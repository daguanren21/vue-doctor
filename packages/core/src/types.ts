import type { DoctorRuleCheck, DoctorRulePack, DoctorRulePackReport } from './rule-packs.js'
import type { DoctorDiagnosticDomain, DoctorDomainCoverage } from './domains.js'
import type { SourceDiscoveryIssue } from '@vue-doctor/source'

export type DiagnosticSeverity = 'info' | 'warning' | 'error'

export type DiagnosticConfidence = 'low' | 'medium' | 'high'
export type VueFramework = 'vue2.7' | 'vue3' | 'unsupported' | 'unknown'
export interface ResolvedVueVersion {
  major: number
  minor: number
  patch: number
}

export interface GitAttribution {
  commit: string
  authorName: string
  authoredAt?: string
  summary?: string
  uncommitted?: boolean
}

export interface EvidenceLocation {
  kind: string
  file?: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  message?: string
  git?: GitAttribution
}

export type CoverageStatus = 'complete' | 'partial' | 'blocked'

export type ContractKnowledge = 'known' | 'partial' | 'unknown'

export type CoverageProblemCode =
  | 'component-library-contracts-unavailable'
  | 'component-library-contracts-partial'
  | 'component-usage-ownership-ambiguous'
  | 'source-file-parse-failed'
  | 'source-file-discovery-failed'
  | 'project-context-incomplete'

export type OwnershipEvidenceKind = 'direct-import' | 'registered-plugin' | 'unique-contract'

export interface ComponentOwnership {
  status: 'matched' | 'ambiguous' | 'unmatched'
  package?: PackageResolution
  evidence?: OwnershipEvidenceKind
  candidates: PackageResolution[]
}

export interface CoverageProblem {
  code: CoverageProblemCode
  message: string
  evidence: EvidenceLocation[]
}

export interface ContractSourceEvidence extends EvidenceLocation {
  kind: 'component-contract'
  source: 'adapter' | 'web-types' | 'vetur-tags' | 'vetur-attributes' | 'typescript' | 'runtime'
}

export interface ComponentLibraryCoverage {
  package: PackageResolution
  status: CoverageStatus
  contractSources: ContractSourceEvidence[]
  detectedUsageCount: number
  matchedUsageCount: number
  dimensions: Record<'props' | 'events' | 'models' | 'slots', ContractKnowledge>
  problems: CoverageProblem[]
}

export interface SourceCoverage {
  status: CoverageStatus
  scannedFileCount: number
  failedFiles: SourceCoverageFailure[]
  discoveryIssues?: SourceDiscoveryIssue[]
  contextIssues?: ProjectContextIssue[]
}

export interface SourceCoverageFailure {
  file: string
  block: SourceBlockKind | 'document'
  message: string
}

export type SourceBlockKind = 'template' | 'script' | 'script-setup'

export interface DoctorCoverage {
  status: CoverageStatus
  source: SourceCoverage
  componentLibraries: ComponentLibraryCoverage[]
}

export interface DiagnosticFix {
  /** Suggested remediation text; never an executable edit. */
  kind?: 'suggestion'
  title: string
  description?: string
}

/** Present coordinates are one-based; range ends are exclusive. */
export interface DiagnosticPosition {
  line: number
  column?: number
}

export interface DiagnosticPrimaryLocation {
  file: string
  start?: DiagnosticPosition
  end?: DiagnosticPosition
  precision: 'file' | 'line' | 'point' | 'range'
}

export interface DiagnosticTextEdit {
  file: string
  start: Required<DiagnosticPosition>
  end: Required<DiagnosticPosition>
  newText: string
}

export interface Diagnostic {
  /** A versioned fingerprint of normalized finding facts, independent of checkout path or Git attribution. */
  id?: string
  code: string
  severity: DiagnosticSeverity
  message: string
  file?: string
  evidence: EvidenceLocation[]
  fixes: DiagnosticFix[]
  confidence: DiagnosticConfidence
  domain?: DoctorDiagnosticDomain
  tags?: readonly string[]
  rulePack?: string
  primaryLocation?: DiagnosticPrimaryLocation
  /** Explicit edits supplied by a producer, separate from remediation suggestions. */
  edits?: DiagnosticTextEdit[]
}

export interface DoctorSuppressionAudit {
  status: 'applied' | 'unused' | 'invalid'
  ruleCode?: string
  reason?: string
  directive: {
    text: string
    location: DiagnosticPrimaryLocation
    mode?: 'line' | 'next-line'
  }
  diagnostics: Diagnostic[]
  message?: string
}

export type SkippedCheckReason =
  | 'missing-capability'
  | 'ambiguous-ownership'
  | 'partial-contract'
  | 'parse-failed'
  | 'unsupported-framework'

export interface RuleCapabilityRequirement {
  /** Any of these source block kinds may provide the rule's primary input. */
  sourceBlocks?: SourceBlockKind[]
  /** Additional block kinds that must all be present and readable. */
  allSourceBlocks?: SourceBlockKind[]
  vueVersion?: 'known'
  ownership?: 'matched' | 'unambiguous'
  contractDimensions?: Array<'props' | 'events' | 'models' | 'slots'>
  acceptance?: 'closed' | 'open-or-unknown' | 'known'
  signature?: 'exact'
}

export interface SkippedCheck {
  ruleCode: string
  required: boolean
  reason: SkippedCheckReason
  file?: string
  package?: PackageResolution
  evidence: EvidenceLocation[]
}

export interface ReportSummary {
  isClean: boolean
  diagnosticCount: number
  skippedCheckCount: number
  requiredSkippedCheckCount: number
  coverageStatus: CoverageStatus
  suppressedDiagnosticCount?: number
}

export interface PackageResolution {
  dependencyName: string
  canonicalName: string
  declaredVersion?: string
  installedVersion?: string
  packageJsonPath?: string
  packageRoot?: string
  importRoots: string[]
  source: 'installed' | 'declared'
}

export interface ProjectInventory {
  root: string
  packageJsonPath?: string
  vue?: PackageResolution
  vite?: PackageResolution
  packages: Record<string, PackageResolution>
}

export interface ProjectPluginRegistration {
  file: string
  package: { specifier: string; packageName: string; subpath?: string }
  localName: string
}

export interface ProjectApplicationContext {
  id: string
  entryFile: string
  packageRoot: string
  framework: 'vue3' | 'vue2.7'
  rootComponentFiles: string[]
  reachableFiles: string[]
  plugins: ProjectPluginRegistration[]
}

export interface ProjectPackageContext {
  root: string
  inventory: ProjectInventory
  targetFiles: string[]
}

export interface ProjectContextIssue {
  code: 'entry-discovery-failed' | 'entry-parse-failed' | 'entry-import-unresolved'
    | 'application-ownership-ambiguous' | 'application-ownership-unavailable' | 'package-resolution-failed'
  file?: string
  message: string
  targetFiles?: string[]
}

export interface ProjectContext {
  root: string
  packages: ProjectPackageContext[]
  applications: ProjectApplicationContext[]
  files: string[]
  issues: ProjectContextIssue[]
}

export type RuleSeveritySetting = DiagnosticSeverity | 'off'
export interface UiLibraryConfig {
  /** Installed package that owns the component contracts. */
  package: string
  /** Additional import roots that resolve to this package, such as a project alias. */
  aliases?: string[]
}

export interface DoctorUiConfig {
  /** Discover libraries observed through component imports and global plugin registration. Default true. */
  autoDetect?: boolean
  /**
   * Parse installed library runtime/SFC sources to supplement metadata contracts.
   * Disabled by default because metadata/declaration analysis is faster.
   */
  runtimeContracts?: boolean
  /** Explicit UI/component-library packages and optional import aliases. */
  libraries?: Array<string | UiLibraryConfig>
}

export type DoctorEslintMode = 'auto' | 'project' | 'builtin' | 'off'

export interface DoctorEslintConfig {
  /** Prefer a consuming project's flat config when present. Default: auto. */
  mode?: DoctorEslintMode
  /** Explicit flat config path, relative to the Doctor root unless absolute. */
  configFile?: string
}

export interface DoctorConfig {
  /** Limit diagnostics to a project subpath. */
  scope?: string
  /**
   * Per-code policy.
   * - severity override: 'error' | 'warning' | 'info'
   * - disable: 'off'
   */
  rules?: Record<string, RuleSeveritySetting>
  /**
   * Fail when diagnostics at or above this severity exist.
   * Defaults to 'never'; CLI flags or project config must opt into gating.
   */
  failOn?: DiagnosticSeverity | 'never'
  /** Fail when coverage is not complete. Default false. */
  failOnIncompleteCoverage?: boolean
  /** Add local Git blame author/commit context to line-level evidence. Default true. */
  gitAttribution?: boolean
  /** Component-library discovery and explicit UI framework integration. */
  ui?: DoctorUiConfig
  /** Select project-aware or isolated built-in ESLint diagnostics. */
  eslint?: DoctorEslintConfig
  /** Explicitly imported rule packs from the consuming project's executable config. */
  rulePacks?: DoctorRulePack[]
}

export interface DoctorRunOptions {
  root?: string
  scope?: string | string[]
  /** Restrict discovered files to these root-relative or absolute paths; an empty list scans no files. */
  files?: readonly string[]
  config?: DoctorConfig
  /** Absolute path to an explicit config file. */
  configFile?: string
  /** Receives the merged file and inline config for host-specific policy handling. */
  onConfigResolved?: (config: DoctorConfig) => void
}

export interface DoctorRunTarget {
  mode: 'project' | 'scope' | 'files'
  /** Normalized project-relative request scopes. */
  scopes: string[]
  requestedFiles?: string[]
  /** Actual analysis targets, including requested external-rule languages. */
  files: string[]
}

export interface DoctorRunMetadata {
  status: CoverageStatus
  target: DoctorRunTarget
  /** Session generation; absent in legacy reports. */
  generation?: number
}

export interface DoctorReport {
  schemaVersion?: 1
  run?: DoctorRunMetadata
  project: {
    root: string
    vueVersion?: string
    viteVersion?: string
    vueFramework: VueFramework
    uiLibraries: string[]
  }
  inventory: ProjectInventory
  coverage: DoctorCoverage
  diagnostics: Diagnostic[]
  skippedChecks?: SkippedCheck[]
  /** Problem-domain coverage, separate from rule-pack execution groups. */
  domainCoverage?: DoctorDomainCoverage[]
  /** Execution evidence for registered rules; configured pack metadata remains in rulePacks. */
  checks?: DoctorRuleCheck[]
  projectContext?: ProjectContext
  suppressionAudit?: DoctorSuppressionAudit[]
  /** Metadata and coverage for explicitly enabled rule packs. */
  rulePacks?: DoctorRulePackReport[]
  /** Serializable catalogs discovered at run time, such as project ESLint rules. */
  ruleCatalogs?: import('./domains.js').DoctorRuleCatalog[]
}

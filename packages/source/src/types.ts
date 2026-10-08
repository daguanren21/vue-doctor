export interface ParsedVueSource {
  blocks: SourceBlockResult[]
  templateAst?: unknown
  templateSource?: string
  scriptPrograms: unknown[]
  /** Compact descriptor facts reused by document consumers without a second SFC parse. */
  document: ParsedVueDocument
}

export interface ParsedVueDocument {
  blocks: SourceDocumentBlock[]
  errors: Array<{ message: string; line?: number; column?: number }>
  structuralFailures?: SourceStructuralFailure[]
}

/** SFC descriptor failures, separate from a script or template parser's syntax support. */
export interface SourceStructuralFailure {
  /** Omission means the failure could not be restricted to a single block kind. */
  block?: SourceBlockKind
  message: string
  line?: number
  column?: number
}

export interface ScannedVueSourceFile {
  file: string
  source: string
  parsed: ParsedVueSource
}
export interface AnalyzedSourceFile {
  fileResult: VueSourceFileResult
  components: VueComponentUsage[]
  globalPlugins: VueGlobalPluginUsage[]
  parsed?: ParsedVueSource
  preparedDocument: Omit<SourceDocument, 'text'>
}

export interface SourceAnalysisFact {
  file: string
  options: AnalyzeSourceTextOptions
  analysis: Pick<AnalyzedSourceFile, 'fileResult' | 'components' | 'globalPlugins'>
}


export interface ScanVueSourceUsageOptions {
  root?: string
  scope?: string | string[]
  /** Observe the already-parsed SFC without triggering a second parser pass. */
  onVueFile?: (file: ScannedVueSourceFile) => void
}

export type SourceDiscoveryIssueKind =
  | 'root-unavailable'
  | 'scope-not-found'
  | 'scope-unreadable'
  | 'scope-outside-root'
  | 'scope-ignored'
  | 'directory-unreadable'

export interface SourceDiscoveryIssue {
  kind: SourceDiscoveryIssueKind
  path: string
  message: string
}

export interface SourceDiscoveryResult {
  files: string[]
  issues: SourceDiscoveryIssue[]
}

/** Stable source selection shared by diagnostics, context extraction and sessions. */
export interface TargetFiles {
  root: string
  scope?: string | string[]
  requestedFiles?: readonly string[]
  files: string[]
  issues: SourceDiscoveryIssue[]
}

export interface DiscoverTargetFilesOptions {
  root?: string
  scope?: string | string[]
  files?: readonly string[]
  extensions?: readonly string[]
}

export interface SourceLocation {
  /** One-based source line. */
  line: number
  /** One-based source column. */
  column: number
}

export interface SourceDocument {
  file: string
  text: string
  /** The text cannot be safely passed to external analyzers; parse errors remain separate. */
  textUnavailable?: 'read-failed' | 'invalid-encoding'
  language: string
  blocks: SourceDocumentBlock[]
  errors: Array<{ message: string; line?: number; column?: number }>
  structuralFailures?: SourceStructuralFailure[]
}

export interface SourceDocumentBlock {
  kind: 'template' | 'script' | 'style' | 'document'
  lang: string
  content: string
  loc: SourceLocation
  start: number
  end: number
  attributes: Record<string, string | boolean>
}

export interface ReadSourceDocumentsOptions {
  scope?: string | string[]
  /** Exact root-relative or absolute file allowlist restricted to the effective scope. */
  files?: readonly string[]
  extensions?: readonly string[]
  /** Authoritative target selection resolved by the current Doctor run. */
  targetFiles?: TargetFiles
  /** Authoritative text snapshot for this run; missing entries must not be read again. */
  sourceTexts?: ReadonlyMap<string, string>
  /** Original snapshot read failures, retained for unavailable documents. */
  readFailures?: ReadonlyMap<string, unknown>
  /** Files whose shared bytes were not valid UTF-8. */
  invalidEncodingFiles?: ReadonlySet<string>
  /** Parsed SFC facts already produced by source analysis. */
  parsedVueSources?: ReadonlyMap<string, ParsedVueSource>
  /** Compact document facts already produced by source analysis. */
  preparedDocuments?: ReadonlyMap<string, Omit<SourceDocument, 'text'>>
}

export interface AnalyzeSourceTextOptions {
  includeNativeElements?: boolean
  resolveConstants?: boolean
}

export type StaticValue = string | number | boolean | null | StaticValue[] | { [key: string]: StaticValue }

export interface StaticKnowledge {
  value?: StaticValue
  properties?: Record<string, StaticKnowledge>
  elements?: StaticKnowledge[]
  complete: boolean
}

export interface VuePropUsage {
  name: string
  kind: 'static' | 'dynamic' | 'boolean'
  value?: string
  expression?: string
  /** Literal binding value; absent when evaluating the expression would require runtime state. */
  staticValue?: StaticValue
  /** Conservative syntax/lexical evidence, including partially known objects and arrays. */
  staticEvidence?: StaticKnowledge
  loc: SourceLocation
}

export interface VuePropSpreadUsage {
  expression?: string
  loc: SourceLocation
}

export interface VueEventUsage {
  name: string
  modifiers: string[]
  expression?: string
  handler?: VueEventHandlerSignature
  loc: SourceLocation
}

export interface VueEventHandlerSignature {
  kind: 'inline' | 'reference'
  parameters: string[]
  minArity?: number
  maxArity?: number | null
  /** `ignored` proves the handler never reads or forwards emitted arguments. */
  payloadUsage?: 'ignored' | 'unknown'
}

export type SourceBlockKind = 'template' | 'script' | 'script-setup'

export interface SourceBlockResult {
  kind: SourceBlockKind
  status: 'available' | 'absent' | 'failed'
  lang?: string
  message?: string
}

export interface VueSourceFileResult {
  file: string
  blocks: SourceBlockResult[]
}

export interface VuePackageReference {
  specifier: string
  packageName: string
  subpath?: string
}

export interface VueModelUsage {
  argument?: string
  expression?: string
  modifiers: string[]
  loc: SourceLocation
}

export interface VueSlotUsage {
  name: string
  expression?: string
  loc: SourceLocation
}

export interface VueDirectiveUsage {
  name: string
  argument?: string
  modifiers: string[]
  expression?: string
  /** Opt-in lexical evidence, subject to the same mutation and shadowing rules as props. */
  staticEvidence?: StaticKnowledge
  loc: SourceLocation
}

export interface VueComponentOrigin {
  kind: 'direct-import' | 'local-import' | 'global-plugin' | 'unique-contract-match'
  package?: VuePackageReference
  importedName?: string
  /** Original static import specifier, including project-local aliases. */
  importSource?: string
}

export interface VueGlobalPluginUsage {
  file: string
  package: VuePackageReference
  localName: string
  /** Application identity established from a real Vue bootstrap entry. */
  applicationId?: string
}

export interface SourceApplicationFact {
  file: string
  framework: 'vue3' | 'vue2.7'
  appLocalName: string
  rootComponentImport?: string
  rootComponentLocalName?: string
  /** Exact verified Vue 2 runtime import used by this root's constructor. */
  vueConstructorImport?: string
  plugins: VueGlobalPluginUsage[]
}

export interface SourceGlobImport {
  patterns: string[]
  eager: boolean
}

export interface SourceModuleContext {
  file: string
  imports: string[]
  /** Top-level runtime imports/re-exports; lazy or conditional loads cannot prove plugin installation. */
  eagerImports?: string[]
  /** Literal import.meta.glob module candidates, separate from eagerly executed imports. */
  globImports?: SourceGlobImport[]
  unresolvedImports: string[]
  applications: SourceApplicationFact[]
  /** Constructor-global registrations are not application roots. */
  vueConstructorPlugins?: Array<{ constructorImport: string; plugins: VueGlobalPluginUsage[] }>
  errors: string[]
}

export interface VueComponentUsage {
  file: string
  /** Application identity assigned from the entry import graph. */
  applicationId?: string
  tag: string
  componentName: string
  loc: SourceLocation
  /** Closest enclosing component in this file, excluding native element wrappers. */
  parent?: SourceLocation
  /** Opt-in native button child syntax; unknown content is never treated as icon-only. */
  childContent?: 'text' | 'graphic-only' | 'empty' | 'unknown'
  props: VuePropUsage[]
  propSpreads: VuePropSpreadUsage[]
  events: VueEventUsage[]
  models: VueModelUsage[]
  slots: VueSlotUsage[]
  directives: VueDirectiveUsage[]
  origin?: VueComponentOrigin
}

export interface VueSourceUsageReport {
  root: string
  files: string[]
  /** Discovery failures are separate from a valid request that selects zero files. */
  discoveryIssues?: SourceDiscoveryIssue[]
  components: VueComponentUsage[]
  globalPlugins: VueGlobalPluginUsage[]
  fileResults: VueSourceFileResult[]
}

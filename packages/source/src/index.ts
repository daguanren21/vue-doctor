export { parseVueSource } from './sfc.js'
export { analyzeSourceText, scanVueSourceUsage } from './scan.js'
export { discoverSourceFiles, listSourceFiles } from './files.js'
export { discoverTargetFiles } from './targets.js'
export { analyzeProjectModuleContext, collectVueApplications } from './plugins.js'
export type { AnalyzeProjectModuleContextOptions } from './plugins.js'
export { readProjectAliases, matchProjectAlias } from './project-aliases.js'
export type { ProjectAlias } from './project-aliases.js'
export { createSourceDocument, readSourceDocuments } from './documents.js'
export { extractDoctorSuppressions } from './suppression.js'
export type {
  SourceSuppressionDirective,
  SourceSuppressionIssue,
  SourceSuppressionLocation,
  SourceSuppressionPosition,
  SourceSuppressionScan
} from './suppression.js'
export { collectOptionsConstants, collectStaticConstants, resolveStaticKnowledge } from './static-knowledge.js'
export {
  collectScriptBindingFacts,
  isUnboundIdentifier,
  resolveImportedBinding,
  resolveLexicalBinding
} from './bindings.js'
export type {
  LexicalBindingFact,
  LexicalBindingKind,
  LexicalScopeFact,
  ScriptBindingFacts
} from './bindings.js'
export type {
  AnalyzedSourceFile,
  AnalyzeSourceTextOptions,
  DiscoverTargetFilesOptions,
  ReadSourceDocumentsOptions,
  SourceDocument,
  SourceDocumentBlock,
  SourceStructuralFailure,
  SourceDiscoveryIssue,
  SourceDiscoveryIssueKind,
  SourceDiscoveryResult,
  StaticKnowledge,
  ParsedVueSource,
  ParsedVueDocument,
  ScannedVueSourceFile,
  SourceAnalysisFact,
  ScanVueSourceUsageOptions,
  SourceBlockKind,
  SourceBlockResult,
  SourceLocation,
  StaticValue,
  SourceApplicationFact,
  SourceGlobImport,
  SourceModuleContext,
  TargetFiles,
  VueComponentOrigin,
  VueComponentUsage,
  VueDirectiveUsage,
  VueEventHandlerSignature,
  VueEventUsage,
  VueGlobalPluginUsage,
  VueModelUsage,
  VuePackageReference,
  VuePropUsage,
  VuePropSpreadUsage,
  VueSlotUsage,
  VueSourceFileResult,
  VueSourceUsageReport
} from './types.js'

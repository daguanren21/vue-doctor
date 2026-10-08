export { classifyVueFramework, createProjectInventory, resolveVueVersion } from './project.js'
export type { CreateProjectInventoryOptions } from './project.js'
export { DOCTOR_REPORT_SCHEMA_VERSION, getDoctorReportSchemaVersion, isSupportedDoctorReport, isDiagnosticPrimaryLocation } from './report-schema.js'
export {
  createVueDoctorCacheKey,
  isVueDoctorCacheDisabled,
  readVueDoctorCache,
  removeVueDoctorCache,
  writeVueDoctorCache
} from './cache.js'
export {
  applyDoctorConfigToDiagnostics,
  defineDoctorConfig,
  loadDoctorConfig,
  mergeDoctorConfig,
  resolveConfiguredUiLibraries,
  resolveDoctorRunOptions,
  shouldFailDoctorRun
} from './config.js'
export {
  createDoctorRuleRegistry,
  isDoctorRuleApplicable,
  isDoctorRuleEnabled,
  resolveDoctorRuleSeverity,
  validateConfiguredDoctorRuleCodes,
  validateDoctorRulePacks
} from './rule-packs.js'
export type {
  DoctorRuleApplicability,
  DoctorRuleCheck,
  DoctorVerification,
  DoctorRuleDefinition,
  DoctorRuleHelp,
  DoctorRulePack,
  DoctorRulePackContext,
  DoctorRulePackReport,
  DoctorRulePackResult,
  DoctorRuleSelectionOptions
} from './rule-packs.js'
export {
  applyDoctorRuleMetadata,
  createDoctorDomainCoverage,
  doctorDiagnosticDomains,
  isDoctorDiagnosticDomain
} from './domains.js'
export type {
  DoctorDiagnosticDomain,
  DoctorDomainCoverage,
  DoctorDomainCoverageStatus,
  DoctorRuleCatalog
} from './domains.js'
export type {
  ComponentOwnership,
  ComponentLibraryCoverage,
  ContractKnowledge,
  ContractSourceEvidence,
  CoverageProblem,
  CoverageProblemCode,
  CoverageStatus,
  OwnershipEvidenceKind,
  Diagnostic,
  DiagnosticConfidence,
  DiagnosticFix,
  DiagnosticPosition,
  DiagnosticPrimaryLocation,
  DiagnosticTextEdit,
  DiagnosticSeverity,
  DoctorCoverage,
  DoctorConfig,
  DoctorEslintConfig,
  DoctorEslintMode,
  DoctorUiConfig,
  DoctorReport,
  DoctorRunMetadata,
  DoctorRunTarget,
  DoctorSuppressionAudit,
  DoctorRunOptions,
  EvidenceLocation,
  GitAttribution,
  PackageResolution,
  ProjectInventory,
  ProjectContext,
  ProjectContextIssue,
  ProjectPackageContext,
  ProjectApplicationContext,
  ProjectPluginRegistration,
  SourceCoverage,
  SourceCoverageFailure,
  SourceBlockKind,
  RuleCapabilityRequirement,
  RuleSeveritySetting,
  SkippedCheck,
  SkippedCheckReason,
  ResolvedVueVersion,
  ReportSummary,
  UiLibraryConfig,
  VueFramework
} from './types.js'

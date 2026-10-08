export {
  classifyVueFramework,
  createProjectInventory,
  defineDoctorConfig,
  loadDoctorConfig,
  mergeDoctorConfig,
  resolveVueVersion,
  shouldFailDoctorRun
} from '@vue-doctor/core'
export { DOCTOR_REPORT_SCHEMA_VERSION, getDoctorReportSchemaVersion, isSupportedDoctorReport } from '@vue-doctor/core/report-schema'
export { createComponentLibraryEvidence, findPackageTextEvidence } from '@vue-doctor/component-library'
export { getDiagnosticReference, listDiagnosticReferences } from '@vue-doctor/diagnostic-reference'
export { renderInspectorHtml } from '@vue-doctor/inspector-ui/html'
export { diagnoseComponentLibraryUsage, diagnoseComponentLibraryUsageResult } from '@vue-doctor/rule-pack-component-library'
export { createDoctorAnalysisSession, resolveDoctorRuleCatalogs, runDoctor, summarizeDoctorReport } from '@vue-doctor/runner'
export type { DoctorAnalysisSession, DoctorAnalysisSessionStats, DoctorAnalysisRunStats, DoctorAnalysisPhase, DoctorSourceWorkspaceStats } from '@vue-doctor/runner'
export { scanVueSourceUsage } from '@vue-doctor/source'
export { startInspectorServer } from './inspect.js'
export type { InspectorServer, InspectorServerOptions, OpenEditorRequest } from './inspect-server.js'
export type {
  ComponentLibraryCoverage,
  ContractKnowledge,
  ContractSourceEvidence,
  CoverageProblem,
  CoverageProblemCode,
  CoverageStatus,
  Diagnostic,
  DiagnosticConfidence,
  DiagnosticFix,
  DiagnosticPosition,
  DiagnosticPrimaryLocation,
  DiagnosticTextEdit,
  DiagnosticSeverity,
  DoctorConfig,
  DoctorEslintConfig,
  DoctorEslintMode,
  DoctorCoverage,
  DoctorDiagnosticDomain,
  DoctorDomainCoverage,
  DoctorDomainCoverageStatus,
  DoctorUiConfig,
  DoctorReport,
  DoctorRunMetadata,
  DoctorRunTarget,
  DoctorSuppressionAudit,
  DoctorRunOptions,
  DoctorRuleCheck,
  DoctorVerification,
  DoctorRuleDefinition,
  DoctorRulePack,
  DoctorRulePackContext,
  DoctorRulePackReport,
  DoctorRulePackResult,
  RuleSeveritySetting,
  EvidenceLocation,
  PackageResolution,
  ProjectInventory,
  ProjectContext,
  ProjectContextIssue,
  ProjectPackageContext,
  ProjectApplicationContext,
  ProjectPluginRegistration,
  ResolvedVueVersion,
  SourceCoverage,
  UiLibraryConfig,
  VueFramework
} from '@vue-doctor/core'
export type {
  ComponentLibraryArtifacts,
  ComponentLibraryEvidence,
  ComponentLibraryEvidenceOptions,
  EvidenceFile,
  FindPackageTextEvidenceOptions,
  PackageTextEvidence
} from '@vue-doctor/component-library'
export type { DiagnosticReference } from '@vue-doctor/diagnostic-reference'
export type { InspectorHtmlOptions } from '@vue-doctor/inspector-ui/html'
export type {
  ComponentLibraryUsageDiagnostic,
  ComponentLibraryUsageResult,
  DiagnoseComponentLibraryUsageOptions
} from '@vue-doctor/rule-pack-component-library'
export type {
  ScanVueSourceUsageOptions,
  SourceLocation,
  VueComponentUsage,
  VueEventHandlerSignature,
  VueEventUsage,
  VueModelUsage,
  VuePropUsage,
  VueSlotUsage,
  VueSourceUsageReport
} from '@vue-doctor/source'

export { installGithubActionsWorkflow, buildVueDoctorWorkflow } from './ci.js'
export { resolveChangedFiles } from './changed-files.js'

export {
  detectAvailableSkillAgents,
  installVueDoctorSkill,
  listSupportedSkillAgents,
  resolveSkillSourceDirectory
} from './install-skill.js'

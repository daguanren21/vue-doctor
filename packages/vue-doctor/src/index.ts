export {
  classifyVueFramework,
  createProjectInventory,
  defineDoctorConfig,
  loadDoctorConfig,
  mergeDoctorConfig,
  resolveVueVersion,
  shouldFailDoctorRun
} from '@daguanren21/vue-doctor-core'
export { DOCTOR_REPORT_SCHEMA_VERSION, getDoctorReportSchemaVersion, isSupportedDoctorReport } from '@daguanren21/vue-doctor-core/report-schema'
export { createComponentLibraryEvidence, findPackageTextEvidence } from '@daguanren21/vue-doctor-component-library'
export { getDiagnosticReference, listDiagnosticReferences } from '@daguanren21/vue-doctor-diagnostic-reference'
export { renderInspectorHtml } from '@daguanren21/vue-doctor-inspector-ui/html'
export { diagnoseComponentLibraryUsage, diagnoseComponentLibraryUsageResult } from '@daguanren21/vue-doctor-rule-pack-component-library'
export { createDoctorAnalysisSession, resolveDoctorRuleCatalogs, runDoctor, summarizeDoctorReport } from '@daguanren21/vue-doctor-runner'
export type { DoctorAnalysisSession, DoctorAnalysisSessionStats, DoctorAnalysisRunStats, DoctorAnalysisPhase, DoctorSourceWorkspaceStats } from '@daguanren21/vue-doctor-runner'
export { scanVueSourceUsage } from '@daguanren21/vue-doctor-source'
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
} from '@daguanren21/vue-doctor-core'
export type {
  ComponentLibraryArtifacts,
  ComponentLibraryEvidence,
  ComponentLibraryEvidenceOptions,
  EvidenceFile,
  FindPackageTextEvidenceOptions,
  PackageTextEvidence
} from '@daguanren21/vue-doctor-component-library'
export type { DiagnosticReference } from '@daguanren21/vue-doctor-diagnostic-reference'
export type { InspectorHtmlOptions } from '@daguanren21/vue-doctor-inspector-ui/html'
export type {
  ComponentLibraryUsageDiagnostic,
  ComponentLibraryUsageResult,
  DiagnoseComponentLibraryUsageOptions
} from '@daguanren21/vue-doctor-rule-pack-component-library'
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
} from '@daguanren21/vue-doctor-source'

export { installGithubActionsWorkflow, buildVueDoctorWorkflow } from './ci.js'
export { resolveChangedFiles } from './changed-files.js'

export {
  detectAvailableSkillAgents,
  installVueDoctorSkill,
  listSupportedSkillAgents,
  resolveSkillSourceDirectory
} from './install-skill.js'

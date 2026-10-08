export { analyzeComponentLibraries } from './analysis.js'
export type { AnalyzeComponentLibrariesOptions, ComponentLibraryAnalysis } from './analysis.js'
export { resolveDoctorRuleCatalogs, runDoctor } from './run.js'
export { createDoctorAnalysisSession } from './session.js'
export type {
  DoctorAnalysisSession,
  DoctorAnalysisPhase,
  DoctorAnalysisRunStats,
  DoctorAnalysisSessionServices,
  DoctorAnalysisSessionStats,
  DoctorRunGenerationContext
} from './session.js'
export { scanDoctorSource } from './source-analysis.js'
export type {
  DoctorSourceFileAnalysis,
  DoctorSourceScan,
  DoctorSourceTask,
  PreparedSourceDocument
} from './source-analysis.js'
export { DoctorSourceWorkspace } from './source-workspace.js'
export type {
  DoctorSourceWorkspaceOptions,
  DoctorSourceWorkspaceStats,
  SourceTextFact,
  SourceWorkerPool
} from './source-workspace.js'
export { getSkippedChecks, summarizeDoctorReport } from './report-policy.js'
export { finalizeDoctorReport } from './report-contract.js'
export type {
  DoctorReportSuppressionFacts,
  DoctorReportTargetFacts,
  FinalizeDoctorReportOptions
} from './report-contract.js'

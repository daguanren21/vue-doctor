import type { DoctorReport, ReportSummary, SkippedCheck } from '@vue-doctor/core'

export function summarizeDoctorReport(report: DoctorReport): ReportSummary {
  const skippedChecks = report.skippedChecks ?? []
  const requiredSkippedCheckCount = skippedChecks.filter((check) => check.required).length

  return {
    isClean: report.diagnostics.length === 0
      && report.coverage.status === 'complete'
      && requiredSkippedCheckCount === 0,
    diagnosticCount: report.diagnostics.length,
    skippedCheckCount: skippedChecks.length,
    requiredSkippedCheckCount,
    coverageStatus: report.coverage.status,
    suppressedDiagnosticCount: new Set(report.suppressionAudit?.flatMap(item => item.diagnostics.map(finding => finding.id ?? finding))).size
  }
}

export function getSkippedChecks(report: DoctorReport): SkippedCheck[] {
  return report.skippedChecks ?? []
}

import type { InspectorCoverageResult } from '@vue-doctor/inspector-protocol'

export function coverageSummaryTotal(summary: InspectorCoverageResult['summary']): number {
  return summary.reduce((total, entry) => total + entry.count, 0)
}

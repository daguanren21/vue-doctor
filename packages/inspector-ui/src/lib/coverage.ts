import type { InspectorCoverageResult } from '@daguanren21/vue-doctor-inspector-protocol'

export function coverageSummaryTotal(summary: InspectorCoverageResult['summary']): number {
  return summary.reduce((total, entry) => total + entry.count, 0)
}

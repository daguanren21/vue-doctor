import type { InspectorMessages } from '../i18n'

export function ruleStatusLabel(status: string, labels: InspectorMessages): string {
  const values: Record<string, string> = {
    checked: labels.checkChecked,
    partial: labels.checkPartial,
    'not-applicable': labels.checkNotApplicable,
    unavailable: labels.checkUnavailable,
    manual: labels.checkManual,
    runtime: labels.checkRuntime,
    'policy-pending': labels.checkPolicyPending,
    disabled: labels.checkDisabled,
    'not-reported': labels.checkUnreported
  }
  return values[status] ?? status
}

export function auditStatusLabel(status: string, labels: InspectorMessages): string {
  if (status === 'applied') return labels.appliedDirective
  if (status === 'invalid') return labels.invalidDirective
  if (status === 'unused') return labels.unusedDirective
  return status
}

export function coverageCategoryLabel(category: string, labels: InspectorMessages): string {
  const values: Record<string, string> = {
    source: labels.sourceGaps,
    parse: labels.parseGaps,
    context: labels.contextGaps,
    contract: labels.contractGaps,
    skipped: labels.skippedChecks,
    domain: labels.domainGaps
  }
  return values[category] ?? category
}

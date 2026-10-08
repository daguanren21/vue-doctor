import type { DoctorReport, DoctorRuleCheck, DoctorRuleDefinition } from '@vue-doctor/core'

export interface InspectorCheckRow {
  pack: string
  rule: DoctorRuleDefinition
  check?: DoctorRuleCheck
  status: DoctorRuleCheck['status'] | 'unreported'
}

/** The top-level execution record is authoritative; legacy packs remain readable. */
export function inspectorCheckRows(report: DoctorReport | null): InspectorCheckRow[] {
  if (!report) return []
  const rows = new Map<string, InspectorCheckRow>()
  for (const pack of report.rulePacks ?? []) {
    const checks = new Map(pack.checks?.map(check => [check.ruleCode, check]))
    for (const rule of pack.rules) {
      const check = checks.get(rule.code)
      rows.set(rule.code, { pack: pack.name, rule, check, status: check?.status ?? 'unreported' })
    }
  }
  for (const check of report.checks ?? []) {
    const previous = rows.get(check.ruleCode)
    const finding = report.diagnostics.find(item => item.code === check.ruleCode)
    const domain = finding?.domain ?? (check.rulePack === 'vue' ? 'vue'
      : check.rulePack === 'component-library' ? 'component-library' : undefined)
    rows.set(check.ruleCode, {
      pack: check.rulePack ?? previous?.pack ?? '',
      rule: previous?.rule ?? {
        code: check.ruleCode,
        title: check.ruleCode,
        description: check.reason ?? '',
        ...(domain ? { domain } : {})
      },
      check,
      status: check.status
    })
  }
  return [...rows.values()]
}

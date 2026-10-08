import type { DoctorDiagnosticDomain, DoctorDomainCoverageStatus } from '@vue-doctor/core'
import type { InspectorLocale, inspectorMessages } from '../i18n'

type Labels = (typeof inspectorMessages)[InspectorLocale]

export function domainLabel(domain: DoctorDiagnosticDomain, labels: Labels): string {
  return {
    'component-library': labels.componentLibrary,
    styles: labels.styles,
    interaction: labels.interaction,
    vue: labels.vueWriting,
    vite: labels.vite,
    conventions: labels.conventions,
    unclassified: labels.unclassified
  }[domain]
}

export function domainStatusLabel(status: DoctorDomainCoverageStatus, labels: Labels): string {
  return {
    'not-covered': labels.domainNotCovered,
    'not-reported': labels.domainNotReported,
    partial: labels.domainPartial,
    complete: labels.domainComplete
  }[status]
}

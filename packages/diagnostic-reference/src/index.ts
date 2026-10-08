import type { DoctorDiagnosticDomain, DoctorRuleDefinition } from '@vue-doctor/core'
import { componentLibraryRuleDefinitions } from '@vue-doctor/rule-pack-component-library/rules'
import { vueRuleDefinitions } from '@vue-doctor/rule-pack-vue/rules'
import { eslintRuleDefinitions } from '@vue-doctor/rule-pack-eslint'

export interface DiagnosticReference {
  code: string
  rulePack: string
  title: string
  problem: string
  remediation: string
  domain?: DoctorDiagnosticDomain
  tags?: readonly string[]
}

function toDiagnosticReference(
  rulePack: string,
  definition: DoctorRuleDefinition
): DiagnosticReference {
  if (!definition.help) {
    throw new Error(`Diagnostic reference metadata is missing for ${definition.code}.`)
  }
  return {
    code: definition.code,
    rulePack,
    title: definition.title,
    problem: definition.help.problem,
    remediation: definition.help.remediation,
    domain: definition.domain,
    tags: definition.tags
  }
}

const diagnosticReferences: DiagnosticReference[] = [
  ...vueRuleDefinitions.map((definition) => toDiagnosticReference('vue', definition)),
  ...componentLibraryRuleDefinitions.map((definition) => (
    toDiagnosticReference('component-library', definition)
  )),
  ...eslintRuleDefinitions.map(definition => toDiagnosticReference('eslint', definition))
]

export function listDiagnosticReferences(): DiagnosticReference[] {
  return [...diagnosticReferences]
}

export function getDiagnosticReference(code: string): DiagnosticReference | undefined {
  return diagnosticReferences.find((reference) => reference.code === code)
}

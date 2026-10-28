import type { Rule } from 'eslint'
import type { DoctorRuleMeta } from '@daguanren21/vue-doctor-rules'

/** Only the official documentation fields used by the public Doctor catalog. */
export type CoreRuleMetadata = readonly [name: string, description: string | null, url: string | null]

export function extractCoreRuleMetadata(rules: Iterable<[string, Rule.RuleModule]>): readonly CoreRuleMetadata[] {
  return Array.from(rules, ([name, module]) => [
    name,
    module.meta?.docs?.description ?? null,
    module.meta?.docs?.url ?? null
  ] as const)
}

export function formatCoreRuleMetadata([name, description, url]: CoreRuleMetadata): DoctorRuleMeta {
  return {
    title: description ?? name,
    description: description ?? `Evaluate the official ESLint ${name} rule.`,
    domain: 'conventions', verification: 'static', defaultEnabled: false, defaultSeverity: 'warning',
    tags: ['eslint'],
    help: {
      problem: description ?? `The source violates the official ESLint ${name} rule.`,
      remediation: `Review the finding in its source context.${url ? ` Rule documentation: ${url}` : ''}`
    }
  }
}

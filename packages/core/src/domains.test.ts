import { expect, test } from 'vitest'
import { applyDoctorRuleMetadata, createDoctorDomainCoverage } from './domains.js'
import type { DoctorRuleCatalog } from './domains.js'
import type { Diagnostic } from './types.js'

const catalogs: DoctorRuleCatalog[] = [{ name: 'example', rules: [
  { code: 'example/style', title: 'Style', description: '', domain: 'styles', tags: ['interaction', 'interaction'] },
  { code: 'example/runtime', title: 'Runtime', description: '', domain: 'interaction', verification: 'runtime' },
  { code: 'example/legacy', title: 'Legacy', description: '' }
] }]
const diagnostic: Diagnostic = { code: 'example/style', severity: 'warning', message: '', evidence: [], fixes: [], confidence: 'high' }

test('uses definition ownership, deduplicates tags and keeps unclassified legacy diagnostics', () => {
  const result = applyDoctorRuleMetadata([diagnostic, { ...diagnostic, code: 'unknown' }], catalogs)
  expect(result[0]).toMatchObject({ domain: 'styles', tags: ['interaction'], rulePack: 'example' })
  expect(result[1]).toMatchObject({ domain: 'unclassified', tags: [] })
  expect(diagnostic).not.toHaveProperty('domain')
})

test('does not claim coverage for empty domains, undeclared execution or pending runtime checks', () => {
  const coverage = createDoctorDomainCoverage({
    catalogs, diagnostics: applyDoctorRuleMetadata([diagnostic], catalogs), skippedChecks: [],
    rulePacks: [{ name: 'example', rules: catalogs[0]!.rules, coverageStatus: 'partial', checks: [
      { ruleCode: 'example/style', status: 'checked' },
      { ruleCode: 'example/runtime', status: 'runtime' }
    ] }]
  })
  expect(coverage.find(row => row.domain === 'styles')).toMatchObject({ status: 'complete', diagnosticCount: 1 })
  expect(coverage.find(row => row.domain === 'interaction')).toMatchObject({ status: 'partial', pendingCheckCount: 1 })
  expect(coverage.find(row => row.domain === 'unclassified')).toMatchObject({ status: 'not-reported', unreportedCheckCount: 1 })
  expect(coverage.find(row => row.domain === 'vite')).toMatchObject({ status: 'not-covered', ruleCount: 0 })
})

test('required skips and discovery failures lower coverage even with explicit checked records', () => {
  const coverage = createDoctorDomainCoverage({ catalogs, diagnostics: [], sourceStatus: 'partial', skippedChecks: [
    { ruleCode: 'example/style', required: true, reason: 'missing-capability', evidence: [] }
  ] })
  expect(coverage.find(row => row.domain === 'styles')).toMatchObject({ status: 'partial', unavailableCheckCount: 1 })
})

test('a domain containing only disabled or inapplicable rules is not covered', () => {
  const coverage = createDoctorDomainCoverage({ catalogs, diagnostics: [], skippedChecks: [], rulePacks: [
    { name: 'example', rules: catalogs[0]!.rules, coverageStatus: 'complete', checks: [
      { ruleCode: 'example/style', status: 'disabled' },
      { ruleCode: 'example/runtime', status: 'not-applicable' }
    ] }
  ] })
  expect(coverage.find(row => row.domain === 'styles')).toMatchObject({ status: 'not-covered', inactiveRuleCount: 1 })
  expect(coverage.find(row => row.domain === 'interaction')).toMatchObject({ status: 'not-covered', pendingCheckCount: 0 })
})

test('uses canonical checks for built-in coverage and retains partial execution evidence', () => {
  const coverage = createDoctorDomainCoverage({
    catalogs, diagnostics: [], skippedChecks: [], checks: [
      { ruleCode: 'example/style', status: 'checked', files: 1 },
      { ruleCode: 'example/runtime', status: 'partial', files: 1, reason: 'One target was unavailable.' }
    ]
  })
  expect(coverage.find(row => row.domain === 'styles')).toMatchObject({ status: 'complete', unreportedCheckCount: 0 })
  expect(coverage.find(row => row.domain === 'interaction')).toMatchObject({ status: 'partial', unavailableCheckCount: 1 })
})

test('retains configured-pack checks alongside built-in execution records', () => {
  const coverage = createDoctorDomainCoverage({
    catalogs, diagnostics: [], skippedChecks: [],
    checks: [{ ruleCode: 'example/style', status: 'checked' }],
    rulePacks: [{ name: 'example', rules: catalogs[0]!.rules, coverageStatus: 'partial', checks: [
      { ruleCode: 'example/runtime', status: 'runtime' }
    ] }]
  })
  expect(coverage.find(row => row.domain === 'styles')).toMatchObject({ status: 'complete' })
  expect(coverage.find(row => row.domain === 'interaction')).toMatchObject({ status: 'partial', pendingCheckCount: 1 })
})

import { expect, test } from 'vitest'
import type { DoctorReport } from '@vue-doctor/core'
import { inspectorCheckRows } from './checks'

const base: DoctorReport = {
  project: { root: '/fixture', vueFramework: 'unknown', uiLibraries: [] },
  inventory: { root: '/fixture', packages: {} },
  coverage: { status: 'complete', source: { status: 'complete', scannedFileCount: 0, failedFiles: [] }, componentLibraries: [] },
  diagnostics: []
}

test('canonical checks include built-ins and override legacy external records', () => {
  const rows = inspectorCheckRows({ ...base,
    rulePacks: [{ name: 'external', coverageStatus: 'complete',
      rules: [{ code: 'external/rule', title: 'External', description: 'Example' }],
      checks: [{ ruleCode: 'external/rule', status: 'checked' }] }],
    checks: [{ ruleCode: 'vue-example', rulePack: 'vue', status: 'unavailable', reason: 'Missing version' },
      { ruleCode: 'external/rule', rulePack: 'external', status: 'partial', reason: 'One file failed' }]
  })
  expect(rows).toHaveLength(2)
  expect(rows.find(row => row.rule.code === 'external/rule')).toMatchObject({ rule: { title: 'External' }, status: 'partial' })
  expect(rows.find(row => row.rule.code === 'vue-example')).toMatchObject({ pack: 'vue', status: 'unavailable', rule: { domain: 'vue' } })
})

test('legacy rule definitions without records remain unreported', () => {
  expect(inspectorCheckRows({ ...base, rulePacks: [{ name: 'external', coverageStatus: 'complete',
    rules: [{ code: 'external/rule', title: 'External', description: 'Example' }] }] })[0]?.status).toBe('unreported')
})

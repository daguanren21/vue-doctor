import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDoctorAnalysisSession, runDoctor } from '@vue-doctor/runner'
import { shouldFailDoctorRun } from '@vue-doctor/core'
import { defineRule, defineRules, oxcRule } from './rules.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-rule-sdk-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(root, 'src/state.ts'), text)
  return root
}

function teamRules(vueOnly?: 2 | 3) {
  return defineRules({
    name: 'team',
    rules: {
      'no-var': defineRule({
        meta: { title: 'Use block-scoped declarations', description: 'Choose let or const.', domain: 'conventions', defaultSeverity: 'warning', ...(vueOnly ? { applicability: { vue: { only: vueOnly } } } : {}) },
        check: oxcRule({ create(context) {
          return { VariableDeclaration(node) {
            if (node.kind === 'var') context.report({ node, message: 'Use let or const.' })
          } }
        } })
      })
    }
  })
}

test('public SDK feeds severity, stable IDs, rule metadata and suppression audit through Doctor Run', async () => {
  const root = await fixture('// vue-doctor-disable-next-line team/no-var -- Reviewed legacy binding\nvar hidden = 1\nvar visible = 2\n')
  const options = { root, scope: 'src', config: { gitAttribution: false, rulePacks: [teamRules()], rules: { 'team/no-var': 'error' as const } } }
  const first = await runDoctor(options)
  const second = await runDoctor(options)
  const findings = first.diagnostics.filter(finding => finding.code === 'team/no-var')
  expect(findings).toHaveLength(1)
  expect(findings[0]).toMatchObject({ severity: 'error', domain: 'conventions', rulePack: 'team', primaryLocation: { start: { line: 3, column: 1 } } })
  expect(findings[0]?.id).toBeTruthy()
  expect(second.diagnostics.find(finding => finding.code === 'team/no-var')?.id).toBe(findings[0]?.id)
  expect(first.suppressionAudit).toContainEqual(expect.objectContaining({
    status: 'applied', ruleCode: 'team/no-var', reason: 'Reviewed legacy binding',
    diagnostics: [expect.objectContaining({ code: 'team/no-var', severity: 'error', id: expect.any(String) })]
  }))
  expect(first.rulePacks?.find(pack => pack.name === 'team')).toMatchObject({ coverageStatus: 'complete', checks: [{ ruleCode: 'team/no-var', status: 'checked', files: 1 }] })
})

test('unknown custom rule settings fail as configuration errors', async () => {
  const root = await fixture('const value = 1\n')
  await expect(runDoctor({ root, config: { gitAttribution: false, rulePacks: [teamRules()], rules: { 'team/no-vars': 'off' } } })).rejects.toThrow('Unknown Doctor rule code')
})

test('parser failure retains a required skip and fails the incomplete-coverage gate', async () => {
  const root = await fixture('const = invalid\n')
  const report = await runDoctor({ root, scope: 'src', config: { gitAttribution: false, rulePacks: [teamRules()] } })
  expect(report.skippedChecks).toContainEqual(expect.objectContaining({ ruleCode: 'team/no-var', reason: 'parse-failed', required: true }))
  expect(report.rulePacks?.find(pack => pack.name === 'team')?.coverageStatus).toBe('partial')
  expect(shouldFailDoctorRun({ diagnostics: report.diagnostics, coverageStatus: report.coverage.status, config: { failOnIncompleteCoverage: true } })).toBe(true)
})

test.each([
  '<script>var value = 1',
  '<script>var first = 1</script><script>var second = 2</script>'
])('SFC structural failures remain unavailable on cold and cached runs: %s', async text => {
  const root = await fixture('const valid = 1\n')
  await writeFile(join(root, 'src/App.vue'), text)
  const options = { root, scope: 'src', config: { gitAttribution: false, rulePacks: [teamRules()] } }
  const session = createDoctorAnalysisSession(options)
  try {
    for (let run = 0; run < 2; run++) {
      const report = await session.run()
      expect(report.skippedChecks).toContainEqual(expect.objectContaining({ ruleCode: 'team/no-var', file: join(root, 'src/App.vue'), reason: 'parse-failed', required: true }))
      expect(report.rulePacks?.find(pack => pack.name === 'team')?.coverageStatus).toBe('partial')
      expect(report.diagnostics.filter(finding => finding.code === 'team/no-var')).toEqual([])
    }
    expect(session.getStats().source.factCacheHits).toBeGreaterThan(0)
  } finally { await session.close() }
})

test('checks Vue 3 child-package files when the workspace root uses Vue 2', async () => {
  const root = await fixture('const valid = 1\n')
  const app = join(root, 'packages/app')
  await mkdir(join(root, 'node_modules/vue'), { recursive: true })
  await mkdir(join(app, 'node_modules/vue'), { recursive: true })
  await mkdir(join(app, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '2.7.16' } }))
  await writeFile(join(root, 'node_modules/vue/package.json'), JSON.stringify({ name: 'vue', version: '2.7.16' }))
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'workspace-app', dependencies: { vue: '3.5.39' } }))
  await writeFile(join(app, 'node_modules/vue/package.json'), JSON.stringify({ name: 'vue', version: '3.5.39' }))
  await writeFile(join(root, 'src/Legacy.vue'), '<script setup>var legacy = 1</script><template><div /></template>')
  const modernFile = join(app, 'src/Modern.vue')
  await writeFile(modernFile, '<script setup>var modern = 1</script><template><div /></template>')
  const report = await runDoctor({ root, scope: ['src', 'packages/app/src'], config: { gitAttribution: false, rulePacks: [teamRules(3)] } })
  expect(report.diagnostics.filter(finding => finding.code === 'team/no-var').map(finding => finding.file)).toEqual([modernFile])
  expect(report.rulePacks?.find(pack => pack.name === 'team')).toMatchObject({ coverageStatus: 'complete', checks: [{ ruleCode: 'team/no-var', status: 'checked', files: 1 }] })
})

test('template-only descriptor failures keep readable script rules available', async () => {
  const root = await fixture('const valid = 1\n')
  const file = join(root, 'src/App.vue')
  await writeFile(file, '<template><div></span></template><script>var value = 1</script>')
  const report = await runDoctor({ root, scope: 'src', config: { gitAttribution: false, rulePacks: [teamRules()] } })
  expect(report.coverage.source.status).toBe('partial')
  expect(report.diagnostics.filter(finding => finding.code === 'team/no-var').map(finding => finding.file)).toEqual([file])
  expect(report.rulePacks?.find(pack => pack.name === 'team')?.coverageStatus).toBe('complete')
})

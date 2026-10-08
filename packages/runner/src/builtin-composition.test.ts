import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runDoctor } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-builtin-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'example-app', dependencies: { vue: '^3.5.0', vite: '^8.0.0' } }))
  await writeFile(join(root, 'Example.vue'), '<script setup>debugger; const same = 1 == 2</script>\n<template><div /></template>')
  return root
}

test('ESLint is built in and explicitly selectable without an external rule pack', async () => {
  const root = await project()
  const report = await runDoctor({ root, config: { gitAttribution: false, rules: { 'eslint/no-debugger': 'error', 'eslint/eqeqeq': 'warning' } } })
  expect(report.diagnostics.filter(d => d.code.startsWith('eslint/')).map(d => [d.code, d.severity, d.rulePack])).toEqual([
    ['eslint/no-debugger', 'error', 'eslint'], ['eslint/eqeqeq', 'warning', 'eslint']
  ])
  expect(report.checks?.find(c => c.ruleCode === 'eslint/no-debugger')).toMatchObject({ status: 'checked', rulePack: 'eslint' })
  expect(report.rulePacks).toBeUndefined()
  expect(report.domainCoverage?.find(d => d.domain === 'vite')?.status).toBe('not-covered')
})

test('default diagnostics leave optional ESLint rules disabled', async () => {
  const root = await project()
  const report = await runDoctor({ root, config: { gitAttribution: false } })
  expect(report.diagnostics.some(d => d.code.startsWith('eslint/'))).toBe(false)
  expect(report.checks?.filter(c => c.ruleCode.startsWith('eslint/')).every(c => c.status === 'disabled')).toBe(true)
  expect(report.rulePacks).toBeUndefined()
})

test('built-in ESLint participates in local suppression audit and still reports original findings', async () => {
  const root = await project()
  await writeFile(join(root, 'Example.vue'), '<script setup>\n// vue-doctor-disable-next-line eslint/no-debugger -- Example intentional pause\ndebugger;\n</script>')
  const report = await runDoctor({ root, config: { gitAttribution: false, rules: { 'eslint/no-debugger': 'warning' } } })
  expect(report.diagnostics.some(d => d.code === 'eslint/no-debugger')).toBe(false)
  expect(report.suppressionAudit).toHaveLength(1)
  expect(report.suppressionAudit?.[0]?.diagnostics[0]?.code).toBe('eslint/no-debugger')
})

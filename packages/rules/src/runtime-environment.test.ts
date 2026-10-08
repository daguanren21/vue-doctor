import { expect, test } from 'vitest'
import { createSourceDocument } from '@vue-doctor/source'
import { babelRule, defineRule, defineRules, oxcRule } from './index.js'

test('keeps Oxc available and records a Babel capability gap below its supported runtime', async () => {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!
  const pack = defineRules({ name: 'runtime', rules: {
    oxc: defineRule({ meta: { title: 'Oxc check', description: 'Checks syntax.' }, check: oxcRule({ create(context) {
      return { VariableDeclaration(node) { context.report({ node, message: 'Oxc syntax was checked.' }) } }
    } }) }),
    babel: defineRule({ meta: { title: 'Babel check', description: 'Checks Babel syntax.' }, check: babelRule({ create() {
      throw new Error('An unsupported Babel runtime must not execute the rule.')
    } }) })
  } })
  Object.defineProperty(process.versions, 'node', { ...original, value: '20.19.0' })
  try {
    const document = createSourceDocument('/fixture/state.js', 'const value = 1')
    const result = await pack.run({
      inventory: { root: '/fixture', packages: {} },
      source: { root: '/fixture', files: [document.file], components: [], globalPlugins: [], fileResults: [] },
      documents: [document], components: [], rules: {}
    })
    expect(result.checks).toContainEqual(expect.objectContaining({ ruleCode: 'runtime/oxc', status: 'checked' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ ruleCode: 'runtime/babel', status: 'unavailable' }))
    expect(result.skippedChecks).toContainEqual(expect.objectContaining({ ruleCode: 'runtime/babel', required: true, reason: 'missing-capability', evidence: [expect.objectContaining({ message: expect.stringContaining('20.19.0') })] }))
    expect(result.diagnostics.map(finding => finding.code)).toEqual(['runtime/oxc'])
  } finally { Object.defineProperty(process.versions, 'node', original) }
})

test('an authoritative empty target set needs no parser capabilities', async () => {
  const pack = defineRules({ name: 'empty', rules: {
    typed: defineRule({ meta: { title: 'Type check', description: 'Requires a real checker.' }, check: oxcRule({ requires: { types: true }, create: () => ({}) }) })
  } })
  const result = await pack.run({ inventory: { root: '/fixture', packages: {} }, source: { root: '/fixture', files: [], components: [], globalPlugins: [], fileResults: [] }, documents: [], components: [], rules: {} })
  expect(result.checks).toEqual([{ ruleCode: 'empty/typed', rulePack: 'empty', status: 'not-applicable', files: 0 }])
  expect(result.skippedChecks).toEqual([])
})

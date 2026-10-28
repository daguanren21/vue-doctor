import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createComponentLibraryEvidence, extractComponentLibraryContracts } from '@daguanren21/vue-doctor-component-library'
import { analyzeSourceText } from '@daguanren21/vue-doctor-source'
import { afterEach, describe, expect, test } from 'vitest'
import { diagnoseComponentLibraryUsageResult } from './events.js'

const fixtureRoots: string[] = []
afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createFixture(files: Record<string, string>, packageJson: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-integration-'))
  const packageRoot = join(root, 'node_modules/example-ui')
  fixtureRoots.push(root)
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { 'example-ui': '1.2.3' } }))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'example-ui', version: '1.2.3', ...packageJson }))
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(packageRoot, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, 'utf8')
  }
  return createComponentLibraryEvidence({
    package: {
      dependencyName: 'example-ui', canonicalName: 'example-ui',
      declaredVersion: '1.2.3', installedVersion: '1.2.3',
      packageJsonPath: join(packageRoot, 'package.json'), packageRoot,
      importRoots: ['example-ui'], source: 'installed'
    }
  })
}

describe('component contract integration', () => {
  test('diagnoses inline and aliased event tuple payloads through public extraction', async () => {
    const evidence = await createFixture({
      'index.d.ts': `
type Many = [string, ...number[]]
type Optional = [string, number?]
export declare class Stream {
  $emit: {
    (event: 'many', ...args: [string, ...number[]]): void
    (event: 'optional', ...args: [string, number?]): void
    (event: 'aliased-many', ...args: Many): void
    (event: 'aliased-optional', ...args: Optional): void
  }
}
`
    }, { types: './index.d.ts' })
    const contracts = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const contract = contracts.components.get('Stream')!

    expect(contracts.problems).toEqual([])
    for (const name of ['many', 'optional', 'aliased-many', 'aliased-optional']) {
      const unbounded = name.endsWith('many')
      expect(contract.events.entries.get(name)?.signatures).toMatchObject([{
        minArity: 1,
        maxArity: unbounded ? null : 2
      }])
      const usage = analyzeSourceText('/project/src/App.vue', `<script setup>
function consume(first, second, third) { console.log(first, second, third) }
</script><template><Stream @${name}="consume" /></template>`).components[0]!
      expect(usage.events[0]?.handler).toMatchObject({ minArity: 3, maxArity: 3 })
      const result = diagnoseComponentLibraryUsageResult({
        matches: [{ usage, library: evidence, contract, contracts }]
      })
      expect(result.skippedChecks, name).toEqual([])
      expect(result.diagnostics.map((diagnostic) => diagnostic.code), name).toEqual(
        unbounded ? [] : ['component-event-payload-changed']
      )
    }
  })

  test.each(['web-types', 'vetur-tags', 'vetur-attributes'] as const)(
    'keeps opaque %s prop evidence unavailable without weakening known controls',
    async (format) => {
      const attributes = [
        { name: 'opaque', type: 'LocalMode' },
        { name: 'union', type: 'string | LocalMode' },
        { name: 'reverse', type: 'LocalMode | number' },
        { name: 'any', type: 'any' },
        { name: 'unknown', type: 'unknown' },
        { name: 'any-union', type: 'LocalMode | any' },
        { name: 'unknown-union', type: 'unknown | LocalMode' },
        { name: 'text', type: 'string' },
        { name: 'count', type: 'number' },
        { name: 'literal', type: "'valid'" },
        { name: 'array', type: 'LocalMode[]' },
        { name: 'readonly-array', type: 'ReadonlyArray<LocalMode | string>' },
        { name: 'record', type: 'Record<string, LocalMode | number>' },
        { name: 'shape', type: '{ value: LocalMode | number }' }
      ]
      const evidence = await createFixture(format === 'web-types'
        ? { 'web-types.json': JSON.stringify({
            contributions: { html: { elements: [{ name: 'Choice', attributes }] } }
          }) }
        : format === 'vetur-tags'
          ? { 'tags.json': JSON.stringify({ Choice: { attributes } }) }
          : { 'attributes.json': JSON.stringify(Object.fromEntries(
              attributes.map(({ name, type }) => [`Choice/${name}`, { type }])
            )) },
      format === 'web-types'
        ? { 'web-types': './web-types.json' }
        : { vetur: format === 'vetur-tags' ? { tags: './tags.json' } : { attributes: './attributes.json' } })
      const contracts = await extractComponentLibraryContracts({ ...evidence, runtime: false })
      const contract = contracts.components.get('Choice')!
      const diagnose = (binding: string) => diagnoseComponentLibraryUsageResult({
        matches: [{
          usage: analyzeSourceText('/project/src/App.vue', `<template><Choice ${binding} /></template>`).components[0]!,
          library: evidence,
          contract,
          contracts
        }]
      })

      expect(contracts.problems).toEqual([])
      for (const name of ['opaque', 'union', 'reverse']) {
        expect(contract.props.entries.get(name), name).toEqual({ name })
        const result = diagnose(`${name}="invalid"`)
        expect(result.diagnostics, name).toEqual([])
        expect(result.skippedChecks, name).toEqual([expect.objectContaining({
          ruleCode: 'component-prop-type-mismatch',
          required: true,
          reason: 'missing-capability'
        })])
      }
      for (const name of ['any', 'unknown', 'any-union', 'unknown-union', 'text']) {
        expect(contract.props.entries.get(name)?.types, name).toEqual([{
          kind: name === 'text' ? 'string' : name.startsWith('any') ? 'any' : 'unknown'
        }])
        expect(diagnose(`${name}="invalid"`), name).toEqual({ diagnostics: [], skippedChecks: [] })
      }
      for (const name of ['count', 'literal', 'array', 'readonly-array', 'record', 'shape']) {
        const result = diagnose(`${name}="invalid"`)
        expect(result.skippedChecks, name).toEqual([])
        expect(result.diagnostics.map((diagnostic) => diagnostic.code), name).toEqual(['component-prop-type-mismatch'])
      }
      for (const name of ['array', 'readonly-array']) {
        expect(contract.props.entries.get(name)?.types, name).toEqual([{ kind: 'array' }])
        expect(diagnose(`:${name}="[]"`), name).toEqual({ diagnostics: [], skippedChecks: [] })
      }
      for (const name of ['record', 'shape']) {
        expect(contract.props.entries.get(name)?.types, name).toEqual([{ kind: 'object' }])
        expect(diagnose(`:${name}="{}"`), name).toEqual({ diagnostics: [], skippedChecks: [] })
      }
    }
  )

  test('does not narrow opaque Web Types alternatives through type value or enum fields', async () => {
    const attributes = [
      { name: 'list', type: ['string', 'LocalMode'] },
      { name: 'reverse', type: ['LocalMode', 'number'] },
      { name: 'nested', type: { type: ['string', 'LocalMode'] } },
      { name: 'value', value: { type: ['LocalMode', 'number'] } },
      { name: 'kind', value: { kind: 'LocalMode' } },
      { name: 'combined', type: 'string', value: { type: 'LocalMode' } },
      { name: 'values', type: 'LocalMode', values: ['valid'] },
      { name: 'enum', type: 'LocalMode', enum: ['valid'] }
    ]
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: { html: { elements: [{
          name: 'Choice',
          attributes: [
            ...attributes,
            { name: 'any', type: ['LocalMode', 'any'] },
            { name: 'unknown', value: { type: ['unknown', 'LocalMode'] } },
            { name: 'array', value: { kind: 'array', items: { type: 'LocalMode' } } }
          ]
        }] } }
      })
    }, { 'web-types': './web-types.json' })
    const contracts = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const contract = contracts.components.get('Choice')!

    expect(contracts.problems).toEqual([])
    for (const { name } of attributes) {
      expect(contract.props.entries.get(name), name).toEqual({ name })
      const usage = analyzeSourceText('/project/src/App.vue', `<template><Choice ${name}="invalid" /></template>`).components[0]!
      const result = diagnoseComponentLibraryUsageResult({ matches: [{ usage, library: evidence, contract, contracts }] })
      expect(result.diagnostics, name).toEqual([])
      expect(result.skippedChecks, name).toEqual([expect.objectContaining({
        ruleCode: 'component-prop-type-mismatch', required: true, reason: 'missing-capability'
      })])
    }
    expect(contract.props.entries.get('any')?.types).toEqual([{ kind: 'any' }])
    expect(contract.props.entries.get('unknown')?.types).toEqual([{ kind: 'unknown' }])
    expect(contract.props.entries.get('array')?.types).toEqual([{ kind: 'array' }])
    const usage = analyzeSourceText('/project/src/App.vue', '<template><Choice any="invalid" unknown="invalid" :array="[]" /></template>').components[0]!
    expect(diagnoseComponentLibraryUsageResult({ matches: [{ usage, library: evidence, contract, contracts }] })).toEqual({
      diagnostics: [], skippedChecks: []
    })
  })

  test('does not narrow opaque Vetur options or normalized prop alternatives', async () => {
    const evidence = await createFixture({
      'attributes.json': JSON.stringify({
        'Choice/options': { type: 'LocalMode', options: ['valid'] },
        'Choice/alias': { type: 'LocalMode' },
        'Choice/:alias': { type: 'number' },
        'Choice/reverse': { type: 'number' },
        'Choice/:reverse': { type: 'LocalMode' },
        'Choice/any': { type: 'LocalMode' },
        'Choice/:any': { type: 'any' },
        'Choice/known': { options: ['valid'] }
      })
    }, { vetur: { attributes: './attributes.json' } })
    const contracts = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const contract = contracts.components.get('Choice')!

    expect(contracts.problems).toEqual([])
    for (const name of ['options', 'alias', 'reverse']) {
      expect(contract.props.entries.get(name), name).toEqual({ name })
      const usage = analyzeSourceText('/project/src/App.vue', `<template><Choice ${name}="invalid" /></template>`).components[0]!
      const result = diagnoseComponentLibraryUsageResult({ matches: [{ usage, library: evidence, contract, contracts }] })
      expect(result.diagnostics, name).toEqual([])
      expect(result.skippedChecks, name).toEqual([expect.objectContaining({
        ruleCode: 'component-prop-type-mismatch', required: true, reason: 'missing-capability'
      })])
    }
    expect(contract.props.entries.get('any')?.types).toEqual([{ kind: 'any' }])
    expect(contract.props.entries.get('known')?.types).toEqual([{ kind: 'literal', value: 'valid' }])
    const usage = analyzeSourceText('/project/src/App.vue', '<template><Choice any="invalid" known="invalid" /></template>').components[0]!
    const result = diagnoseComponentLibraryUsageResult({ matches: [{ usage, library: evidence, contract, contracts }] })
    expect(result.skippedChecks).toEqual([])
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['component-prop-type-mismatch'])
  })
})

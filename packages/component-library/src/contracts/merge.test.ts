import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { serialize } from 'node:v8'
import { createVueDoctorCacheKey, writeVueDoctorCache } from '@daguanren21/vue-doctor-core'
import { version as typeScriptVersion } from 'typescript-native'
import { afterEach, describe, expect, test } from 'vitest'
import { createComponentLibraryEvidence } from '../evidence.js'
import type {
  ComponentContract,
  ComponentContractMap,
  ContractDimension,
  ContractProvenance,
  PropContract,
  PropTypeDescriptor
} from './types.js'
import {
  extractComponentLibraryContracts,
  extractComponentLibraryContractsWithReaders,
  mergeComponentContractMaps
} from './merge.js'
import { createContractCacheKey, readContractCache } from './cache.js'

const fixtureRoots: string[] = []
// Inferred native TypeScript projects have no fingerprintable config and bypass persistence.
const persistentDeclarationConfig = JSON.stringify({ compilerOptions: { noEmit: true }, files: ['index.d.ts'] })

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createFixture(
  files: Record<string, string>,
  packageJson: Record<string, unknown>
) {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-merge-'))
  const packageRoot = join(root, 'node_modules/example-ui')
  fixtureRoots.push(root)

  await mkdir(packageRoot, { recursive: true })
  await writeJson(join(root, 'package.json'), {
    dependencies: { 'example-ui': '1.2.3' }
  })
  await writeJson(join(packageRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    ...packageJson
  })

  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(packageRoot, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, 'utf8')
  }

  const exportsField = packageJson.exports
  const observedSubpaths = exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)
    ? Object.keys(exportsField).filter((key) => key !== '.')
    : []
  return createComponentLibraryEvidence({
    package: {
      dependencyName: 'example-ui',
      canonicalName: 'example-ui',
      declaredVersion: '1.2.3',
      installedVersion: '1.2.3',
      packageJsonPath: join(packageRoot, 'package.json'),
      packageRoot,
      importRoots: ['example-ui'],
      source: 'installed'
    },
    observedSubpaths
  })
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function dimension<T>(
  knowledge: ContractDimension<T>['knowledge'],
  entries: Array<[string, T]> = [],
  acceptance: ContractDimension<T>['acceptance'] = 'unknown',
  issues: ContractDimension<T>['issues'] = []
): ContractDimension<T> {
  return { knowledge, acceptance, entries: new Map(entries), issues }
}

function provenance(source: ContractProvenance['source']): ContractProvenance {
  return {
    source,
    path: `/${source}.json`,
    relativePath: `${source}.json`
  }
}

function contract(
  name: string,
  source: ContractProvenance['source'],
  overrides: Partial<ComponentContract> = {}
): ComponentContract {
  return {
    name,
    aliases: [],
    props: dimension('unknown'),
    events: dimension('unknown'),
    slots: dimension('unknown'),
    fallthrough: { attributes: 'unknown', listeners: 'unknown' },
    sources: [provenance(source)],
    ...overrides
  }
}

function contractMap(...contracts: ComponentContract[]): ComponentContractMap {
  return {
    components: new Map(contracts.map((item) => [item.name, item])),
    sources: contracts.flatMap((item) => item.sources),
    problems: []
  }
}

describe('component contract extraction', () => {
  test('keeps metadata contracts when declaration extraction rejects', async () => {
    const evidence = await createFixture({
      'index.d.ts': 'export {}\n',
      'secondary.d.ts': 'export {}\n'
    }, {
      exports: {
        '.': { types: './index.d.ts' },
        './secondary': { types: './secondary.d.ts' }
      }
    })
    const metadata = contractMap(contract('MetadataButton', 'web-types', {
      props: dimension('known', [['label', { name: 'label' }]])
    }))
    const metadataResults = [metadata]

    const result = await extractComponentLibraryContractsWithReaders(evidence, {
      readMetadata: async () => metadataResults,
      readDeclarations: async () => {
        throw new Error('declaration traversal failed')
      }
    })

    expect(result.components.get('MetadataButton')?.props.entries.has('label')).toBe(true)
    expect(result.sources.filter((source) => source.source === 'typescript')).toEqual(
      evidence.artifacts.declarationEntries.map((entry) => ({
        source: 'typescript',
        path: entry.path,
        relativePath: entry.relativePath
      }))
    )
    expect(result.problems.map((problem) => problem.path)).toEqual(
      evidence.artifacts.declarationEntries.map((entry) => entry.path)
    )
    expect(result.problems.every((problem) => (
      problem.message.includes('declaration traversal failed')
    ))).toBe(true)
    expect(metadataResults).toEqual([metadata])
  })

  test('augments metadata slots with published SFC slot outlets', async () => {
    const evidence = await createFixture({}, {})
    const metadata = contractMap(contract('ElTable', 'web-types', {
      slots: dimension('known', [['append', { name: 'append' }]], 'closed')
    }))
    const runtimeSource = provenance('runtime')

    const result = await extractComponentLibraryContractsWithReaders(evidence, {
      readMetadata: async () => [metadata],
      readDeclarations: async () => contractMap(),
      readRuntime: async () => ({
        components: new Map(),
        props: new Map(),
        events: new Map(),
        vue2Models: new Map(),
        slots: new Map([['ElTable', new Map([
          ['append', { name: 'append' }],
          ['default', { name: 'default' }],
          ['empty', { name: 'empty' }]
        ])]]),
        dynamicSlots: new Set(),
        componentSources: new Map([['ElTable', [runtimeSource]]]),
        sources: [runtimeSource],
        problems: []
      })
    })

    expect([...result.components.get('ElTable')!.slots.entries.keys()]).toEqual([
      'append',
      'default',
      'empty'
    ])
  })

  test('adds published interaction evidence only when enabled and preserves unknown boundaries', async () => {
    const evidence = await createFixture({
      'index.mjs': 'export {}',
      'web-types.json': JSON.stringify({
        contributions: { html: { 'vue-components': [{ name: 'ExampleInput', props: [{ name: 'value' }] }] } }
      }),
      'input.vue': `<script>
export default { name: 'ExampleInput', props: ['value'], methods: { change(value) { this.$emit('input', value) } } }
</script><template><input @change="$emit('change', $event)" /></template>`
    }, { main: './index.mjs', 'web-types': './web-types.json' })
    const disabled = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const enabled = await extractComponentLibraryContracts({ ...evidence, runtime: true })
    const contract = enabled.components.get('ExampleInput')!
    expect(disabled.components.get('ExampleInput')?.events.entries.has('input')).toBe(false)
    expect(disabled.components.get('ExampleInput')?.vue2Model).toBeUndefined()
    expect([...contract.events.entries.keys()].sort()).toEqual(['change', 'input'])
    expect(contract.events).toMatchObject({ knowledge: 'partial', acceptance: 'unknown' })
    expect(contract.events.entries.get('input')?.signatures).toEqual([])
    expect(contract.vue2Model).toEqual({ prop: 'value', event: 'input' })
    expect(contract.sources.map(source => source.relativePath)).toContain('input.vue')
  })

  test('continues to declarations when metadata is empty', async () => {
    const evidence = await createFixture({
      'web-types.json': '{ "contributions": { "html": { "elements": [] } } }\n',
      'index.d.ts': `
export declare const ExampleButton: {
  new (): { $props: { label?: string } }
}
`
    }, {
      types: './index.d.ts',
      'web-types': './web-types.json'
    })

    const result = await extractComponentLibraryContracts(evidence)

    expect(result.components.get('ExampleButton')?.sources).toEqual([
      expect.objectContaining({ source: 'typescript' })
    ])
  })

  test.each(['_default', 'Component'])('keeps default-export declarations independent despite shared local name %s', async (localName) => {
    const evidence = await createFixture({
      'index.d.ts': `
export { default as Alpha, default as AlphaAlias } from './alpha'
export { default as Beta, default as BetaAlias } from './beta'
`,
      'alpha.d.ts': `declare const ${localName}: { new (): { $props: { alpha: string } } }; export default ${localName}`,
      'beta.d.ts': `declare const ${localName}: { new (): { $props: { beta: number } } }; export default ${localName}`
    }, { types: './index.d.ts' })

    const result = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const alpha = result.components.get('Alpha')!
    const beta = result.components.get('Beta')!

    expect(result.problems).toEqual([])
    expect(alpha).not.toBe(beta)
    expect(result.components.get('AlphaAlias')).toBe(alpha)
    expect(result.components.get('BetaAlias')).toBe(beta)
    expect([...alpha.props.entries.values()]).toEqual([
      { name: 'alpha', required: true, types: [{ kind: 'string' }] }
    ])
    expect([...beta.props.entries.values()]).toEqual([
      { name: 'beta', required: true, types: [{ kind: 'number' }] }
    ])
    expect(result.components.has(localName)).toBe(false)
  })

  test('keeps same-named declaration exports from separate modules independent', async () => {
    const evidence = await createFixture({
      'index.d.ts': `
export { Shared as Alpha } from './alpha'
export { Shared as Beta } from './beta'
`,
      'alpha.d.ts': 'export declare class Shared { $props: { alpha: string } }',
      'beta.d.ts': 'export declare class Shared { $props: { beta: number } }'
    }, { types: './index.d.ts' })

    const result = await extractComponentLibraryContracts({ ...evidence, runtime: false })

    expect(result.components.get('Alpha')).not.toBe(result.components.get('Beta'))
    expect([...result.components.get('Alpha')!.props.entries.keys()]).toEqual(['alpha'])
    expect([...result.components.get('Beta')!.props.entries.keys()]).toEqual(['beta'])
    expect(result.components.has('Shared')).toBe(false)
  })

  test('does not equate a source-local declaration name with another public export', async () => {
    const evidence = await createFixture({
      'index.d.ts': `
export { default as Alpha } from './alpha'
export declare class Beta { $props: { beta: number } }
`,
      'alpha.d.ts': 'declare class Beta { $props: { alpha: string } }; export default Beta'
    }, { types: './index.d.ts' })

    const result = await extractComponentLibraryContracts({ ...evidence, runtime: false })

    expect(result.components.get('Alpha')).not.toBe(result.components.get('Beta'))
    expect([...result.components.get('Alpha')!.props.entries.keys()]).toEqual(['alpha'])
    expect([...result.components.get('Beta')!.props.entries.keys()]).toEqual(['beta'])
  })

  test('resolves public aliases across declaration entrypoints by symbol identity', async () => {
    const evidence = await createFixture({
      'index.d.ts': "export { Button as Primary } from './button'",
      'secondary.d.ts': "export { Button as Secondary } from './button'",
      'button.d.ts': 'export declare class Button { $props: { label: string } }'
    }, {
      exports: {
        '.': { types: './index.d.ts' },
        './secondary': { types: './secondary.d.ts' }
      }
    })

    const result = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const primary = result.components.get('Primary')!

    expect(result.problems).toEqual([])
    expect(result.components.get('Secondary')).toBe(primary)
    expect(result.components.get('Button')).toBe(primary)
    expect([...primary.props.entries.values()]).toEqual([
      { name: 'label', required: true, types: [{ kind: 'string' }] }
    ])
  })

  test('preserves primitive identity and deterministic ordering in declaration literal unions', async () => {
    const evidence = await createFixture({
      'index.d.ts': `
type Numeric = '1' | 1
export declare class Choice {
  $props: {
    numeric: Numeric | '1' | 1
    reversed: 1 | '1'
    truth: 'true' | true
    falsity: false | 'false'
    ordinary: 'small' | 'large' | 'small'
    enabled: true | false
  }
}
`
    }, { types: './index.d.ts' })

    const result = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const props = result.components.get('Choice')!.props.entries

    expect(props.get('numeric')?.types).toEqual([
      { kind: 'literal', value: 1 },
      { kind: 'literal', value: '1' }
    ])
    expect(props.get('reversed')?.types).toEqual(props.get('numeric')?.types)
    expect(props.get('truth')?.types).toEqual([
      { kind: 'literal', value: true },
      { kind: 'literal', value: 'true' }
    ])
    expect(props.get('falsity')?.types).toEqual([
      { kind: 'literal', value: false },
      { kind: 'literal', value: 'false' }
    ])
    expect(props.get('ordinary')?.types).toEqual([
      { kind: 'literal', value: 'large' },
      { kind: 'literal', value: 'small' }
    ])
    expect(props.get('enabled')?.types).toEqual([{ kind: 'boolean' }])
  })

  test('classifies mutable readonly and aliased tuple props as arrays', async () => {
    const evidence = await createFixture({
      'index.d.ts': `
type Pair = readonly [label: string, count?: number]
export declare class Tuples {
  $props: {
    mutable: [string, number]
    readonly: readonly [string, number]
    aliased: Pair
    variadic: [string, ...number[]]
    empty: readonly []
    array: string[]
    readonlyArray: ReadonlyArray<string>
    object: { label: string }
  }
}
`
    }, { types: './index.d.ts' })

    const result = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const props = result.components.get('Tuples')!.props.entries

    for (const name of ['mutable', 'readonly', 'aliased', 'variadic', 'empty', 'array', 'readonlyArray']) {
      expect(props.get(name)?.types, name).toEqual([{ kind: 'array' }])
    }
    expect(props.get('object')?.types).toEqual([{ kind: 'object' }])
  })

  test('expands aliased event tuple rest payloads without losing optional or variadic arity', async () => {
    const evidence = await createFixture({
      'index.d.ts': `
type Payload = [value: string, index?: number]
type Repeated = [value: string, ...tail: number[]]
export declare class Stream {
  $emit: {
    (event: 'change', prefix: string, ...args: Payload): void
    (event: 'many', prefix: string, ...args: Repeated): void
  }
}
`
    }, { types: './index.d.ts' })

    const result = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const events = result.components.get('Stream')!.events.entries

    expect(events.get('change')?.signatures).toEqual([{
      parameters: [
        { name: 'prefix', optional: false, rest: false },
        { name: undefined, optional: false, rest: false },
        { name: undefined, optional: true, rest: false }
      ],
      minArity: 2,
      maxArity: 3
    }])
    expect(events.get('many')?.signatures).toEqual([{
      parameters: [
        { name: 'prefix', optional: false, rest: false },
        { name: undefined, optional: false, rest: false },
        { name: undefined, optional: false, rest: true }
      ],
      minArity: 2,
      maxArity: null
    }])
  })


  test('preserves mixed primitive literals in public script-setup contracts', async () => {
    const evidence = await createFixture({
      'index.mjs': "export { default as Choice } from './Choice.vue'",
      'Choice.vue': `<script setup lang="ts">
type Label = string
defineProps<{
  numeric: '1' | 1 | '1' | 1
  truth: 'true' | true | 'true' | true
  falsity: false | 'false'
  pair: [string, number]
  enabled: boolean
  alias: Label
  mixed: 1 | Label
  unrestricted: any | Label
}>()
</script><template><div /></template>`
    }, { main: './index.mjs' })

    const result = await extractComponentLibraryContracts(evidence)
    const props = result.components.get('Choice')!.props.entries

    expect(result.problems).toEqual([])
    expect(props.get('numeric')?.types).toEqual([
      { kind: 'literal', value: '1' },
      { kind: 'literal', value: 1 }
    ])
    expect(props.get('truth')?.types).toEqual([
      { kind: 'literal', value: 'true' },
      { kind: 'literal', value: true }
    ])
    expect(props.get('falsity')?.types).toEqual([
      { kind: 'literal', value: false },
      { kind: 'literal', value: 'false' }
    ])
    expect(props.get('pair')?.types).toEqual([{ kind: 'array' }])
    expect(props.get('enabled')?.types).toEqual([{ kind: 'boolean' }])
    expect(props.get('alias')?.types).toEqual([{ kind: 'string' }])
    expect(props.get('mixed')?.types?.map(type => type.kind).sort()).toEqual(['number', 'string'])
    expect(props.get('unrestricted')?.types).toEqual([{ kind: 'any' }])
  })

  test.each([
    {
      name: 'typed macro overrides the whole ordinary props option', lang: 'ts',
      setup: "defineProps<{ mode: 'ready' | 'busy' }>()",
      expected: [['mode', { name: 'mode', required: true, types: [
        { kind: 'literal', value: 'busy' }, { kind: 'literal', value: 'ready' }
      ] }]]
    },
    {
      name: 'destructuring aliases are not public prop names', lang: 'ts',
      setup: "const { mode: localMode } = defineProps<{ mode: 'ready' | 'busy' }>()",
      expected: [['mode', { name: 'mode', required: true, types: [
        { kind: 'literal', value: 'busy' }, { kind: 'literal', value: 'ready' }
      ] }]]
    },
    {
      name: 'JavaScript Object.assign output replaces ordinary props', lang: 'js',
      setup: 'defineProps({ mode: { type: String, required: true } })',
      expected: [['mode', { name: 'mode', required: true, types: [{ kind: 'string' }] }]]
    },
    {
      name: 'an explicit empty runtime option removes ordinary props', lang: 'js',
      setup: 'defineProps({})',
      expected: []
    },
    {
      name: 'an empty type generates no replacement option', lang: 'ts',
      setup: 'defineProps<{}>()',
      expected: [
        ['mode', { name: 'mode', required: false, types: [{ kind: 'number' }] }],
        ['obsolete', { name: 'obsolete', required: false, types: [{ kind: 'boolean' }] }]
      ]
    },
    {
      name: 'ordinary props remain when setup declares no props', lang: 'js',
      setup: 'const value = 1',
      expected: [
        ['mode', { name: 'mode', required: false, types: [{ kind: 'number' }] }],
        ['obsolete', { name: 'obsolete', required: false, types: [{ kind: 'boolean' }] }]
      ]
    },
    {
      name: 'compiler-supported decorators retain effective macro props', lang: 'ts',
      setup: "function mark(value: any) { return value }\n@mark\nclass Local {}\ndefineProps<{ mode: 'ready' | 'busy' }>()",
      expected: [['mode', { name: 'mode', required: true, types: [
        { kind: 'literal', value: 'busy' }, { kind: 'literal', value: 'ready' }
      ] }]]
    },
    {
      name: 'unavailable macro compilation does not restore ordinary props', lang: 'ts',
      setup: 'import type { Missing } from "./absent"; defineProps<Missing>()',
      expected: []
    }
  ] satisfies Array<{ name: string; lang: string; setup: string; expected: Array<[string, PropContract]> }>)('preserves effective mixed-script contracts: $name', async ({ lang, setup, expected }) => {
    const evidence = await createFixture({
      'index.mjs': "export { default as Choice } from './Choice.vue'",
      'Choice.vue': `<script lang="${lang}">
export default { props: { mode: Number, obsolete: Boolean } }
</script><script setup lang="${lang}">${setup}</script><template><div /></template>`
    }, { main: './index.mjs' })
    const result = await extractComponentLibraryContracts(evidence)
    expect(result.problems).toEqual([])
    expect(new Map(Array.from(result.components.get('Choice')!.props.entries, ([name, prop]) => (
      [name, { ...prop, types: new Set(prop.types) }] as const
    )))).toEqual(new Map(expected.map(([name, prop]) => (
      [name, { ...prop, types: new Set<PropTypeDescriptor>(prop.types) }] as const
    ))))
  })

  test('keeps runtime export identity through a logical package-root alias', async () => {
    const evidence = await createFixture({
      'index.mjs': "export { default as Choice } from './Choice.vue'",
      'Choice.vue': '<script setup lang="ts">defineProps<{ value: number }>()</script><template><div /></template>'
    }, { main: './index.mjs' })
    const physicalRoot = await realpath(evidence.package.packageRoot!)
    const aliasRoot = join(dirname(evidence.package.packageRoot!), 'ui-alias')
    await symlink(physicalRoot, aliasRoot, 'junction')
    const aliased = await createComponentLibraryEvidence({
      package: {
        ...evidence.package,
        packageRoot: aliasRoot,
        packageJsonPath: join(aliasRoot, 'package.json')
      }
    })
    const expected = await extractComponentLibraryContracts({
      ...evidence,
      package: {
        ...evidence.package,
        packageRoot: physicalRoot,
        packageJsonPath: join(physicalRoot, 'package.json')
      }
    })

    const actual = await extractComponentLibraryContracts(aliased)

    expect(actual).toEqual(expected)
    expect(actual.components.get('Choice')?.props.entries.get('value')?.types).toEqual([{ kind: 'number' }])
    expect(actual.sources.every(source => !source.relativePath.startsWith('..'))).toBe(true)
  })

  test('preserves mixed primitive literals across Web Types unions arrays and enums', async () => {
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: { html: { elements: [{
          name: 'Choice',
          attributes: [
            { name: 'numeric', type: "'1' | 1 | '1' | 1" },
            { name: 'truth', type: ["'true'", 'true', "'true'", 'true'] },
            { name: 'falsity', value: { type: "'false' | false" } },
            { name: 'enum', enum: ['1', 1, 'true', true, '1', 1] },
            { name: 'values', values: [{ value: 'true' }, { value: true }, { name: 'true' }, true] },
            { name: 'ordinary', type: 'string | string | number' }
          ]
        }] } }
      })
    }, { 'web-types': './web-types.json' })

    const result = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const props = result.components.get('Choice')!.props.entries

    expect(props.get('numeric')?.types).toEqual([
      { kind: 'literal', value: '1' }, { kind: 'literal', value: 1 }
    ])
    expect(props.get('truth')?.types).toEqual([
      { kind: 'literal', value: 'true' }, { kind: 'literal', value: true }
    ])
    expect(props.get('falsity')?.types).toEqual([
      { kind: 'literal', value: 'false' }, { kind: 'literal', value: false }
    ])
    expect(props.get('enum')?.types).toEqual([
      { kind: 'literal', value: '1' }, { kind: 'literal', value: 1 },
      { kind: 'literal', value: 'true' }, { kind: 'literal', value: true }
    ])
    expect(props.get('values')?.types).toEqual(props.get('truth')?.types)
    expect(props.get('ordinary')?.types).toEqual([{ kind: 'string' }, { kind: 'number' }])
  })

  test('preserves mixed primitive literals across Vetur tag types and attribute options', async () => {
    const evidence = await createFixture({
      'tags.json': JSON.stringify({
        Choice: { attributes: [{ name: 'tagValue', type: "'1' | 1 | '1'" }] }
      }),
      'attributes.json': JSON.stringify({
        'Choice/value': { type: "'true' | true", options: ['true', true] },
        'Choice/:value': { options: ['true', true, 'false', false] }
      })
    }, { vetur: { tags: './tags.json', attributes: './attributes.json' } })

    const result = await extractComponentLibraryContracts({ ...evidence, runtime: false })
    const props = result.components.get('Choice')!.props.entries

    expect(props.get('tagValue')?.types).toEqual([
      { kind: 'literal', value: '1' }, { kind: 'literal', value: 1 }
    ])
    expect(props.get('value')?.types).toEqual([
      { kind: 'literal', value: 'true' }, { kind: 'literal', value: true },
      { kind: 'literal', value: 'false' }, { kind: 'literal', value: false }
    ])
  })

  test('persists versioned metadata contracts across runs', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-cache-'))
    fixtureRoots.push(cacheDirectory)
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: {
          html: {
            elements: [{
              name: 'example-button',
              attributes: [{ name: 'label', type: 'string' }]
            }]
          }
        }
      })
    }, {
      'web-types': './web-types.json'
    })
    evidence.runtime = false
    evidence.cache = true
    evidence.cacheDirectory = cacheDirectory

    const first = await extractComponentLibraryContracts(evidence)
    const second = await extractComponentLibraryContracts(evidence)

    expect(second.components.get('ExampleButton')).toEqual(
      first.components.get('ExampleButton')
    )
    expect(await readdir(join(cacheDirectory, 'contracts-v2'))).toHaveLength(1)
  })

  test('does not reuse contract facts stored under analyzer version 6', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-cache-semantics-'))
    fixtureRoots.push(cacheDirectory)
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: { html: { elements: [{
          name: 'Choice',
          attributes: [{ name: 'value', type: "'1' | 1" }]
        }] } }
      })
    }, { 'web-types': './web-types.json' })
    evidence.runtime = false
    evidence.cache = true
    evidence.cacheDirectory = cacheDirectory

    const packageRoot = await realpath(evidence.package.packageRoot!)
    const packageJson = await realpath(evidence.package.packageJsonPath!)
    const legacyParts: Array<string | Uint8Array> = [
      '6',
      typeScriptVersion,
      process.versions.v8.split('.')[0] ?? '',
      `${packageRoot}\0${packageJson}`,
      evidence.package.dependencyName,
      evidence.package.canonicalName,
      evidence.package.declaredVersion ?? '',
      evidence.package.installedVersion!,
      [...evidence.package.importRoots].sort().join('\0')
    ]
    for (const path of [evidence.package.packageJsonPath!, evidence.artifacts.webTypes!.path].sort((a, b) => a.localeCompare(b))) {
      legacyParts.push(path, await readFile(path))
    }
    const legacyContracts = contractMap(contract('Choice', 'web-types', {
      props: dimension('known', [['value', { name: 'value', types: [{ kind: 'literal', value: '1' }] }]])
    }))
    await writeVueDoctorCache('contracts-v2', createVueDoctorCacheKey(legacyParts), serialize({
      format: 2,
      manifest: { dependencies: [], resolutionFingerprint: 'legacy' },
      contracts: legacyContracts
    }), cacheDirectory)

    const result = await extractComponentLibraryContracts(evidence)

    expect(result.components.get('Choice')?.props.entries.get('value')?.types).toEqual([
      { kind: 'literal', value: '1' }, { kind: 'literal', value: 1 }
    ])
  })

  test.each([
    { name: 'missing contract map fields', contracts: {} },
    { name: 'non-Map components', contracts: { components: {}, sources: [], problems: [] } },
    {
      name: 'non-Map prop entries',
      contracts: {
        components: new Map([['ExampleButton', {
          ...contract('ExampleButton', 'web-types'),
          props: { knowledge: 'known', acceptance: 'closed', entries: {}, issues: [] }
        }]]),
        sources: [],
        problems: []
      }
    },
    {
      name: 'invalid prop types',
      contracts: {
        components: new Map([['ExampleButton', {
          ...contract('ExampleButton', 'web-types'),
          props: {
            ...dimension('known'),
            entries: new Map([['label', { name: 'label', types: [{ kind: 'literal', value: {} }] }]])
          }
        }]]),
        sources: [],
        problems: []
      }
    },
    {
      name: 'invalid event signatures',
      contracts: {
        components: new Map([['ExampleButton', {
          ...contract('ExampleButton', 'web-types'),
          events: {
            ...dimension('known'),
            entries: new Map([['change', { name: 'change', source: 'emit', signatures: [{}] }]])
          }
        }]]),
        sources: [],
        problems: []
      }
    },
    {
      name: 'invalid slot entries',
      contracts: {
        components: new Map([['ExampleButton', {
          ...contract('ExampleButton', 'web-types'),
          slots: { ...dimension('known'), entries: new Map([['default', null]]) }
        }]]),
        sources: [],
        problems: []
      }
    },
    {
      name: 'invalid aliases',
      contracts: {
        components: new Map([['ExampleButton', { ...contract('ExampleButton', 'web-types'), aliases: null }]]),
        sources: [],
        problems: []
      }
    },
    {
      name: 'invalid provenance',
      contracts: { components: new Map(), sources: [null], problems: [] }
    }
  ])('reparses malformed binary contract cache payloads: $name', async ({ contracts }) => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-cache-corrupt-'))
    fixtureRoots.push(cacheDirectory)
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: { html: { elements: [{
          name: 'example-button',
          attributes: [{ name: 'label', required: true, type: 'string' }]
        }] } }
      })
    }, { 'web-types': './web-types.json' })
    evidence.runtime = false
    evidence.cache = true
    evidence.cacheDirectory = cacheDirectory
    const key = await createContractCacheKey(evidence)
    expect(key).toBeDefined()
    await writeVueDoctorCache('contracts-v2', key!, serialize({
      format: 2,
      manifest: { dependencies: [], resolutionFingerprint: 'corruption-probe' },
      contracts
    }), cacheDirectory)

    const result = await extractComponentLibraryContracts(evidence)

    expect(result.problems).toEqual([])
    expect([...result.components.get('ExampleButton')!.props.entries.values()]).toEqual([
      { name: 'label', required: true, types: [{ kind: 'string' }] }
    ])
    expect(await extractComponentLibraryContracts(evidence)).toEqual(result)
  })

  test('invalidates cached declarations when a transitive type dependency changes', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-cache-transitive-'))
    fixtureRoots.push(cacheDirectory)
    const evidence = await createFixture({
      'tsconfig.json': persistentDeclarationConfig,
      'index.d.ts': 'export { ExampleButton } from "./leaf"\n',
      'leaf.d.ts': 'export declare class ExampleButton { $props: { label: string } }\n'
    }, { types: './index.d.ts' })
    evidence.runtime = false
    evidence.cache = true
    evidence.cacheDirectory = cacheDirectory

    const first = await extractComponentLibraryContracts(evidence)
    const key = await createContractCacheKey(evidence)
    expect(await readContractCache(key!, cacheDirectory)).toEqual(first)
    first.components.get('ExampleButton')!.props.entries.delete('label')
    const hot = await extractComponentLibraryContracts(evidence)
    expect(hot.components.get('ExampleButton')?.props.entries.has('label')).toBe(true)

    await writeFile(
      join(evidence.package.packageRoot!, 'leaf.d.ts'),
      'export declare class ExampleButton { $props: { active: boolean } }\n',
      'utf8'
    )
    const invalidated = await extractComponentLibraryContracts(evidence)
    expect([...invalidated.components.get('ExampleButton')!.props.entries.keys()]).toEqual(['active'])
  })

  test('invalidates cached declarations when a missing resolution probe becomes available', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-cache-probe-'))
    fixtureRoots.push(cacheDirectory)
    const evidence = await createFixture({
      'tsconfig.json': persistentDeclarationConfig,
      'index.d.ts': 'export { ExampleButton } from "./leaf"\n'
    }, { types: './index.d.ts' })
    evidence.runtime = false
    evidence.cache = true
    evidence.cacheDirectory = cacheDirectory

    const missing = await extractComponentLibraryContracts(evidence)
    const key = await createContractCacheKey(evidence)
    expect(await readContractCache(key!, cacheDirectory)).toEqual(missing)
    expect(missing.components.has('ExampleButton')).toBe(false)

    await writeFile(
      join(evidence.package.packageRoot!, 'leaf.d.ts'),
      'export declare class ExampleButton { $props: { label: string } }\n',
      'utf8'
    )
    const resolved = await extractComponentLibraryContracts(evidence)
    expect(resolved.components.get('ExampleButton')?.props.entries.has('label')).toBe(true)
  })

  test('isolates concurrent and persistent cache results from caller mutations', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-cache-clone-'))
    fixtureRoots.push(cacheDirectory)
    const evidence = await createFixture({
      'tsconfig.json': persistentDeclarationConfig,
      'index.d.ts': 'export declare class ExampleButton { $props: { label: string } }\n'
    }, { types: './index.d.ts' })
    evidence.runtime = false
    evidence.cache = true
    evidence.cacheDirectory = cacheDirectory

    const concurrent = await Promise.all([
      extractComponentLibraryContracts(evidence),
      extractComponentLibraryContracts(evidence),
      extractComponentLibraryContracts(evidence)
    ])
    expect(concurrent[0]).toEqual(concurrent[1])
    expect(concurrent[1]).toEqual(concurrent[2])
    expect(new Set(concurrent.map(result => result.components)).size).toBe(3)
    const key = await createContractCacheKey(evidence)
    expect(await readContractCache(key!, cacheDirectory)).toEqual(concurrent[1])
    expect(concurrent[0]!.components.get('ExampleButton')?.props.entries.has('label')).toBe(true)
    concurrent[0]!.components.get('ExampleButton')!.props.entries.clear()
    expect(concurrent[1]!.components.get('ExampleButton')?.props.entries.has('label')).toBe(true)
    expect(concurrent[2]!.components.get('ExampleButton')?.props.entries.has('label')).toBe(true)

    const hot = await extractComponentLibraryContracts(evidence)
    expect(hot).toEqual(concurrent[1])
    hot.components.get('ExampleButton')!.props.entries.clear()
    expect(concurrent[1]!.components.get('ExampleButton')?.props.entries.has('label')).toBe(true)
    expect(await extractComponentLibraryContracts(evidence)).toEqual(concurrent[1])
  })

  test('does not cache package identities declared through a local workspace link', async () => {
    const evidence = await createFixture({
      'index.d.ts': 'export declare class ExampleButton { $props: {} }\n'
    }, { types: './index.d.ts' })
    evidence.runtime = false
    evidence.cache = true
    evidence.package.declaredVersion = 'workspace:*'

    expect(await createContractCacheKey(evidence)).toBeUndefined()
  })

  test('augments public contracts with runtime forwarding targets', async () => {
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: { html: { elements: [{ name: 'example-wrapper', attributes: [] }] } }
      }),
      'index.mjs': `
import { defineComponent, createBlock, mergeProps, unref } from 'vue'
import { InnerDialog } from './dialog.mjs'
export const ExampleWrapper = defineComponent({
  name: 'ExampleWrapper',
  setup() {
    return (_ctx) => createBlock(unref(InnerDialog), mergeProps(_ctx.$attrs, {}))
  }
})
`
    }, {
      exports: { '.': { import: './index.mjs' } },
      'web-types': './web-types.json'
    })

    const result = await extractComponentLibraryContracts(evidence)

    expect(result.components.get('ExampleWrapper')?.fallthrough).toMatchObject({
      attributes: 'unknown',
      attributeTargets: [{ kind: 'component', name: 'InnerDialog' }]
    })
  })

  test('skips runtime source analysis when the Doctor Run requests metadata mode', async () => {
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: { html: { elements: [{ name: 'example-wrapper', attributes: [] }] } }
      }),
      'index.mjs': `
import { defineComponent, createBlock, mergeProps, unref } from 'vue'
import { InnerDialog } from './dialog.mjs'
export const ExampleWrapper = defineComponent({
  name: 'ExampleWrapper',
  setup() {
    return (_ctx) => createBlock(unref(InnerDialog), mergeProps(_ctx.$attrs, {}))
  }
})
`
    }, {
      exports: { '.': { import: './index.mjs' } },
      'web-types': './web-types.json'
    })
    evidence.runtime = false

    const result = await extractComponentLibraryContracts(evidence)

    expect(result.components.get('ExampleWrapper')?.fallthrough.attributeTargets).toEqual([])
    expect(result.sources.some((source) => source.source === 'runtime')).toBe(false)
  })

  test('augments public contracts with statically published SFC props and provenance', async () => {
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: { html: { elements: [{ name: 'published-input', attributes: [] }] } }
      }),
      'index.mjs': 'export {}\n',
      'PublishedInput.vue': `
<script setup lang="ts">
defineProps<{ runtimeOnly?: string }>()
</script>
<template><input /></template>
`
    }, {
      exports: { '.': { import: './index.mjs' } },
      'web-types': './web-types.json'
    })

    const result = await extractComponentLibraryContracts(evidence)
    const input = result.components.get('PublishedInput')

    expect(input?.props.entries.has('runtimeOnly')).toBe(true)
    expect(input?.props.knowledge).toBe('known')
    expect(input?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'runtime', relativePath: 'PublishedInput.vue' })
    ]))
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'runtime', relativePath: 'PublishedInput.vue' })
    ]))
  })

  test('preserves structured Web Types aliases, dimensions, and event payload parameters', async () => {
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: {
          html: {
            elements: [{
              name: 'example-button',
              attributes: [],
              events: [{
                name: 'change',
                arguments: ['value', { name: 'event' }, { id: 'context' }]
              }]
            }]
          }
        }
      })
    }, {
      'web-types': './web-types.json'
    })

    const result = await extractComponentLibraryContracts(evidence)
    const button = result.components.get('ExampleButton')

    expect(button?.aliases).toContain('example-button')
    expect(button?.props).toMatchObject({ knowledge: 'known', acceptance: 'unknown', entries: new Map() })
    expect(button?.events.entries.get('change')?.signatures[0]?.parameters).toEqual([
      { name: 'value', optional: false, rest: false },
      { name: 'event', optional: false, rest: false },
      { name: 'context', optional: false, rest: false }
    ])
    expect(button?.events.knowledge).toBe('known')
    expect(button?.slots.knowledge).toBe('unknown')
    expect(button?.sources).toEqual([
      expect.objectContaining({ source: 'web-types', relativePath: 'web-types.json' })
    ])
  })

  test('merges declarations into both metadata aliases', async () => {
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: {
          html: {
            elements: [{ name: 'example-button', attributes: [] }]
          }
        }
      }),
      'index.d.ts': `
export declare const ExampleButton: {
  new (): {
    $props: {}
    $emit: (event: 'click') => void
  }
}
`
    }, {
      types: './index.d.ts',
      'web-types': './web-types.json'
    })

    const result = await extractComponentLibraryContracts(evidence)

    expect(result.components.get('ExampleButton')?.events.entries.has('click')).toBe(true)
    expect(result.components.get('example-button')?.events.entries.has('click')).toBe(true)
  })

  test('shares one canonical contract across a renamed export metadata alias chain', async () => {
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({
        contributions: {
          html: {
            elements: [{
              name: 'original-button',
              attributes: [{ name: 'metadata-prop' }]
            }]
          }
        }
      }),
      'index.d.ts': "export { OriginalButton as PublicButton } from './button'\n",
      'button.d.ts': `
export declare const OriginalButton: {
  new (): { $props: { declarationProp?: string } }
}
`
    }, {
      types: './index.d.ts',
      'web-types': './web-types.json'
    })

    const result = await extractComponentLibraryContracts(evidence)
    const canonical = result.components.get('original-button')

    expect(result.components.get('OriginalButton')).toBe(canonical)
    expect(result.components.get('PublicButton')).toBe(canonical)
    expect(new Set([canonical!.name, ...canonical!.aliases])).toEqual(new Set([
      'original-button',
      'OriginalButton',
      'PublicButton'
    ]))
    expect(canonical?.sources.map((source) => source.source)).toEqual([
      'web-types',
      'typescript'
    ])
  })

  test('preserves Vetur tag and attribute normalization', async () => {
    const evidence = await createFixture({
      'tags.json': JSON.stringify({
        'example-input': { attributes: [':model-value', { name: '@change' }] },
        'static-panel': { attributes: [] }
      }),
      'attributes.json': JSON.stringify({
        'example-input/clearable': {},
        'example-input/@clear': {}
      })
    }, {
      vetur: {
        tags: './tags.json',
        attributes: './attributes.json'
      }
    })

    const result = await extractComponentLibraryContracts(evidence)
    const input = result.components.get('ExampleInput')
    const panel = result.components.get('StaticPanel')

    expect([...input!.props.entries.keys()]).toEqual(expect.arrayContaining(['model-value', 'clearable']))
    expect([...input!.events.entries.keys()]).toEqual(expect.arrayContaining(['change', 'clear']))
    expect(input?.aliases).toContain('example-input')
    expect(panel?.props).toMatchObject({ knowledge: 'known', acceptance: 'unknown', entries: new Map() })
    expect(panel?.events).toMatchObject({ knowledge: 'known', acceptance: 'unknown', entries: new Map() })
    expect(panel?.slots.knowledge).toBe('unknown')
  })

  test('leaves events unknown for a prop-only Vetur attributes component', async () => {
    const evidence = await createFixture({
      'attributes.json': JSON.stringify({
        'example-input/clearable': {}
      })
    }, {
      vetur: { attributes: './attributes.json' }
    })

    const result = await extractComponentLibraryContracts(evidence)
    const input = result.components.get('ExampleInput')

    expect(input?.props.knowledge).toBe('known')
    expect(input?.props.entries.has('clearable')).toBe(true)
    expect(input?.events).toMatchObject({ knowledge: 'unknown', acceptance: 'unknown', entries: new Map() })
  })

  test('records malformed metadata and continues with other sources', async () => {
    const evidence = await createFixture({
      'web-types.json': '{ malformed',
      'tags.json': JSON.stringify({
        'fallback-panel': { attributes: ['enabled'] }
      }),
      'index.d.ts': `
export declare const DeclaredButton: {
  new (): { $props: { label?: string } }
}
`
    }, {
      types: './index.d.ts',
      'web-types': './web-types.json',
      vetur: { tags: './tags.json' }
    })

    const result = await extractComponentLibraryContracts(evidence)

    expect(result.components.has('FallbackPanel')).toBe(true)
    expect(result.components.has('DeclaredButton')).toBe(true)
    expect(result.problems).toEqual([
      expect.objectContaining({ path: evidence.artifacts.webTypes?.path })
    ])
  })

  test('records a missing metadata file without rejecting extraction', async () => {
    const evidence = await createFixture({
      'web-types.json': JSON.stringify({ contributions: { html: { elements: [] } } })
    }, {
      'web-types': './web-types.json'
    })
    await rm(evidence.artifacts.webTypes!.path)

    const result = await extractComponentLibraryContracts(evidence)

    expect(result.components.size).toBe(0)
    expect(result.problems).toEqual([
      expect.objectContaining({ path: evidence.artifacts.webTypes?.path })
    ])
  })
})

describe('component contract merging', () => {
  test('turns closed and open boundaries into unknown with an issue', () => {
    const closed = contractMap(contract('ExampleButton', 'typescript', {
      props: dimension('known', [['label', { name: 'label' }]], 'closed')
    }))
    const open = contractMap(contract('ExampleButton', 'web-types', {
      props: dimension('known', [['data-id', { name: 'data-id' }]], 'open')
    }))

    const props = mergeComponentContractMaps([closed, open]).components.get('ExampleButton')!.props

    expect(props.knowledge).toBe('unknown')
    expect(props.acceptance).toBe('unknown')
    expect(props.issues).toEqual([
      expect.objectContaining({ code: 'boundary-conflict' })
    ])
    expect(props.entries.has('label')).toBe(true)
    expect(props.entries.has('data-id')).toBe(true)
  })

  test('does not close a dimension when another source is unknown', () => {
    const closed = contractMap(contract('ExampleButton', 'typescript', {
      events: dimension('known', [['change', { name: 'change', signatures: [] , source: 'emit' }]], 'closed')
    }))
    const unknown = contractMap(contract('ExampleButton', 'web-types', {
      events: dimension('unknown', [], 'unknown')
    }))

    const events = mergeComponentContractMaps([closed, unknown]).components.get('ExampleButton')!.events

    expect(events.acceptance).toBe('unknown')
    expect(events.knowledge).toBe('unknown')
    expect(events.issues).toEqual([])
  })

  test('downgrades issues unless an independent complete source supplies the boundary', () => {
    const issue = { code: 'traversal-incomplete', message: 'A declaration branch failed.' }
    const incomplete = contractMap(contract('ExampleButton', 'typescript', {
      props: dimension('known', [['label', { name: 'label' }]], 'closed', [issue])
    }))

    const withoutRecovery = mergeComponentContractMaps([incomplete])
      .components.get('ExampleButton')!.props
    expect(withoutRecovery.knowledge).toBe('partial')
    expect(withoutRecovery.issues).toContainEqual(issue)

    const complete = contractMap(contract('ExampleButton', 'adapter', {
      props: dimension('known', [['label', { name: 'label' }]], 'closed')
    }))
    const recovered = mergeComponentContractMaps([incomplete, complete])
      .components.get('ExampleButton')!.props
    expect(recovered.knowledge).toBe('known')
    expect(recovered.acceptance).toBe('closed')
    expect(recovered.issues).toContainEqual(issue)
  })

  test('fills an unknown metadata dimension from declarations', () => {
    const webTypesWithoutEvents = contractMap(contract('ExampleButton', 'web-types', {
      props: dimension('known', [['label', { name: 'label' }]])
    }))
    const declarationsWithEvents = contractMap(contract('ExampleButton', 'typescript', {
      events: dimension('known', [['click', {
        name: 'click',
        signatures: [{ parameters: [{ name: 'event', optional: false, rest: false }], minArity: 1, maxArity: 1 }],
        source: 'emit'
      }]])
    }))

    const result = mergeComponentContractMaps([webTypesWithoutEvents, declarationsWithEvents])

    expect(result.components.get('ExampleButton')?.events.knowledge).toBe('known')
    expect(result.components.get('ExampleButton')?.events.entries.has('click')).toBe(true)
  })

  test('does not downgrade a known empty dimension to unknown', () => {
    const knownNoEvents = contractMap(contract('StaticPanel', 'web-types', {
      events: dimension('known')
    }))
    const unknownEvents = contractMap(contract('StaticPanel', 'typescript'))

    const result = mergeComponentContractMaps([knownNoEvents, unknownEvents])

    expect(result.components.get('StaticPanel')?.events.knowledge).toBe('known')
  })

  test('uses source priority, unions missing names, and marks same-name conflicts partial', () => {
    const declarations = contractMap(contract('ExampleButton', 'typescript', {
      events: dimension('known', [
        ['click', { name: 'click', signatures: [{ parameters: [{ name: 'typescriptEvent', optional: false, rest: false }], minArity: 1, maxArity: 1 }], source: 'emit' }],
        ['focus', { name: 'focus', signatures: [{ parameters: [], minArity: 0, maxArity: 0 }], source: 'emit' }]
      ])
    }))
    const webTypes = contractMap(contract('ExampleButton', 'web-types', {
      events: dimension('known', [
        ['click', { name: 'click', signatures: [{ parameters: [{ name: 'webTypesEvent', optional: false, rest: false }], minArity: 1, maxArity: 1 }], source: 'metadata' }]
      ])
    }))

    const result = mergeComponentContractMaps([declarations, webTypes])
    const events = result.components.get('ExampleButton')?.events

    expect(events?.knowledge).toBe('known')
    expect(events?.entries.get('click')?.signatures.length).toBe(2)
    expect(events?.entries.has('focus')).toBe(true)
  })

  test('preserves an extractor-reported partial dimension', () => {
    const incomplete = contractMap(contract('ExampleButton', 'typescript', {
      slots: dimension('partial', [['default', { name: 'default' }]])
    }))

    const result = mergeComponentContractMaps([incomplete])

    expect(result.components.get('ExampleButton')?.slots.knowledge).toBe('partial')
  })

  test('orders multi-source provenance by contract priority', () => {
    const result = mergeComponentContractMaps([
      contractMap(contract('ExampleButton', 'typescript')),
      contractMap(contract('ExampleButton', 'vetur-attributes')),
      contractMap(contract('ExampleButton', 'adapter')),
      contractMap(contract('ExampleButton', 'vetur-tags')),
      contractMap(contract('ExampleButton', 'web-types'))
    ])
    const expected = [
      'adapter',
      'web-types',
      'vetur-tags',
      'vetur-attributes',
      'typescript'
    ]

    expect(result.sources.map((source) => source.source)).toEqual(expected)
    expect(result.components.get('ExampleButton')?.sources.map((source) => source.source)).toEqual(expected)
  })
})

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createComponentLibraryEvidence } from '../evidence.js'
import type {
  ComponentContract,
  ComponentContractMap,
  ContractDimension,
  ContractProvenance
} from './types.js'
import {
  extractComponentLibraryContracts,
  extractComponentLibraryContractsWithReaders,
  getContractExtractionCacheStateForTests,
  mergeComponentContractMaps
} from './merge.js'
import { createContractCacheKey } from './cache.js'

const fixtureRoots: string[] = []

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

  test('invalidates cached declarations when a transitive type dependency changes', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-cache-transitive-'))
    fixtureRoots.push(cacheDirectory)
    const evidence = await createFixture({
      'index.d.ts': 'export { ExampleButton } from "./leaf"\n',
      'leaf.d.ts': 'export declare class ExampleButton { $props: { label: string } }\n'
    }, { types: './index.d.ts' })
    evidence.runtime = false
    evidence.cache = true
    evidence.cacheDirectory = cacheDirectory

    const first = await extractComponentLibraryContracts(evidence)
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
      'index.d.ts': 'export { ExampleButton } from "./leaf"\n'
    }, { types: './index.d.ts' })
    evidence.runtime = false
    evidence.cache = true
    evidence.cacheDirectory = cacheDirectory

    const missing = await extractComponentLibraryContracts(evidence)
    expect(missing.components.has('ExampleButton')).toBe(false)

    await writeFile(
      join(evidence.package.packageRoot!, 'leaf.d.ts'),
      'export declare class ExampleButton { $props: { label: string } }\n',
      'utf8'
    )
    const resolved = await extractComponentLibraryContracts(evidence)
    expect(resolved.components.get('ExampleButton')?.props.entries.has('label')).toBe(true)
  })

  test('returns isolated cold, concurrent, and hot contract maps without retaining completed inflight work', async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-cache-clone-'))
    fixtureRoots.push(cacheDirectory)
    const evidence = await createFixture({
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
    expect(new Set(concurrent.map((result) => result.components)).size).toBe(3)
    concurrent[0]!.components.get('ExampleButton')!.props.entries.clear()
    expect(concurrent[1]!.components.get('ExampleButton')?.props.entries.has('label')).toBe(true)

    for (let index = 0; index < 40; index++) {
      const hot = await extractComponentLibraryContracts(evidence)
      expect(hot).toEqual(concurrent[1])
    }
    expect(getContractExtractionCacheStateForTests()).toEqual({ size: 0, limit: 32 })
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

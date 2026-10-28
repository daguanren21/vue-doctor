import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { afterEach, expect, test } from 'vitest'
import { createComponentLibraryEvidence } from '../evidence.js'
import { createContractCacheKey, readContractCache } from './cache.js'
import { extractComponentLibraryContracts } from './merge.js'
import type { ComponentContractMap } from './types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const corruptionCases: Array<{ name: string; corrupt: (contracts: ComponentContractMap) => void }> = [
  { name: 'map provenance', corrupt: contracts => { contracts.sources = new Array(1) } },
  { name: 'map problems', corrupt: contracts => { contracts.problems = new Array(1) } },
  { name: 'component aliases', corrupt: contracts => { contracts.components.get('ExampleButton')!.aliases = new Array(1) } },
  { name: 'component provenance', corrupt: contracts => { contracts.components.get('ExampleButton')!.sources = new Array(1) } },
  { name: 'dimension issues', corrupt: contracts => { contracts.components.get('ExampleButton')!.props.issues = new Array(1) } },
  { name: 'prop types', corrupt: contracts => { contracts.components.get('ExampleButton')!.props.entries.get('label')!.types = new Array(1) } },
  ...[
    { name: 'missing literal value', type: { kind: 'literal' as const } },
    ...[NaN, Infinity, -Infinity].map(value => ({
      name: `non-finite literal ${value}`, type: { kind: 'literal' as const, value }
    }))
  ].map(({ name, type }) => ({
    name,
    corrupt: (contracts: ComponentContractMap) => {
      contracts.components.get('ExampleButton')!.props.entries.get('label')!.types = [type]
    }
  })),
  { name: 'forwarding targets', corrupt: contracts => { contracts.components.get('ExampleButton')!.fallthrough.attributeTargets = new Array(1) } },
  {
    name: 'forwarded exclusions',
    corrupt: contracts => {
      contracts.components.get('ExampleButton')!.fallthrough.attributeTargets = [{
        kind: 'element', name: 'button', file: 'Button.vue', excludedAttributes: new Array(1)
      }]
    }
  },
  {
    name: 'supported forwarded attributes',
    corrupt: contracts => {
      contracts.components.get('ExampleButton')!.fallthrough.attributeTargets = [{
        kind: 'element', name: 'button', file: 'Button.vue', supportedAttributes: new Array(1)
      }]
    }
  },
  {
    name: 'event signatures',
    corrupt: contracts => {
      contracts.components.get('ExampleButton')!.events.entries.set('change', {
        name: 'change', source: 'metadata', signatures: new Array(1)
      })
    }
  },
  {
    name: 'event parameters',
    corrupt: contracts => {
      contracts.components.get('ExampleButton')!.events.entries.set('change', {
        name: 'change', source: 'metadata',
        signatures: [{ parameters: new Array(1), minArity: 1, maxArity: 1 }]
      })
    }
  }
]

test.each(corruptionCases)('reextracts malformed binary cache $name and reuses the repaired value', async ({ corrupt }) => {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-corrupt-contract-cache-'))
  roots.push(root)
  const packageRoot = join(root, 'node_modules/example-ui')
  const cacheDirectory = join(root, 'cache')
  const packageJsonPath = join(packageRoot, 'package.json')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(packageJsonPath, JSON.stringify({
    name: 'example-ui', version: '1.0.0', 'web-types': './web-types.json'
  }))
  await writeFile(join(packageRoot, 'web-types.json'), JSON.stringify({
    contributions: { html: { elements: [{
      name: 'example-button', attributes: [{ name: 'label', required: true, type: 'string' }]
    }] } }
  }))
  const evidence = await createComponentLibraryEvidence({
    package: {
      dependencyName: 'example-ui', canonicalName: 'example-ui',
      declaredVersion: '1.0.0', installedVersion: '1.0.0',
      packageRoot, packageJsonPath, importRoots: ['example-ui'], source: 'installed'
    },
    runtime: false, cache: true, cacheDirectory
  })
  const expected = await extractComponentLibraryContracts(evidence)
  const key = await createContractCacheKey(evidence)
  expect(key).toBeDefined()
  const [namespace] = await readdir(cacheDirectory)
  const path = join(cacheDirectory, namespace!, `${key}.cache`)
  const payload: { contracts: ComponentContractMap } = deserialize(await readFile(path))
  corrupt(payload.contracts)
  await writeFile(path, serialize(payload))

  const repaired = await extractComponentLibraryContracts(evidence)

  expect(repaired).toEqual(expected)
  expect(repaired.components.get('ExampleButton')!.props.entries.get('label')).toEqual({
    name: 'label', required: true, types: [{ kind: 'string' }]
  })
  expect(await readContractCache(key!, cacheDirectory)).toEqual(expected)
  expect(await extractComponentLibraryContracts(evidence)).toEqual(expected)
})

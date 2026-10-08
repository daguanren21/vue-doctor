import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createComponentLibraryEvidence } from '../evidence.js'
import { readMetadataContracts, readVeturAttributesContracts, readVeturTagsContracts, readWebTypesContracts } from './metadata.js'

const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createMetadataFixture(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-contract-metadata-'))
  fixtureRoots.push(root)
  const packageRoot = join(root, 'node_modules/example-ui')
  const artifact = join(packageRoot, 'web-types.json')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { 'example-ui': '1.0.0' } }))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'example-ui', version: '1.0.0', 'web-types': './web-types.json' }))
  await writeFile(artifact, JSON.stringify(value))

  return createComponentLibraryEvidence({
    package: {
      dependencyName: 'example-ui',
      canonicalName: 'example-ui',
      declaredVersion: '1.0.0',
      installedVersion: '1.0.0',
      packageJsonPath: join(packageRoot, 'package.json'),
      packageRoot,
      importRoots: ['example-ui'],
      source: 'installed'
    },
    observedSubpaths: []
  })
}

describe('metadata contract boundaries', () => {
  test('keeps listed metadata entries partial because metadata does not assert completeness', async () => {
    const evidence = await createMetadataFixture({
      contributions: {
        html: {
          elements: [{
            name: 'example-button',
            attributes: [{ name: 'label' }],
            events: [{ name: 'change', arguments: ['value'] }]
          }]
        }
      }
    })

    const result = await readWebTypesContracts(evidence)
    const button = result.components.get('example-button')!

    expect(button.props.knowledge).toBe('known')
    expect(button.props.acceptance).toBe('unknown')
    expect(button.events.knowledge).toBe('known')
    expect(button.events.acceptance).toBe('unknown')
    expect(button.events.entries.get('change')).toMatchObject({
      name: 'change',
      source: 'metadata',
      signatures: [{
        parameters: [{ name: 'value', optional: false, rest: false }],
        minArity: 1,
        maxArity: 1
      }]
    })
    expect(button.fallthrough).toEqual({ attributes: 'unknown', listeners: 'unknown' })
  })

  test('distinguishes absent or unreadable payloads from explicitly zero-argument events', async () => {
    const evidence = await createMetadataFixture({
      contributions: { html: { elements: [{
        name: 'example-button',
        events: [
          { name: 'unresolved' },
          { name: 'invalid', arguments: ['before', {}, 'after'] },
          { name: 'ready', arguments: [] }
        ]
      }] } }
    })
    const result = await readWebTypesContracts(evidence)
    const events = result.components.get('example-button')!.events
    expect(events.knowledge).toBe('known')
    expect(events.entries.get('unresolved')).toMatchObject({ name: 'unresolved', signatures: [] })
    expect(events.entries.get('invalid')).toMatchObject({ name: 'invalid', signatures: [] })
    expect(events.entries.get('ready')?.signatures).toEqual([
      { parameters: [], minArity: 0, maxArity: 0 }
    ])
  })

  test('recovers slot names explicitly referenced by web-types descriptions', async () => {
    const evidence = await createMetadataFixture({
      contributions: {
        html: {
          elements: [{
            name: 'el-table',
            attributes: [{
              name: 'emptyText',
              description: 'Displayed when empty. Customize with `slot="empty"`.'
            }],
            slots: [{ name: 'append' }]
          }]
        }
      }
    })

    const result = await readWebTypesContracts(evidence)
    const table = result.components.get('el-table')!

    expect(table.slots.knowledge).toBe('known')
    expect([...table.slots.entries.keys()]).toEqual(['empty', 'append'])
  })

  test('reports malformed metadata as an issue instead of claiming a known dimension', async () => {
    const evidence = await createMetadataFixture({
      contributions: { html: { elements: [{ name: 'example-button', events: [{}] }] } }
    })
    const result = await readMetadataContracts(evidence)
    const button = result[0]!.components.get('example-button')!

    expect(button.events.knowledge).toBe('partial')
    expect(button.events.acceptance).toBe('unknown')
    expect(button.events.issues).toEqual([
      expect.objectContaining({ code: 'metadata-entry-invalid' })
    ])
  })

  test('extracts required flags, unions, and literal values from web-types attributes', async () => {
    const evidence = await createMetadataFixture({
      contributions: {
        html: {
          elements: [{
            name: 'example-input',
            attributes: [
              { name: 'model-value', required: true, type: 'string' },
              { name: 'size', type: ['string'], values: ['sm', 'md', 'lg'], default: 'md' },
              { name: 'disabled', type: 'boolean' },
              { name: 'count', type: 'number | string' },
              { name: 'placement', type: 'PopoverPlacement' }
            ]
          }]
        }
      }
    })

    const result = await readWebTypesContracts(evidence)
    const input = result.components.get('example-input')!

    expect(input.props.entries.get('model-value')).toEqual({
      name: 'model-value',
      required: true,
      types: [{ kind: 'string' }]
    })
    expect(input.props.entries.get('size')).toEqual({
      name: 'size',
      required: false,
      types: [
        { kind: 'string' },
        { kind: 'literal', value: 'sm' },
        { kind: 'literal', value: 'md' },
        { kind: 'literal', value: 'lg' }
      ]
    })
    expect(input.props.entries.get('disabled')).toEqual({
      name: 'disabled',
      types: [{ kind: 'boolean' }]
    })
    expect(input.props.entries.get('count')).toEqual({
      name: 'count',
      types: [{ kind: 'number' }, { kind: 'string' }]
    })
    expect(input.props.entries.get('placement')).toEqual({
      name: 'placement',
      types: [{ kind: 'unknown' }]
    })
  })

  test('extracts Vetur prop types without inventing event payload signatures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-vetur-attrs-'))
    fixtureRoots.push(root)
    const packageRoot = join(root, 'node_modules/example-ui')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { 'example-ui': '1.0.0' } }))
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'example-ui',
      version: '1.0.0',
      vetur: { tags: './tags.json', attributes: './attributes.json' }
    }))
    await writeFile(join(packageRoot, 'tags.json'), JSON.stringify({
      'example-button': { attributes: ['size', 'label', '@change'] }
    }))
    await writeFile(join(packageRoot, 'attributes.json'), JSON.stringify({
      'example-button/size': { type: "'small' | 'default' | 'large'", description: 'button size' },
      'example-button/label': { type: 'string', description: 'label text' },
      'example-button/count': { type: 'number | string' },
      'example-button/@change': { description: 'Emitted when changed.' }
    }))

    const evidence = await createComponentLibraryEvidence({
      package: {
        dependencyName: 'example-ui',
        canonicalName: 'example-ui',
        declaredVersion: '1.0.0',
        installedVersion: '1.0.0',
        packageJsonPath: join(packageRoot, 'package.json'),
        packageRoot,
        importRoots: ['example-ui'],
        source: 'installed'
      },
      observedSubpaths: []
    })

    const attributes = await readVeturAttributesContracts(evidence)
    const button = attributes.components.get('ExampleButton') ?? attributes.components.get('example-button')
    expect(button).toBeTruthy()
    expect(button!.props.entries.get('size')).toEqual({
      name: 'size',
      types: [
        { kind: 'literal', value: 'small' },
        { kind: 'literal', value: 'default' },
        { kind: 'literal', value: 'large' }
      ]
    })
    expect(button!.props.entries.get('label')).toEqual({
      name: 'label',
      types: [{ kind: 'string' }]
    })
    expect(button!.props.entries.get('count')).toEqual({
      name: 'count',
      types: [{ kind: 'number' }, { kind: 'string' }]
    })
    expect(button!.events.entries.get('change')).toMatchObject({ name: 'change', signatures: [] })
    const tags = await readVeturTagsContracts(evidence)
    expect(tags.components.get('ExampleButton')!.events.entries.get('change')).toMatchObject({
      name: 'change', signatures: []
    })
  })

})

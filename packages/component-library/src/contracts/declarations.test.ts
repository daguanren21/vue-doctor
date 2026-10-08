import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { API } from 'typescript/unstable/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createComponentLibraryEvidence } from '../evidence.js'
import {
  readTypeScriptContracts,
  readTypeScriptContractsWithCacheInputs
} from './declarations.js'

const fixtureRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createDeclarationFixture(
  files: Record<string, string>,
  packageJson: Record<string, unknown> = { types: './es/index.d.ts' }
) {
  const root = await mkdtemp(join(tmpdir(), 'vue-doctor-declarations-'))
  const packageRoot = join(root, 'node_modules/example-ui')
  fixtureRoots.push(root)

  await mkdir(join(packageRoot, 'es'), { recursive: true })
  await writeJson(join(root, 'package.json'), {
    dependencies: {
      'example-ui': '1.2.3'
    }
  })
  await writeJson(join(packageRoot, 'package.json'), {
    name: 'example-ui',
    version: '1.2.3',
    ...packageJson
  })

  for (const [relativePath, contents] of Object.entries(files)) {
    await mkdir(dirname(join(packageRoot, relativePath)), { recursive: true })
    await writeFile(join(packageRoot, relativePath), contents, 'utf8')
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

describe('TypeScript declaration contracts', () => {
  test('keeps listener-shaped props and uses $emit as authoritative event evidence', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const Calendar: {
  new (): {
    $props: {
      title?: string
      onChange?: (value: string) => void
    }
    $emit: {
      (event: 'change', value: string, index?: number): void
      (event: 'change', value: string): void
      (event: 'calendar-change'): void
    }
  }
}
`
    })

    const calendar = (await readTypeScriptContracts(evidence)).components.get('Calendar')!

    expect(calendar.props.entries.has('onChange')).toBe(true)
    expect(calendar.events.entries.get('change')).toEqual({
      name: 'change',
      signatures: [
        {
          parameters: [
            { name: 'value', optional: false, rest: false },
            { name: 'index', optional: true, rest: false }
          ],
          minArity: 1,
          maxArity: 2
        },
        {
          parameters: [
            { name: 'value', optional: false, rest: false }
          ],
          minArity: 1,
          maxArity: 1
        }
      ],
      source: 'emit'
    })
    expect(calendar.events.entries.get('calendar-change')).toEqual({
      name: 'calendar-change',
      signatures: [{ parameters: [], minArity: 0, maxArity: 0 }],
      source: 'emit'
    })
    expect(calendar.events.acceptance).toBe('closed')
  })

  test('captures required flags and prop value types from $props', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const Button: {
  new (): {
    $props: {
      label: string
      disabled?: boolean
      size?: 'sm' | 'md'
      count?: number
      items: string[]
    }
  }
}
`
    })

    const button = (await readTypeScriptContracts(evidence)).components.get('Button')!

    expect(button.props.entries.get('label')).toEqual({
      name: 'label',
      required: true,
      types: [{ kind: 'string' }]
    })
    expect(button.props.entries.get('disabled')).toEqual({
      name: 'disabled',
      required: false,
      types: [{ kind: 'boolean' }]
    })
    expect(button.props.entries.get('size')).toEqual({
      name: 'size',
      required: false,
      types: [
        { kind: 'literal', value: 'md' },
        { kind: 'literal', value: 'sm' }
      ]
    })
    expect(button.props.entries.get('count')).toEqual({
      name: 'count',
      required: false,
      types: [{ kind: 'number' }]
    })
    expect(button.props.entries.get('items')).toEqual({
      name: 'items',
      required: true,
      types: [{ kind: 'array' }]
    })
  })

  test('expands tuple rest payloads and represents unbounded rest arity', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const Picker: {
  new (): {
    $emit: {
      (event: 'change', ...args: [value: string, index?: number]): void
      (event: 'input', ...args: unknown[]): void
    }
  }
}
`
    })

    const picker = (await readTypeScriptContracts(evidence)).components.get('Picker')!

    expect(picker.events.entries.get('change')?.signatures).toEqual([{
      parameters: [
        { name: 'value', optional: false, rest: false },
        { name: 'index', optional: true, rest: false }
      ],
      minArity: 1,
      maxArity: 2
    }])
    expect(picker.events.entries.get('input')?.signatures).toEqual([{
      parameters: [{ name: 'args', optional: false, rest: true }],
      minArity: 0,
      maxArity: null
    }])
  })

  test('preserves fixed payload parameters before tuple and array rest parameters', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const Stream: {
  new (): {
    $emit: {
      (event: 'tuple', prefix: string, ...args: [value: string, index?: number]): void
      (event: 'array', prefix: string, ...args: unknown[]): void
    }
  }
}
`
    })

    const events = (await readTypeScriptContracts(evidence)).components.get('Stream')!.events

    expect(events.entries.get('tuple')?.signatures).toEqual([{
      parameters: [
        { name: 'prefix', optional: false, rest: false },
        { name: 'value', optional: false, rest: false },
        { name: 'index', optional: true, rest: false }
      ],
      minArity: 2,
      maxArity: 3
    }])
    expect(events.entries.get('array')?.signatures).toEqual([{
      parameters: [
        { name: 'prefix', optional: false, rest: false },
        { name: 'args', optional: false, rest: true }
      ],
      minArity: 1,
      maxArity: null
    }])
  })

  test('uses open, closed, and unknown emit boundaries from the event-name type', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const EmitBoundaries: {
  new (): {
    $emit: {
      (event: 'save' | 'cancel'): void
      (event: string): void
    }
  }
}

export declare const GenericEmit: {
  new (): { $emit: <T extends string>(event: T) => void }
}
`
    })

    const contracts = await readTypeScriptContracts(evidence)
    const open = contracts.components.get('EmitBoundaries')!.events
    const generic = contracts.components.get('GenericEmit')!.events

    expect([...open.entries.keys()]).toHaveLength(2)
    expect([...open.entries.keys()]).toEqual(expect.arrayContaining(['save', 'cancel']))
    expect(open.knowledge).toBe('known')
    expect(open.acceptance).toBe('open')
    expect(generic.knowledge).toBe('partial')
    expect(generic.acceptance).toBe('unknown')
    expect(generic.issues).toEqual([
      expect.objectContaining({ code: 'declaration-event-name-unresolved' })
    ])
  })

  test('adds listener-derived events only when no matching emit event exists', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const MixedEvents: {
  new (): {
    $props: {
      onChange?: (value: number) => void
      onClear?: () => void
    }
    $emit: (event: 'change', value: string) => void
  }
}
`
    })

    const events = (await readTypeScriptContracts(evidence)).components.get('MixedEvents')!.events

    expect(events.entries.get('change')?.source).toBe('emit')
    expect(events.entries.get('clear')?.source).toBe('listener-prop')
    expect(events.knowledge).toBe('partial')
    expect(events.acceptance).toBe('unknown')
  })

  test('preserves every overload from listener-prop declarations', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const OverloadedListener: {
  new (): {
    $props: {
      onChange?: {
        (value: string): void
        (value: string, index?: number): void
      }
    }
  }
}
`
    })

    const event = (await readTypeScriptContracts(evidence))
      .components.get('OverloadedListener')!.events.entries.get('change')!
    expect(event.signatures).toEqual([
      {
        parameters: [{ name: 'value', optional: false, rest: false }],
        minArity: 1,
        maxArity: 1
      },
      {
        parameters: [
          { name: 'value', optional: false, rest: false },
          { name: 'index', optional: true, rest: false }
        ],
        minArity: 1,
        maxArity: 2
      }
    ])
  })

  test('marks indexed props open and unresolved declaration types partial', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const OpenPanel: {
  new (): { $props: { [key: string]: unknown; title?: string } }
}

export declare const BrokenPanel: {
  new (): { $props: MissingProps }
}
`
    })

    const contracts = await readTypeScriptContracts(evidence)
    const open = contracts.components.get('OpenPanel')!
    const broken = contracts.components.get('BrokenPanel')!

    expect(open.props.acceptance).toBe('open')
    expect(open.props.knowledge).toBe('known')
    expect(broken.props.knowledge).toBe('partial')
    expect(broken.props.acceptance).toBe('unknown')
    expect(broken.props.issues).toEqual([
      expect.objectContaining({ code: 'declaration-type-unresolved' })
    ])
  })

  test('follows public re-exports and extracts props, overloaded emits, and entry provenance', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export { ExampleButton } from './button'
`,
      'es/button.d.ts': `
export declare const ExampleButton: {
  new (): {
    $props: {
      disabled?: boolean
      size?: 'small' | 'large'
      onClick?: (event: MouseEvent) => void
    }
    $emit: {
      (event: 'click', value: MouseEvent): void
      (event: 'change', value: string): void
    }
  }
}
`
    })

    const contracts = await readTypeScriptContracts(evidence)
    const button = contracts.components.get('ExampleButton')

    expect([...button!.props.entries.keys()]).toEqual(expect.arrayContaining(['disabled', 'size']))
    expect([...button!.events.entries.keys()]).toEqual(expect.arrayContaining(['click', 'change']))
    expect(button?.events.entries.get('change')?.signatures[0]?.parameters).toEqual([
      { name: 'value', optional: false, rest: false }
    ])
    expect(button?.props.knowledge).toBe('known')
    expect(button?.events.knowledge).toBe('known')
    expect(button?.slots.knowledge).toBe('unknown')
    expect(button?.sources).toEqual([
      expect.objectContaining({
        source: 'typescript',
        relativePath: 'es/index.d.ts',
        path: evidence.artifacts.declarationEntries[0]?.path
      })
    ])
    expect(contracts.sources).toEqual(button?.sources)
    expect(contracts.problems).toEqual([])
  })

  test('tracks transitive declarations, resolution probes, and compiler configuration for cache validation', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': 'export { ExampleButton } from "./button"\n',
      'es/button.d.ts': 'export declare class ExampleButton { $props: { label: string } }\n'
    })

    const result = await readTypeScriptContractsWithCacheInputs(evidence)
    expect(result.cacheInputs.reliable).toBe(true)
    expect(result.cacheInputs.files).toContain(evidence.artifacts.declarationEntries[0]!.path)
    expect(result.cacheInputs.files.some((path) => path.endsWith('/es/button.d.ts'))).toBe(true)
    expect(result.cacheInputs.fileProbes.length + result.cacheInputs.directoryProbes.length).toBeGreaterThan(0)
    expect(result.cacheInputs.resolutions).toEqual([
      expect.stringContaining('compilerOptions')
    ])
  })

  test('converts listener props to kebab-case events and excludes Vue built-in props', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const ExampleInput: {
  new (): {
    $props: {
      key?: string
      ref?: unknown
      ref_for?: boolean
      ref_key?: string
      class?: unknown
      style?: unknown
      modelValue?: string
      onUpdateModelValue?: (value: string) => void
    }
  }
}
`
    })

    const contracts = await readTypeScriptContracts(evidence)
    const input = contracts.components.get('ExampleInput')

    expect([...input!.props.entries.keys()]).toEqual(['modelValue', 'onUpdateModelValue'])
    expect([...input!.events.entries.keys()]).toEqual(['update-model-value'])
    expect(input?.events.entries.get('update-model-value')?.signatures[0]?.parameters).toEqual([
      { name: 'value', optional: false, rest: false }
    ])
    expect(input?.props.knowledge).toBe('known')
    expect(input?.events.knowledge).toBe('partial')
  })

  test('preserves unknown dimensions separately from known empty dimensions', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const PropsOnly: {
  new (): {
    $props: {}
  }
}

export declare const EmptyContracts: {
  new (): {
    $props: {}
    $emit: (event: string) => void
  }
}
`
    })

    const contracts = await readTypeScriptContracts(evidence)
    const propsOnly = contracts.components.get('PropsOnly')
    const empty = contracts.components.get('EmptyContracts')

    expect(propsOnly?.props).toMatchObject({ knowledge: 'known' })
    expect(propsOnly?.props.entries.size).toBe(0)
    expect(propsOnly?.events).toMatchObject({ knowledge: 'unknown' })
    expect(empty?.props).toMatchObject({ knowledge: 'known' })
    expect(empty?.events).toMatchObject({ knowledge: 'known' })
    expect(empty?.events.entries.size).toBe(0)
    expect(empty?.events.acceptance).toBe('open')
  })

  test('uses a renamed re-export as the public name and retains the original alias', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export { OriginalButton as PublicButton } from './button'
`,
      'es/button.d.ts': `
export declare const OriginalButton: {
  new (): { $props: { label?: string } }
}
`
    })

    const contracts = await readTypeScriptContracts(evidence)
    const button = contracts.components.get('PublicButton')

    expect(button).toMatchObject({
      name: 'PublicButton',
      aliases: ['OriginalButton']
    })
    expect(contracts.components.has('OriginalButton')).toBe(false)
  })

  test('unwraps a generic intersection wrapper around a Vue component constructor', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
type Installable<T> = T & { install(app: unknown): void }

export declare const WrappedInput: Installable<{
  new (): { $props: { modelValue?: string } }
}>
`
    })

    const contracts = await readTypeScriptContracts(evidence)

    expect([...contracts.components.get('WrappedInput')!.props.entries.keys()]).toEqual(['modelValue'])
  })

  test('rejects constructible exports without Vue instance markers', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const ExampleService: {
  new (): { run(): void }
}
`
    })

    const contracts = await readTypeScriptContracts(evidence)

    expect(contracts.components.has('ExampleService')).toBe(false)
  })

  test('uses the root declaration contract when later roots export the same public name', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': `
export declare const DuplicateButton: {
  new (): { $props: { fromRoot?: boolean } }
}
`,
      'es/secondary.d.ts': `
export declare const DuplicateButton: {
  new (): { $props: { fromSecondary?: boolean } }
}
`
    }, {
      exports: {
        '.': { types: './es/index.d.ts' },
        './secondary': { types: './es/secondary.d.ts' }
      }
    })

    const contracts = await readTypeScriptContracts(evidence)
    const duplicate = contracts.components.get('DuplicateButton')

    expect([...duplicate!.props.entries.keys()]).toEqual(['fromRoot'])
    expect(duplicate?.sources[0]?.relativePath).toBe('es/index.d.ts')
  })

  test('closes the TypeScript API when snapshot initialization fails', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': 'export {}\n'
    })
    const close = vi.spyOn(API.prototype, 'close')
    vi.spyOn(API.prototype, 'updateSnapshot').mockImplementationOnce(() => {
      throw new Error('snapshot initialization failed')
    })

    await expect(readTypeScriptContracts(evidence)).rejects.toThrow('snapshot initialization failed')
    expect(close).toHaveBeenCalledOnce()
  })

  test('closes the TypeScript API when snapshot disposal fails', async () => {
    const evidence = await createDeclarationFixture({
      'es/index.d.ts': 'export {}\n'
    })
    const updateSnapshot = API.prototype.updateSnapshot
    const close = vi.spyOn(API.prototype, 'close')
    vi.spyOn(API.prototype, 'updateSnapshot').mockImplementationOnce(function (this: API, options) {
      const snapshot = updateSnapshot.call(this, options)
      vi.spyOn(snapshot, 'dispose').mockImplementationOnce(() => {
        throw new Error('snapshot disposal failed')
      })
      return snapshot
    })

    await expect(readTypeScriptContracts(evidence)).rejects.toThrow('snapshot disposal failed')
    expect(close).toHaveBeenCalledOnce()
  })
})

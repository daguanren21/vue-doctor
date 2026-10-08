import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { scanDoctorSource, analyzeDoctorSourceTask } from './source-analysis.js'
import { DoctorSourceWorkspace } from './source-workspace.js'

describe('Doctor source workspace', () => {
  test('re-reads source while reusing immutable content facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-workspace-'))
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-workspace-cache-'))
    const file = join(root, 'App.vue')
    await writeFile(file, '<template><Field /></template>')
    const workspace = new DoctorSourceWorkspace()
    const targetFiles = { root, files: [file], issues: [] }

    const first = await scanDoctorSource({ targetFiles, workspace, cacheDirectory, parallel: false })
    first.source.fileResults[0]!.blocks[0]!.status = 'failed'
    first.source.components[0]!.tag = 'Mutated'
    const second = await scanDoctorSource({ targetFiles, workspace, cacheDirectory, parallel: false })

    expect(second).toMatchObject({ cacheHits: 1, cacheMisses: 0 })
    expect(second.source.fileResults[0]?.blocks[0]?.status).toBe('available')
    expect(second.source.components[0]?.tag).toBe('Field')
    expect(workspace.getStats()).toMatchObject({ sourceReads: 2, parseCount: 1 })
    await workspace.close()
  })

  test('uses one authoritative target set including empty and failed discovery results', async () => {
    const readSource = vi.fn(async (file: string) => file.endsWith('.vue')
      ? '<template><div /></template>'
      : '.theme {}')
    const workspace = new DoctorSourceWorkspace({ readSource })
    const root = '/virtual/project'
    const vueFile = join(root, 'App.vue')
    const cssFile = join(root, 'theme.css')
    const issue = { kind: 'scope-not-found' as const, path: join(root, 'missing'), message: 'missing' }
    const selected = await scanDoctorSource({
      targetFiles: { root, files: [vueFile, cssFile], issues: [issue] },
      workspace,
      parallel: false
    })
    const empty = await scanDoctorSource({
      targetFiles: { root, files: [], issues: [issue] },
      workspace,
      parallel: false
    })

    expect(readSource).toHaveBeenCalledTimes(2)
    expect(selected.source.files).toEqual([vueFile])
    expect([...selected.sourceTexts.keys()]).toEqual([vueFile, cssFile])
    expect(selected.source.discoveryIssues).toEqual([issue])
    expect(empty.source).toMatchObject({ files: [], discoveryIssues: [issue] })
    await workspace.close()
  })

  test('derives Vue-only analysis profiles without reparsing script targets', async () => {
    const root = '/virtual/profile-project'
    const vueFile = join(root, 'App.vue')
    const scriptFile = join(root, 'utility.ts')
    const workspace = new DoctorSourceWorkspace({
      readSource: async (file) => file === vueFile
        ? '<template><button :disabled="true" /></template>'
        : 'export const value = 1'
    })
    const result = await scanDoctorSource({
      targetFiles: { root, files: [vueFile, scriptFile], issues: [] },
      workspace,
      parallel: false,
      analysisProfiles: [{ includeNativeElements: true, resolveConstants: true }]
    })

    expect(result.sourceFacts).toHaveLength(1)
    expect(result.sourceFacts[0]).toMatchObject({
      file: vueFile,
      options: { includeNativeElements: true, resolveConstants: true }
    })
    expect(result.sourceFacts[0]?.analysis.components[0]?.tag).toBe('button')
    expect(workspace.getStats().parseCount).toBe(2)
    await workspace.close()
  })

  test('keeps a lazy worker pool across edits and destroys it once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-doctor-worker-workspace-'))
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-worker-cache-'))
    const file = join(root, 'App.vue')
    await writeFile(file, '<template><One /></template>')
    const run = vi.fn(async (tasks) => tasks.map(analyzeDoctorSourceTask))
    const destroy = vi.fn(async () => undefined)
    const createPool = vi.fn(async () => ({ run, destroy }))
    const workspace = new DoctorSourceWorkspace({ createPool })
    const targetFiles = { root, files: [file], issues: [] }

    await scanDoctorSource({ targetFiles, workspace, cacheDirectory, parallel: true })
    await writeFile(file, '<template><Two /></template>')
    workspace.invalidate(file)
    await scanDoctorSource({ targetFiles, workspace, cacheDirectory, parallel: true })
    await workspace.close()
    await workspace.close()

    expect(createPool).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(workspace.getStats()).toMatchObject({ workerPoolStarts: 1, parseCount: 2 })
  })

  test('falls back to serial analysis after a worker failure without recreating the pool', async () => {
    const root = '/virtual/worker-fallback'
    const file = join(root, 'App.vue')
    const cacheDirectory = await mkdtemp(join(tmpdir(), 'vue-doctor-worker-fallback-cache-'))
    let source = '<template><One /></template>'
    const createPool = vi.fn(async () => ({
      run: vi.fn(async () => { throw new Error('worker failed') }),
      destroy: vi.fn(async () => undefined)
    }))
    const workspace = new DoctorSourceWorkspace({
      createPool,
      readSource: async () => source
    })
    const targetFiles = { root, files: [file], issues: [] }

    const first = await scanDoctorSource({ targetFiles, workspace, cacheDirectory, parallel: true })
    source = '<template><Two /></template>'
    workspace.invalidate(file)
    const second = await scanDoctorSource({ targetFiles, workspace, cacheDirectory, parallel: true })

    expect(first.source.components[0]?.tag).toBe('One')
    expect(second.source.components[0]?.tag).toBe('Two')
    expect(createPool).toHaveBeenCalledTimes(1)
    expect(workspace.getStats()).toMatchObject({ workerFallbacks: 1, parseCount: 2 })
    await workspace.close()
  })

  test('bounds reusable facts by LRU entry count and byte size', async () => {
    const workspace = new DoctorSourceWorkspace({ maxEntries: 2, maxBytes: 1024 * 1024 })
    const analysis = analyzeDoctorSourceTask({ file: '/a.ts', source: 'export const a = 1' })
    workspace.setFact('a', '/a.ts', analysis)
    workspace.setFact('b', '/b.ts', analysis)
    expect(workspace.getFact('a')).toBeDefined()
    workspace.setFact('c', '/c.ts', analysis)
    expect(workspace.getStats()).toMatchObject({ factCacheEntries: 2 })
    expect(workspace.getFact('b')).toBeUndefined()
    expect(workspace.getFact('a')).toBeDefined()
    expect(workspace.getFact('c')).toBeDefined()

    const byteBounded = new DoctorSourceWorkspace({ maxEntries: 10, maxBytes: 1 })
    byteBounded.setFact('large', '/large.ts', analysis)
    expect(byteBounded.getStats()).toMatchObject({ factCacheEntries: 0, factCacheBytes: 0 })
    await workspace.close()
    await byteBounded.close()
  })
})

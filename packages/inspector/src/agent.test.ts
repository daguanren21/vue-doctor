import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentResourceInput, AgentToolInput, DevframeNodeContext } from 'devframe'
import type { Diagnostic, DoctorReport } from '@vue-doctor/core'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { registerVueDoctorAgent, VUE_DOCTOR_AGENT_HELP } from './agent.js'
import { InspectorReportStore } from './report-store.js'

const temporaryRoots: string[] = []
afterAll(async () => Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true }))))

describe('Vue Doctor agent surface', () => {
  test('registers the curated tool and resource contracts with strict bounded schemas', () => {
    const store = new InspectorReportStore({ initialReport: report('/workspace') })
    const surface = agentSurface(store)
    expect([...surface.tools.keys()]).toEqual([
      'vue-doctor:help',
      'vue-doctor:get-overview',
      'vue-doctor:list-findings',
      'vue-doctor:get-finding',
      'vue-doctor:get-coverage',
      'vue-doctor:list-rules',
      'vue-doctor:list-suppressions',
      'vue-doctor:get-suppression',
      'vue-doctor:get-source-context',
      'vue-doctor:rescan',
      'vue-doctor:get-last-scan-diff'
    ])
    expect([...surface.tools.values()].every(tool => tool.inputSchema && tool.outputSchema)).toBe(true)
    expect(surface.tools.get('vue-doctor:rescan')).toMatchObject({ safety: 'action' })
    expect([...surface.tools.values()].filter(tool => tool.safety === 'action')).toHaveLength(1)
    expect([...surface.resources.keys()]).toEqual(['vue-doctor:help', 'vue-doctor:overview'])
    expect([...surface.resources.values()].map(resource => resource.uri)).toEqual([undefined, undefined])
    expect(surface.resources.get('vue-doctor:help')?.read()).toEqual(expect.objectContaining({ text: VUE_DOCTOR_AGENT_HELP }))
    surface.dispose()
  })

  test('bounds overview facets and 36k finding pages while returning structured input errors', async () => {
    const diagnostics = Array.from({ length: 36_000 }, (_, index) => diagnostic({
      code: `fixture/rule-${index}`,
      message: `Finding ${index} ${'\n\t"\\😀'.repeat(300)}`,
      file: `/workspace/src/file-${index % 50}.vue`
    }))
    const store = new InspectorReportStore({ initialReport: report('/workspace', diagnostics) })
    const { tools } = agentSurface(store)
    const overview = await invoke(tools, 'vue-doctor:get-overview', {})
    const snapshotId = overview.snapshotId as string
    expect(overview).toMatchObject({ ok: true, coverageStatus: 'complete', clean: false })
    expect((((overview.overview as any).facets.rules.items) as unknown[])).toHaveLength(20)
    expect((overview.overview as any).facets.rules.truncated).toBe(true)

    const firstPage = await invoke(tools, 'vue-doctor:list-findings', { snapshotId, limit: 50 })
    expect(firstPage).toMatchObject({ ok: true, findings: { total: 36_000, truncated: true } })
    expect((firstPage.findings as any).returned).toBeLessThanOrEqual(50)
    expect(Buffer.byteLength(JSON.stringify(firstPage))).toBeLessThanOrEqual(24 * 1024)
    expect(firstPage.response).toMatchObject({ maxBytes: 24 * 1024, mcpResultMaxBytes: 64 * 1024, truncated: true })
    expect((firstPage.response as any).clippedFieldCount).toBeGreaterThan(0)
    const adapterResult = {
      content: [{ type: 'text', text: JSON.stringify(firstPage, null, 2) }],
      structuredContent: firstPage
    }
    expect(Buffer.byteLength(JSON.stringify(adapterResult))).toBeLessThanOrEqual(64 * 1024)
    expect((firstPage.response as any).mcpResultBytes).toBe(Buffer.byteLength(JSON.stringify(adapterResult)))
    const invalid = await invoke(tools, 'vue-doctor:list-findings', { snapshotId, limit: 51 })
    expect(invalid).toMatchObject({ ok: false, snapshotId, error: { code: 'invalid-request' } })
  })

  test('coalesces rescans, reports content changes beyond stable IDs, and preserves the last diff on failure', async () => {
    let generation = 0
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    let fail = false
    const initial = report('/workspace', [diagnostic({ id: 'vd1:stable', message: 'before' })])
    const store = new InspectorReportStore({
      initialReport: initial,
      async run() {
        generation++
        if (generation === 1) await wait
        if (fail) throw new Error('safe failure')
        return report('/workspace', [diagnostic({ id: 'vd1:stable', message: 'after', severity: 'error' })])
      }
    })
    const { tools } = agentSurface(store)
    const snapshotId = store.getSnapshot().snapshotId
    const first = invoke(tools, 'vue-doctor:rescan', { snapshotId })
    const second = invoke(tools, 'vue-doctor:rescan', { snapshotId })
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect([firstResult.accepted, secondResult.accepted].sort()).toEqual([false, true])
    expect((firstResult.diff as any).findings).toMatchObject({ added: 0, removed: 0, changed: 1 })
    expect(firstResult.diff).toMatchObject({
      coverage: { beforeFacts: { scannedFiles: 1 }, afterFacts: { scannedFiles: 1 } },
      suppressed: { before: 0, after: 0, delta: 0 },
      requiredSkipped: { before: 0, after: 0, delta: 0 }
    })
    const successfulDiff = await invoke(tools, 'vue-doctor:get-last-scan-diff', {})

    fail = true
    const currentSnapshotId = store.getSnapshot().snapshotId
    const failed = await invoke(tools, 'vue-doctor:rescan', { snapshotId: currentSnapshotId })
    expect(failed).toMatchObject({ ok: false, snapshotId: currentSnapshotId, error: { code: 'run-failed' } })
    const retainedDiff = await invoke(tools, 'vue-doctor:get-last-scan-diff', {})
    expect(retainedDiff.diff).toEqual(successfulDiff.diff)
    const stale = await invoke(tools, 'vue-doctor:list-findings', { snapshotId })
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale-snapshot' } })
  })

  test('binds a rescan envelope to the completed scan when a newer snapshot is observed before serialization', async () => {
    const store = new InspectorReportStore({
      initialReport: report('/workspace', [diagnostic({ id: 'stable', message: 'before' })]),
      run: async () => report('/workspace', [diagnostic({ id: 'stable', message: 'after' })])
    })
    const initialSnapshotId = store.getSnapshot().snapshotId
    const originalGetSnapshot = store.getSnapshot.bind(store)
    let calls = 0
    vi.spyOn(store, 'getSnapshot').mockImplementation(() => {
      calls++
      const snapshot = originalGetSnapshot()
      if (calls === 3) return { ...snapshot, snapshotId: 'vds1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
      return snapshot
    })
    const { tools } = agentSurface(store)

    const result = await invoke(tools, 'vue-doctor:rescan', { snapshotId: initialSnapshotId })

    expect(result).toMatchObject({ ok: true, diff: { beforeSnapshotId: initialSnapshotId } })
    expect(result.snapshotId).toBe(result.diff.afterSnapshotId)
    expect(result.snapshotId).not.toBe('vds1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  })

  test('limits source context to a finding, 10 context lines, and 16 KiB inside the real project root', async () => {
    const root = await temporaryRoot('vue-doctor-agent-source-')
    const outside = await temporaryRoot('vue-doctor-agent-outside-')
    await mkdir(join(root, 'src'), { recursive: true })
    const insideFile = join(root, 'src', 'App.vue')
    const outsideFile = join(outside, 'secret.ts')
    await writeFile(insideFile, `${'a'.repeat(40_000)}\n`, 'utf8')
    await writeFile(outsideFile, 'secret\n', 'utf8')
    const store = new InspectorReportStore({ initialReport: report(root, [
      diagnostic({ id: 'inside', file: insideFile, evidence: [{ kind: 'source', file: insideFile, line: 1 }] }),
      diagnostic({ id: 'outside', file: outsideFile, evidence: [{ kind: 'source', file: outsideFile, line: 1 }] })
    ]) })
    const { tools } = agentSurface(store)
    const snapshotId = store.getSnapshot().snapshotId
    const items = (store.queryFindings({ snapshotId, limit: 10 })).items
    const inside = items.find(item => item.id === 'inside')!
    const outsideFinding = items.find(item => item.id === 'outside')!
    const source = await invoke(tools, 'vue-doctor:get-source-context', { snapshotId, id: inside.id, contextLines: 10 })
    expect(source).toMatchObject({ ok: true, source: { truncated: true } })
    expect(Buffer.byteLength((source.source as any).content)).toBeLessThanOrEqual(16 * 1024)
    const rejected = await invoke(tools, 'vue-doctor:get-source-context', { snapshotId, id: outsideFinding.id })
    expect(rejected).toMatchObject({ ok: false, error: { code: 'outside-root' } })
    const invalid = await invoke(tools, 'vue-doctor:get-source-context', { snapshotId, id: inside.id, contextLines: 11 })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  test('never labels a delayed read with a newer snapshot after a concurrent rescan', async () => {
    const root = await temporaryRoot('vue-doctor-agent-race-')
    const file = join(root, 'App.vue')
    await writeFile(file, '<template />\n', 'utf8')
    let release!: () => void
    let started!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const didStart = new Promise<void>(resolve => { started = resolve })
    const store = new InspectorReportStore({
      initialReport: report(root, [diagnostic({ id: 'race', file })]),
      run: async () => report(root, [diagnostic({ id: 'race', file, message: 'new snapshot' })]),
      source: {
        async getSnippet() {
          started()
          await wait
          return { file, startLine: 1, endLine: 1, language: 'vue', content: '<template />', highlightLine: 1 }
        }
      }
    })
    const { tools } = agentSurface(store)
    const snapshotId = store.getSnapshot().snapshotId
    const delayed = invoke(tools, 'vue-doctor:get-source-context', { snapshotId, id: 'race' })
    await didStart
    const rescanned = await invoke(tools, 'vue-doctor:rescan', { snapshotId })
    release()
    const result = await delayed
    expect(rescanned.snapshotId).not.toBe(snapshotId)
    expect(result).toMatchObject({
      ok: false,
      snapshotId: rescanned.snapshotId,
      error: { code: 'stale-snapshot' }
    })
  })
})

function agentSurface(store: InspectorReportStore) {
  const tools = new Map<string, AgentToolInput>()
  const resources = new Map<string, AgentResourceInput>()
  const context = {
    agent: {
      registerTool(input: AgentToolInput) {
        tools.set(input.id, input)
        return { unregister: () => tools.delete(input.id) }
      },
      registerResource(input: AgentResourceInput) {
        resources.set(input.id, input)
        return { unregister: () => resources.delete(input.id) }
      }
    }
  } as unknown as DevframeNodeContext
  return { tools, resources, dispose: registerVueDoctorAgent(context, store) }
}

async function invoke(tools: Map<string, AgentToolInput>, id: string, args: unknown): Promise<Record<string, any>> {
  return await tools.get(id)!.handler(args) as Record<string, any>
}

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'fixture/rule', severity: 'warning', message: 'Fixture finding', evidence: [], fixes: [], confidence: 'high', ...overrides
  }
}

function report(root: string, diagnostics: Diagnostic[] = [], coverageStatus: DoctorReport['coverage']['status'] = 'complete'): DoctorReport {
  return {
    project: { root, vueFramework: 'vue3', uiLibraries: [] },
    inventory: { root, packages: {} },
    coverage: {
      status: coverageStatus,
      source: { status: coverageStatus, scannedFileCount: 1, failedFiles: [] },
      componentLibraries: []
    },
    diagnostics
  }
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

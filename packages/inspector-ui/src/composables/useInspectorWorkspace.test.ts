import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, test, vi } from 'vitest'
import type { InspectorSharedState, InspectorSnapshot } from '@vue-doctor/inspector-protocol'
import type { InspectorTransport } from '../transport'
import type { InspectorConnectionEvent } from '../transport'
import { useInspectorWorkspace } from './useInspectorWorkspace'

const firstId = `vds1:${'1'.repeat(32)}`
const secondId = `vds1:${'2'.repeat(32)}`

function snapshot(snapshotId: string, revision: number, coverageStatus: InspectorSnapshot['coverageStatus'] = 'complete'): InspectorSnapshot {
  return {
    snapshotId,
    revision,
    createdAt: '2026-10-06T00:00:00.000Z',
    project: { name: 'fixture', vueFramework: 'vue3' },
    coverageStatus,
    counts: { findings: 1, suppressed: 0, errors: 0, warnings: 1, info: 0 },
    facets: { severities: [{ value: 'warning', count: 1 }], domains: [], rules: [], packages: [], sources: [] },
    facetLimit: 200,
    facetTruncated: { severities: false, domains: false, rules: false, packages: false, sources: false },
    run: { status: 'idle' }
  }
}

function transportFixture(options: { snapshots?: InspectorSnapshot[] } = {}) {
  let listener: ((state: Readonly<InspectorSharedState>) => void) | undefined
  let connectionListener: ((event: InspectorConnectionEvent) => void) | undefined
  const snapshots = [...(options.snapshots ?? [snapshot(firstId, 1)])]
  const transport: InspectorTransport = {
    getSnapshot: vi.fn(async () => snapshots.shift() ?? snapshot(firstId, 1)),
    queryFindings: vi.fn(async request => ({
      snapshotId: request.snapshotId,
      offset: request.offset ?? 0,
      limit: request.limit ?? 100,
      total: 1,
      items: [{ id: `finding:${request.snapshotId}`, ruleCode: 'fixture-rule', severity: 'warning' as const, confidence: 'high' as const, message: request.snapshotId, source: 'fixture', hasSuggestions: false }]
    })),
    getFinding: vi.fn(async request => ({ id: request.id, snapshotId: request.snapshotId, ruleCode: 'fixture-rule', severity: 'warning' as const, confidence: 'high' as const, message: 'fixture', source: 'fixture', hasSuggestions: false, evidenceOffset: request.evidenceOffset ?? 0, evidenceLimit: request.evidenceLimit ?? 20, evidenceTotal: 45, evidence: [{ kind: `page-${request.evidenceOffset ?? 0}` }], suggestions: [], tags: [], edits: [] })),
    getCoverage: vi.fn(async request => ({ snapshotId: request.snapshotId, offset: 0, limit: 100, total: 0, items: [], summary: [] })),
    queryRules: vi.fn(async request => ({ snapshotId: request.snapshotId, offset: 0, limit: 100, total: 0, items: [] })),
    queryAudit: vi.fn(async request => ({ snapshotId: request.snapshotId, offset: 0, limit: 100, total: 0, items: [] })),
    getAudit: vi.fn(async request => ({
      id: request.id,
      ruleCode: 'fixture-rule',
      status: 'applied' as const,
      reason: 'Reviewed locally',
      diagnosticTotal: 45,
      diagnosticOffset: request.diagnosticOffset ?? 0,
      diagnosticLimit: request.diagnosticLimit ?? 20,
      directive: { file: 'App.vue', line: 1, text: 'vue-doctor-disable-next-line fixture-rule' },
      diagnostics: [{ id: `diagnostic-${request.diagnosticOffset ?? 0}`, severity: 'warning' as const, message: 'fixture' }]
    })),
    run: vi.fn(async () => ({ accepted: false, revision: 2, snapshotId: firstId })),
    getSnippet: vi.fn(async request => ({ snapshotId: request.snapshotId, findingId: request.id, file: 'App.vue', startLine: 1, endLine: 1, language: 'vue', content: '' })),
    openEditor: vi.fn(async request => ({ snapshotId: request.snapshotId, ok: true as const })),
    exportReport: vi.fn(async request => ({ snapshotId: request.snapshotId, format: 'json' as const, contentType: 'application/json; charset=utf-8' as const, content: '{}' })),
    subscribeConnection: vi.fn(next => {
      connectionListener = next
      next({ status: 'connected' })
      return () => { connectionListener = undefined }
    }),
    subscribe: vi.fn(async next => { listener = next; next({ namespace: 'vue-doctor', protocolVersion: 1, revision: 1, snapshotId: firstId, status: 'idle' }); return () => { listener = undefined } }),
    close: vi.fn()
  }
  return {
    transport,
    emit: (state: InspectorSharedState) => listener?.(state),
    emitConnection: (event: InspectorConnectionEvent) => connectionListener?.(event)
  }
}

describe('useInspectorWorkspace', () => {
  test('an invalid initial snapshot leaves the workspace reconnectable without subscribing', async () => {
    const fixture = transportFixture()
    vi.mocked(fixture.transport.getSnapshot).mockResolvedValueOnce(undefined as never)
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('findings'), connect: async () => fixture.transport }))!
    await state.initialize()
    expect(state.connectionStatus.value).toBe('error')
    expect(state.connectionError.value).toContain('missing snapshotId')
    expect(fixture.transport.subscribe).not.toHaveBeenCalled()
    expect(fixture.transport.close).toHaveBeenCalledOnce()
    scope.stop()
  })

  test('late page replies cannot replace a newer snapshot', async () => {
    const fixture = transportFixture({ snapshots: [snapshot(firstId, 1), snapshot(secondId, 2)] })
    let resolveOld!: (value: Awaited<ReturnType<InspectorTransport['queryFindings']>>) => void
    const query = vi.mocked(fixture.transport.queryFindings)
    query.mockResolvedValueOnce({ snapshotId: firstId, offset: 0, limit: 100, total: 1, items: [] })
      .mockImplementationOnce(request => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce({ snapshotId: secondId, offset: 0, limit: 100, total: 1, items: [{ id: 'new', ruleCode: 'new', severity: 'warning', confidence: 'high', message: 'new', source: 'fixture', hasSuggestions: false }] })
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('findings'), connect: async () => fixture.transport, debounceMs: 0 }))!
    await state.initialize()
    state.findingFilters.query = 'old request'
    await new Promise(resolve => setTimeout(resolve, 0))
    fixture.emit({ namespace: 'vue-doctor', protocolVersion: 1, revision: 2, snapshotId: secondId, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 0))
    resolveOld({ snapshotId: firstId, offset: 0, limit: 100, total: 1, items: [{ id: 'old', ruleCode: 'old', severity: 'warning', confidence: 'high', message: 'old', source: 'fixture', hasSuggestions: false }] })
    await nextTick()
    expect(state.snapshot.value?.snapshotId).toBe(secondId)
    expect(state.findings.value.items[0]?.id).toBe('new')
    scope.stop()
  })

  test('accepted false joins an existing run and keeps shared state authoritative', async () => {
    const fixture = transportFixture()
    vi.mocked(fixture.transport.run).mockImplementationOnce(async () => {
      fixture.emit({ namespace: 'vue-doctor', protocolVersion: 1, revision: 2, snapshotId: firstId, status: 'running' })
      return { accepted: false, revision: 2, snapshotId: firstId }
    })
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('findings'), connect: async () => fixture.transport }))!
    await state.initialize()
    await state.runAgain()
    expect(state.runError.value).toBeUndefined()
    expect(state.running.value).toBe(true)
    expect(state.snapshot.value?.snapshotId).toBe(firstId)
    scope.stop()
  })

  test('a later idle shared state clears the prior run error', async () => {
    const fixture = transportFixture()
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('findings'), connect: async () => fixture.transport }))!
    await state.initialize()
    fixture.emit({ namespace: 'vue-doctor', protocolVersion: 1, revision: 1, snapshotId: firstId, status: 'error', error: 'failed' })
    expect(state.runError.value).toBe('failed')
    fixture.emit({ namespace: 'vue-doctor', protocolVersion: 1, revision: 1, snapshotId: firstId, status: 'idle' })
    expect(state.runError.value).toBeUndefined()
    scope.stop()
  })

  test('a disconnect keeps the last snapshot visible and marks it stale', async () => {
    const fixture = transportFixture()
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('findings'), connect: async () => fixture.transport }))!
    await state.initialize()
    const visibleSnapshot = state.snapshot.value
    fixture.emitConnection({ status: 'disconnected', error: new Error('socket closed') })
    expect(state.connectionStatus.value).toBe('error')
    expect(state.connectionError.value).toBe('socket closed')
    expect(state.snapshot.value).toBe(visibleSnapshot)
    expect(state.stale.value).toBe(true)
    scope.stop()
  })

  test('paging replaces a selection that is absent from the new result page', async () => {
    const fixture = transportFixture()
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('findings'), connect: async () => fixture.transport }))!
    await state.initialize()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.selectedFindingId.value).toBe(`finding:${firstId}`)
    vi.mocked(fixture.transport.queryFindings).mockResolvedValueOnce({
      snapshotId: firstId,
      offset: 100,
      limit: 100,
      total: 101,
      items: [{ id: 'finding:page-2', ruleCode: 'fixture-rule', severity: 'warning', confidence: 'high', message: 'page 2', source: 'fixture', hasSuggestions: false }]
    })
    state.setFindingPage(100)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.selectedFindingId.value).toBe('finding:page-2')
    expect(state.evidenceOffset.value).toBe(0)
    expect(fixture.transport.getFinding).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'finding:page-2' }))
    scope.stop()
  })

  test('zero findings is only clean when coverage is complete', async () => {
    const blocked = snapshot(firstId, 1, 'blocked')
    blocked.counts.findings = 0
    const fixture = transportFixture({ snapshots: [blocked] })
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('findings'), connect: async () => fixture.transport }))!
    await state.initialize()
    expect(state.zeroFindingsIsClean.value).toBe(false)
    scope.stop()
  })

  test('finding evidence is requested and rendered one bounded page at a time', async () => {
    const fixture = transportFixture()
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('findings'), connect: async () => fixture.transport }))!
    await state.initialize()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.transport.getFinding).toHaveBeenLastCalledWith(expect.objectContaining({ evidenceOffset: 0, evidenceLimit: 20 }))
    state.setEvidencePage(20)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.transport.getFinding).toHaveBeenLastCalledWith(expect.objectContaining({ evidenceOffset: 20, evidenceLimit: 20 }))
    expect(state.selectedFinding.value?.evidenceOffset).toBe(20)
    expect(state.selectedFinding.value?.evidence).toEqual([{ kind: 'page-20' }])
    scope.stop()
  })

  test('audit diagnostics are requested one bounded page at a time', async () => {
    const fixture = transportFixture()
    vi.mocked(fixture.transport.queryAudit).mockImplementation(async request => ({
      snapshotId: request.snapshotId,
      offset: 0,
      limit: 100,
      total: 1,
      items: [{
        id: 'audit-1',
        ruleCode: 'fixture-rule',
        status: 'applied',
        diagnosticTotal: 45,
        diagnosticOffset: 0,
        diagnosticLimit: 20,
        directive: { file: 'App.vue', line: 1, text: 'vue-doctor-disable-next-line fixture-rule' },
        diagnostics: [{ id: 'diagnostic-0', severity: 'warning', message: 'fixture' }]
      }]
    }))
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('audit'), connect: async () => fixture.transport }))!
    await state.initialize()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.transport.getAudit).toHaveBeenLastCalledWith(expect.objectContaining({ diagnosticOffset: 0, diagnosticLimit: 20 }))
    state.setAuditDiagnosticPage(20)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.transport.getAudit).toHaveBeenLastCalledWith(expect.objectContaining({ diagnosticOffset: 20, diagnosticLimit: 20 }))
    expect(state.selectedAudit.value?.diagnosticOffset).toBe(20)
    expect(state.selectedAudit.value?.diagnostics[0]?.id).toBe('diagnostic-20')
    scope.stop()
  })

  test('a superseded or disposed connection is closed before it can publish state', async () => {
    const oldFixture = transportFixture()
    const currentFixture = transportFixture({ snapshots: [snapshot(secondId, 2)] })
    let resolveOld!: (transport: InspectorTransport) => void
    const connect = vi.fn()
      .mockImplementationOnce(() => new Promise<InspectorTransport>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(currentFixture.transport)
    const scope = effectScope()
    const state = scope.run(() => useInspectorWorkspace({ route: ref('findings'), connect }))!
    const oldAttempt = state.initialize()
    await state.initialize()
    resolveOld(oldFixture.transport)
    await oldAttempt
    expect(oldFixture.transport.close).toHaveBeenCalledOnce()
    expect(state.snapshot.value?.snapshotId).toBe(secondId)

    const disposedFixture = transportFixture()
    let resolveDisposed!: (transport: InspectorTransport) => void
    const disposedScope = effectScope()
    const disposedState = disposedScope.run(() => useInspectorWorkspace({
      route: ref('findings'),
      connect: () => new Promise<InspectorTransport>(resolve => { resolveDisposed = resolve })
    }))!
    const disposedAttempt = disposedState.initialize()
    disposedScope.stop()
    resolveDisposed(disposedFixture.transport)
    await disposedAttempt
    expect(disposedFixture.transport.close).toHaveBeenCalledOnce()
    scope.stop()
  })
})

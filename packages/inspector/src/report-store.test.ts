import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Diagnostic, DoctorReport } from '@vue-doctor/core'
import { afterAll, describe, expect, test } from 'vitest'
import { InspectorProtocolError, type InspectorEditor } from './protocol.js'
import { InspectorReportStore } from './report-store.js'

const temporaryRoots: string[] = []

afterAll(async () => {
  await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true })))
})

describe('InspectorReportStore', () => {
  test('exposes project ESLint rule metadata even when no findings exist', () => {
    const input = report('/workspace')
    input.ruleCatalogs = [{
      name: 'eslint',
      rules: [{
        code: 'eslint/team/no-var',
        title: 'Use block-scoped declarations',
        description: 'The project custom rule requires let or const.',
        domain: 'conventions',
        tags: ['eslint', 'project'],
        verification: 'static'
      }]
    }]
    input.checks = [{ ruleCode: 'eslint/team/no-var', rulePack: 'eslint', status: 'checked', files: 2 }]
    const store = new InspectorReportStore({ initialReport: input })
    const snapshotId = store.getSnapshot().snapshotId

    expect(store.queryRules({ snapshotId, pack: 'eslint', query: 'block-scoped' })).toMatchObject({
      total: 1,
      items: [{
        code: 'eslint/team/no-var',
        name: 'Use block-scoped declarations',
        pack: 'eslint',
        summary: 'The project custom rule requires let or const.',
        status: 'checked',
        findingCount: 0,
        verification: 'static',
        tags: ['eslint', 'project']
      }]
    })
    const exported = JSON.parse(store.exportReport({ snapshotId, format: 'json' }).content)
    expect(exported.ruleCatalogs).toEqual(input.ruleCatalogs)
  })

  test('pages long evidence and nested audit diagnostics while retaining complete exports', () => {
    const input = report('/workspace', [diagnostic({ evidence: Array.from({ length: 10_003 }, (_, line) => ({ kind: 'source', file: '/workspace/a.vue', line: line + 1 })) })])
    input.suppressionAudit = [{
      status: 'applied', ruleCode: 'fixture/suppressed', reason: 'Reviewed exception.',
      directive: { text: '// vue-doctor-disable-next-line fixture/suppressed -- Reviewed exception.', mode: 'next-line', location: { file: '/workspace/a.vue', precision: 'line', start: { line: 1 } } },
      diagnostics: Array.from({ length: 10_003 }, (_, index) => diagnostic({ message: `Suppressed finding ${index}` }))
    }]
    const store = new InspectorReportStore({ initialReport: input })
    const snapshotId = store.getSnapshot().snapshotId
    const id = store.queryFindings({ snapshotId }).items[0]!.id
    expect(store.getFinding({ snapshotId, id })).toMatchObject({ evidenceTotal: 10_003, evidenceOffset: 0, evidenceLimit: 20 })
    expect(store.getFinding({ snapshotId, id }).evidence).toHaveLength(20)
    expect(store.getFinding({ snapshotId, id, evidenceOffset: 10_000 }).evidence).toHaveLength(3)
    expect(() => store.getFinding({ snapshotId, id, evidenceLimit: 101 })).toThrow(InspectorProtocolError)
    const audit = store.queryAudit({ snapshotId }).items[0]!
    expect(audit.diagnosticTotal).toBe(10_003)
    expect(audit.diagnostics).toHaveLength(0)
    expect(store.getAudit({ snapshotId, id: audit.id }).diagnostics).toHaveLength(20)
    expect(store.queryAudit({ snapshotId, query: 'finding 10002' }).total).toBe(1)
    expect(store.getAudit({ snapshotId, id: audit.id, diagnosticOffset: 10_000 }).diagnostics).toHaveLength(3)
    expect(() => store.getAudit({ snapshotId, id: audit.id, diagnosticLimit: 101 })).toThrow(InspectorProtocolError)
    const exported = JSON.parse(store.exportReport({ snapshotId, format: 'json' }).content)
    expect(exported.diagnostics[0].evidence).toHaveLength(10_003)
    expect(exported.suppressionAudit[0].diagnostics).toHaveLength(10_003)
  })
  test('keeps cached query projections immutable between callers', () => {
    const store = new InspectorReportStore({ initialReport: report('/workspace', [diagnostic({ message: 'original' })]) })
    const snapshotId = store.getSnapshot().snapshotId
    const first = store.queryFindings({ snapshotId }).items[0]!
    expect(Object.isFrozen(first)).toBe(true)
    expect(() => { first.message = 'mutated' }).toThrow()
    expect(store.queryFindings({ snapshotId }).items[0]!.message).toBe('original')
  })
  test('remediation suggestions never hide real contract violations', () => {
    const store = new InspectorReportStore({ initialReport: report('/workspace', [
      diagnostic({ code: 'component-event-unsupported', fixes: [{ title: 'Use a declared event', kind: 'suggestion' }] }),
      diagnostic({ code: 'vue-prefer-use-template-ref', fixes: [{ title: 'Use useTemplateRef', kind: 'suggestion' }] }),
      diagnostic({ code: 'vue-prefer-define-model', fixes: [{ title: 'Use defineModel', kind: 'suggestion' }] })
    ]) })
    const snapshotId = store.getSnapshot().snapshotId
    expect(store.queryFindings({ snapshotId, includeSuggestions: false })).toMatchObject({ total: 1, items: [{ ruleCode: 'component-event-unsupported', hasSuggestions: true }] })
    expect(store.queryFindings({ snapshotId, includeSuggestions: true }).total).toBe(3)
  })
  test('a failed transport observer cannot interrupt a scan or another mount', async () => {
    const store = new InspectorReportStore({ initialReport: report('/workspace'), run: async () => report('/workspace', [diagnostic({ message: 'next' })]) })
    const states: string[] = []
    store.onStateChange(() => { throw new Error('transport closed') })
    store.onStateChange((state) => { states.push(state.status) })
    await store.run()
    expect(states).toEqual(['running', 'idle'])
    expect(store.getSnapshot().counts.findings).toBe(1)
    expect(store.getSharedState().status).toBe('idle')
  })
  test('a rerun cannot move source authorization into another project', async () => {
    const store = new InspectorReportStore({ initialReport: report('/workspace'), run: async () => report('/different-project') })
    const original = store.getSnapshot().snapshotId
    await expect(store.run()).rejects.toThrow('project root changed')
    expect(store.getSnapshot().snapshotId).toBe(original)
    expect(store.getSharedState().status).toBe('error')
  })
  test('uses a deterministic snapshot identity and preserves full anonymous legacy cardinality', () => {
    const diagnostics = Array.from({ length: 36_000 }, (_, index) => diagnostic({
      code: `anonymous/rule-${index}`,
      message: `Anonymous finding ${index}`,
      file: `/workspace/src/file-${index % 100}.vue`,
      evidence: [{ kind: 'source', file: `/workspace/src/file-${index % 100}.vue`, line: index + 1 }]
    }))
    const first = new InspectorReportStore({ initialReport: report('/workspace', diagnostics) })
    const second = new InspectorReportStore({ initialReport: structuredClone(report('/workspace', diagnostics)) })

    expect(first.getSnapshot().snapshotId).toBe(second.getSnapshot().snapshotId)
    const snapshot = first.getSnapshot()
    const snapshotId = snapshot.snapshotId
    const firstPage = first.queryFindings({ snapshotId, offset: 0, limit: 137 })
    const lastPage = first.queryFindings({ snapshotId, offset: 35_980, limit: 100 })

    expect(firstPage).toMatchObject({ offset: 0, limit: 137, total: 36_000 })
    expect(firstPage.items).toHaveLength(137)
    expect(lastPage.items).toHaveLength(20)
    expect(new Set([...firstPage.items, ...lastPage.items].map(item => item.id)).size).toBe(157)
    expect(snapshot.facets.rules).toHaveLength(200)
    expect(snapshot.facetTruncated.rules).toBe(true)
    expect(first.queryFindings({ snapshotId, rule: 'anonymous/rule-35999' })).toMatchObject({ total: 1 })
    expect(first.queryFindings({ snapshotId, rule: 'anonymous/missing' })).toMatchObject({ total: 0 })
    expect(first.queryFindings({ snapshotId, query: 'anonymous finding 35999' })).toMatchObject({ total: 1 })
  })

  test('keeps duplicate legacy findings addressable with stable unique ids', () => {
    const duplicate = diagnostic({ code: 'fixture/duplicate', message: 'same' })
    const first = new InspectorReportStore({ initialReport: report('/workspace', [duplicate, structuredClone(duplicate)]) })
    const second = new InspectorReportStore({ initialReport: report('/workspace', [duplicate, structuredClone(duplicate)]) })
    const firstSnapshot = first.getSnapshot()
    const secondSnapshot = second.getSnapshot()
    const firstItems = first.queryFindings({ snapshotId: firstSnapshot.snapshotId }).items
    const secondItems = second.queryFindings({ snapshotId: secondSnapshot.snapshotId }).items

    expect(firstItems.map(item => item.id)).toEqual(secondItems.map(item => item.id))
    expect(new Set(firstItems.map(item => item.id)).size).toBe(2)
    expect(Object.isFrozen(first.getReport(firstSnapshot.snapshotId))).toBe(true)
    expect(Object.isFrozen(first.getReport(firstSnapshot.snapshotId).diagnostics)).toBe(true)
  })

  test('rejects cross-generation reads after a successful rerun', async () => {
    const initial = report('/workspace', [diagnostic({ code: 'fixture/old', message: 'old' })])
    const next = report('/workspace', [diagnostic({ code: 'fixture/new', message: 'new' })])
    const store = new InspectorReportStore({ initialReport: initial, run: async () => next })
    const oldId = store.getSnapshot().snapshotId

    const result = await store.run({ snapshotId: oldId })

    expect(result.snapshotId).not.toBe(oldId)
    expect(() => store.queryFindings({ snapshotId: oldId })).toThrowError(expect.objectContaining({ code: 'stale-snapshot' }))
  })

  test('coalesces concurrent runs into one host callback', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    let calls = 0
    const next = report('/workspace', [diagnostic({ message: 'after' })])
    const store = new InspectorReportStore({
      initialReport: report('/workspace'),
      run: async () => {
        calls++
        await pending
      },
      getReport: () => next
    })

    const first = store.run()
    const second = store.run()
    expect(store.getSharedState().status).toBe('running')
    finish()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(calls).toBe(1)
    expect(firstResult.accepted).toBe(true)
    expect(secondResult.accepted).toBe(false)
    expect(firstResult.snapshotId).toBe(secondResult.snapshotId)
  })

  test('preserves the last good snapshot and publishes the rerun error', async () => {
    const store = new InspectorReportStore({
      initialReport: report('/workspace', [diagnostic({ message: 'last good' })]),
      run: async () => { throw new Error('scan failed safely') }
    })
    const before = store.getSnapshot().snapshotId

    await expect(store.run()).rejects.toMatchObject({ code: 'run-failed', message: 'scan failed safely' })

    expect(store.getSnapshot().snapshotId).toBe(before)
    expect(store.getSharedState()).toMatchObject({ status: 'error', error: 'scan failed safely', snapshotId: before })
    expect(store.queryFindings({ snapshotId: before }).total).toBe(1)
  })

  test('exposes suppression audit without mixing suppressed findings into the active result', () => {
    const suppressed = diagnostic({ code: 'fixture/suppressed', message: 'reviewed exception', file: '/workspace/src/a.ts' })
    const input = report('/workspace')
    input.suppressionAudit = [{
      status: 'applied',
      ruleCode: 'fixture/suppressed',
      reason: 'Reviewed by the owning team.',
      directive: {
        text: '// vue-doctor-disable-next-line fixture/suppressed -- Reviewed by the owning team.',
        mode: 'next-line',
        location: { file: '/workspace/src/a.ts', precision: 'line', start: { line: 1 } }
      },
      diagnostics: [suppressed]
    }]
    const store = new InspectorReportStore({ initialReport: input })
    const snapshot = store.getSnapshot()
    const audit = store.queryAudit({ snapshotId: snapshot.snapshotId })

    expect(snapshot.counts).toMatchObject({ findings: 0, suppressed: 1 })
    expect(audit.items[0]).toMatchObject({ status: 'applied', ruleCode: 'fixture/suppressed', diagnosticTotal: 1, diagnostics: [] })
    expect(store.getAudit({ snapshotId: snapshot.snapshotId, id: audit.items[0]!.id }).diagnostics).toEqual([expect.objectContaining({ message: 'reviewed exception' })])
  })

  test('validates source actions against the report root before calling host services', async () => {
    const root = await temporaryRoot('vue-doctor-inspector-root-')
    const outside = await temporaryRoot('vue-doctor-inspector-outside-')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'inside.ts'), 'first\nsecond\nthird\n', 'utf8')
    await writeFile(join(outside, 'outside.ts'), 'private\n', 'utf8')
    let openCalls = 0
    let openedEditor: InspectorEditor | undefined
    const insideStore = new InspectorReportStore({
      initialReport: report(root, [diagnostic({ file: join(root, 'src', 'inside.ts'), evidence: [{ kind: 'source', file: join(root, 'src', 'inside.ts'), line: 2 }] })]),
      source: { openEditor: async request => { openCalls++; openedEditor = request.editor } }
    })
    const insideSnapshot = insideStore.getSnapshot()
    const insideFinding = insideStore.queryFindings({ snapshotId: insideSnapshot.snapshotId }).items[0]!

    await expect(insideStore.getSnippet({ snapshotId: insideSnapshot.snapshotId, id: insideFinding.id, contextLines: 1 }))
      .resolves.toMatchObject({ content: 'first\nsecond\nthird', highlightLine: 2 })
    await expect(insideStore.openEditor({ snapshotId: insideSnapshot.snapshotId, id: insideFinding.id }))
      .resolves.toMatchObject({ ok: true })
    expect(openCalls).toBe(1)
    expect(openedEditor).toBe('vscode')
    await expect(insideStore.openEditor({ snapshotId: insideSnapshot.snapshotId, id: insideFinding.id, editor: 'webstorm' }))
      .resolves.toMatchObject({ ok: true })
    expect(openedEditor).toBe('webstorm')
    for (const editor of ['sublime', 'system']) {
      await expect(insideStore.openEditor({ snapshotId: insideSnapshot.snapshotId, id: insideFinding.id, editor: editor as InspectorEditor }))
        .rejects.toMatchObject({ code: 'invalid-request' })
    }
    expect(openCalls).toBe(2)

    const outsideStore = new InspectorReportStore({
      initialReport: report(root, [diagnostic({ file: join(outside, 'outside.ts') })]),
      source: { openEditor: async () => { openCalls++ } }
    })
    const outsideSnapshot = outsideStore.getSnapshot()
    const outsideFinding = outsideStore.queryFindings({ snapshotId: outsideSnapshot.snapshotId }).items[0]!
    await expect(outsideStore.openEditor({ snapshotId: outsideSnapshot.snapshotId, id: outsideFinding.id }))
      .rejects.toMatchObject({ code: 'outside-root' })
    expect(openCalls).toBe(2)
  })

  test('never labels delayed source action responses with a newer snapshot', async () => {
    const root = await temporaryRoot('vue-doctor-inspector-race-')
    await mkdir(join(root, 'src'), { recursive: true })
    const file = join(root, 'src', 'race.ts')
    await writeFile(file, 'race\n', 'utf8')
    let generation = 0
    let editorLaunches = 0
    let releaseSnippet!: () => void
    let releaseEditor!: () => void
    let snippetStarted!: () => void
    let editorStarted!: () => void
    const snippetStart = new Promise<void>(resolve => { snippetStarted = resolve })
    const editorStart = new Promise<void>(resolve => { editorStarted = resolve })
    const snippetWait = new Promise<void>(resolve => { releaseSnippet = resolve })
    const editorWait = new Promise<void>(resolve => { releaseEditor = resolve })
    const makeReport = () => report(root, [diagnostic({
      message: `generation ${generation}`,
      file,
      evidence: [{ kind: 'source', file, line: 1 }]
    })])
    const store = new InspectorReportStore({
      initialReport: makeReport(),
      run: async () => {
        generation++
        return makeReport()
      },
      source: {
        async getSnippet() {
          snippetStarted()
          await snippetWait
          return { file, startLine: 1, endLine: 1, language: 'typescript', content: 'race', highlightLine: 1 }
        },
        async openEditor() {
          editorLaunches++
          editorStarted()
          await editorWait
        }
      }
    })
    const firstSnapshot = store.getSnapshot()
    const firstFinding = store.queryFindings({ snapshotId: firstSnapshot.snapshotId }).items[0]!
    const delayedSnippet = store.getSnippet({ snapshotId: firstSnapshot.snapshotId, id: firstFinding.id })
    await snippetStart
    await store.run()
    releaseSnippet()
    await expect(delayedSnippet).rejects.toMatchObject({ code: 'stale-snapshot' })

    const secondSnapshot = store.getSnapshot()
    const secondFinding = store.queryFindings({ snapshotId: secondSnapshot.snapshotId }).items[0]!
    const delayedEditor = store.openEditor({ snapshotId: secondSnapshot.snapshotId, id: secondFinding.id })
    await editorStart
    await store.run()
    releaseEditor()
    await expect(delayedEditor).resolves.toEqual({ snapshotId: secondSnapshot.snapshotId, ok: true })
    const third = store.getSnapshot()
    const thirdFinding = store.queryFindings({ snapshotId: third.snapshotId }).items[0]!
    const preLaunchRace = store.openEditor({ snapshotId: third.snapshotId, id: thirdFinding.id })
    await store.run()
    await expect(preLaunchRace).rejects.toMatchObject({ code: 'stale-snapshot' })
    expect(editorLaunches).toBe(1)
  })

  test('close is idempotent and rejects later reads and runs', async () => {
    const store = new InspectorReportStore({ initialReport: report('/workspace'), run: async () => report('/workspace') })
    store.close()
    store.close()

    expect(() => store.getSnapshot()).toThrowError(expect.objectContaining({ code: 'closed' }))
    await expect(store.run()).rejects.toMatchObject({ code: 'closed' })
  })

  test('rejects unknown protocol fields before executing a query', () => {
    const store = new InspectorReportStore({ initialReport: report('/workspace') })
    const snapshotId = store.getSnapshot().snapshotId
    expect(() => store.queryFindings({ snapshotId, unexpected: true } as never))
      .toThrowError(new InspectorProtocolError('invalid-request', 'Unknown request field: unexpected.'))
  })
})

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'fixture/rule',
    severity: 'warning',
    message: 'Fixture finding',
    evidence: [],
    fixes: [],
    confidence: 'high',
    ...overrides
  }
}

function report(root: string, diagnostics: Diagnostic[] = []): DoctorReport {
  return {
    project: { root, vueFramework: 'vue3', uiLibraries: [] },
    inventory: { root, packages: {} },
    coverage: {
      status: 'complete',
      source: { status: 'complete', scannedFileCount: 0, failedFiles: [] },
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

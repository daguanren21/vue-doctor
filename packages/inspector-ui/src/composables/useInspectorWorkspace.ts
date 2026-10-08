import {
  computed,
  onScopeDispose,
  reactive,
  shallowReadonly,
  shallowRef,
  watch,
  type Ref
} from 'vue'
import type {
  ExportReportResult,
  InspectorAuditItem,
  InspectorConfidence,
  InspectorCoverageCategory,
  InspectorCoverageResult,
  InspectorEditor,
  InspectorFindingDetail,
  InspectorFindingSummary,
  InspectorPage,
  InspectorRuleItem,
  InspectorRuleStatus,
  InspectorSeverity,
  InspectorSharedState,
  InspectorSnapshot,
  InspectorSnippet
} from '@vue-doctor/inspector-protocol'
import type { InspectorTransport } from '../transport'
import type { InspectorConnectionEvent } from '../transport'
import type { InspectorRoute } from './useInspectorRoute'

const findingsLimit = 100
const coverageLimit = 100
const rulesLimit = 100
const auditLimit = 100
const auditDiagnosticLimit = 20

export interface InspectorFindingFilters {
  query: string
  severity: InspectorSeverity | 'all'
  confidence: InspectorConfidence | 'all'
  domain: string
  rule: string
  package: string
  source: string
  includeSuggestions: boolean
}

export interface InspectorCoverageFilters {
  query: string
  category: InspectorCoverageCategory | 'all'
}

export interface InspectorRuleFilters {
  query: string
  status: InspectorRuleStatus | 'all'
  pack: string
}

export interface InspectorAuditFilters {
  query: string
  status: InspectorAuditItem['status'] | 'all'
  rule: string
}

export interface UseInspectorWorkspaceOptions {
  route: Readonly<Ref<InspectorRoute>>
  connect: () => Promise<InspectorTransport>
  debounceMs?: number
}

function emptyPage<T>(): InspectorPage<T> {
  return { snapshotId: '', offset: 0, limit: 0, total: 0, items: [] }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useInspectorWorkspace(options: UseInspectorWorkspaceOptions) {
  const connectionStatus = shallowRef<'connecting' | 'connected' | 'error'>('connecting')
  const connectionError = shallowRef<string>()
  const snapshot = shallowRef<InspectorSnapshot>()
  const sharedState = shallowRef<Readonly<InspectorSharedState>>()
  const runError = shallowRef<string>()
  const running = shallowRef(false)
  const viewLoading = shallowRef(false)
  const viewError = shallowRef<string>()
  const detailLoading = shallowRef(false)
  const detailError = shallowRef<string>()
  const editorError = shallowRef<string>()
  const exporting = shallowRef(false)

  const findings = shallowRef<InspectorPage<InspectorFindingSummary>>(emptyPage())
  const selectedFindingId = shallowRef<string>()
  const selectedFinding = shallowRef<InspectorFindingDetail>()
  const selectedSnippet = shallowRef<InspectorSnippet>()
  const evidenceOffset = shallowRef(0)
  const coverage = shallowRef<InspectorCoverageResult>({ ...emptyPage(), summary: [] })
  const rules = shallowRef<InspectorPage<InspectorRuleItem>>(emptyPage())
  const audit = shallowRef<InspectorPage<InspectorAuditItem>>(emptyPage())
  const selectedAuditId = shallowRef<string>()
  const selectedAudit = shallowRef<InspectorAuditItem>()
  const auditDiagnosticOffset = shallowRef(0)
  const auditDetailLoading = shallowRef(false)
  const auditDetailError = shallowRef<string>()

  const findingFilters = reactive<InspectorFindingFilters>({
    query: '', severity: 'all', confidence: 'all', domain: '', rule: '', package: '', source: '', includeSuggestions: false
  })
  const coverageFilters = reactive<InspectorCoverageFilters>({ query: '', category: 'all' })
  const ruleFilters = reactive<InspectorRuleFilters>({ query: '', status: 'all', pack: '' })
  const auditFilters = reactive<InspectorAuditFilters>({ query: '', status: 'all', rule: '' })

  const findingOffset = shallowRef(0)
  const coverageOffset = shallowRef(0)
  const rulesOffset = shallowRef(0)
  const auditOffset = shallowRef(0)

  let transport: InspectorTransport | undefined
  let unsubscribe: (() => void) | undefined
  let unsubscribeConnection: (() => void) | undefined
  let disposed = false
  let connectionSequence = 0
  let snapshotSequence = 0
  let viewSequence = 0
  let detailSequence = 0
  let auditDetailSequence = 0
  let filterTimer: ReturnType<typeof setTimeout> | undefined

  const stale = computed(() => Boolean(snapshot.value) && (
    connectionStatus.value !== 'connected'
    || running.value
    || snapshot.value?.run.status === 'running'
    || (sharedState.value?.revision ?? 0) > (snapshot.value?.revision ?? 0)
  ))
  const hasSnapshot = computed(() => Boolean(snapshot.value))
  const zeroFindingsIsClean = computed(() => snapshot.value?.counts.findings === 0 && snapshot.value.coverageStatus === 'complete')

  async function initialize() {
    const sequence = ++connectionSequence
    unsubscribe?.()
    unsubscribe = undefined
    unsubscribeConnection?.()
    unsubscribeConnection = undefined
    transport?.close()
    transport = undefined
    connectionStatus.value = 'connecting'
    connectionError.value = undefined
    try {
      const nextTransport = await options.connect()
      if (disposed || sequence !== connectionSequence) {
        nextTransport.close()
        return
      }
      transport = nextTransport
      const nextUnsubscribeConnection = nextTransport.subscribeConnection(event => {
        if (!disposed && sequence === connectionSequence) handleConnectionEvent(event)
      })
      if (disposed || sequence !== connectionSequence) {
        nextUnsubscribeConnection()
        nextTransport.close()
        return
      }
      unsubscribeConnection = nextUnsubscribeConnection
      const loaded = await refreshSnapshot()
      if (!loaded) {
        nextUnsubscribeConnection()
        if (unsubscribeConnection === nextUnsubscribeConnection) unsubscribeConnection = undefined
        nextTransport.close()
        if (transport === nextTransport) transport = undefined
        return
      }
      if (disposed || sequence !== connectionSequence) {
        nextTransport.close()
        return
      }
      const nextUnsubscribe = await nextTransport.subscribe(
        next => {
          if (!disposed && sequence === connectionSequence) handleSharedState(next)
        },
        error => {
          if (!disposed && sequence === connectionSequence) handleSharedStateError(error)
        }
      )
      if (disposed || sequence !== connectionSequence) {
        nextUnsubscribe()
        nextTransport.close()
        return
      }
      unsubscribe = nextUnsubscribe
      if (disposed || sequence !== connectionSequence) return
      connectionStatus.value = 'connected'
    } catch (error) {
      if (disposed || sequence !== connectionSequence) return
      unsubscribe?.()
      unsubscribe = undefined
      unsubscribeConnection?.()
      unsubscribeConnection = undefined
      transport?.close()
      transport = undefined
      connectionStatus.value = 'error'
      connectionError.value = errorMessage(error)
    }
  }

  function handleSharedState(next: Readonly<InspectorSharedState> | undefined) {
    if (!next?.status || typeof next.revision !== 'number') {
      handleSharedStateError(new Error('The analysis host returned an invalid shared state: missing status or revision.'))
      return
    }
    sharedState.value = next
    connectionStatus.value = 'connected'
    connectionError.value = undefined
    running.value = next.status === 'running'
    runError.value = next.status === 'error' ? (next.error ?? 'Analysis failed.') : undefined
    if (
      !snapshot.value
      || next.revision > snapshot.value.revision
      || (next.snapshotId && next.snapshotId !== snapshot.value.snapshotId && next.revision >= snapshot.value.revision)
    ) void refreshSnapshot()
  }

  function handleConnectionEvent(event: InspectorConnectionEvent) {
    if (event.status === 'connected') {
      connectionStatus.value = 'connected'
      connectionError.value = undefined
      return
    }
    if (event.status === 'connecting') {
      connectionStatus.value = 'connecting'
      connectionError.value = undefined
      return
    }
    connectionStatus.value = 'error'
    connectionError.value = event.error?.message ?? (
      event.status === 'unauthorized'
        ? 'The analysis host rejected this Inspector connection.'
        : event.status === 'disconnected'
          ? 'The analysis host disconnected.'
          : 'The analysis host connection failed.'
    )
  }

  function handleSharedStateError(error: unknown) {
    connectionStatus.value = 'error'
    connectionError.value = errorMessage(error)
  }

  async function refreshSnapshot(): Promise<boolean> {
    if (!transport) return false
    const sequence = ++snapshotSequence
    try {
      const next = await transport.getSnapshot()
      if (disposed || sequence !== snapshotSequence) return false
      if (!next?.snapshotId) throw new Error('The analysis host returned an invalid snapshot: missing snapshotId.')
      if (!next.run?.status) throw new Error('The analysis host returned an invalid snapshot: missing run.status.')
      if (!next.counts) throw new Error('The analysis host returned an invalid snapshot: missing counts.')
      if (!next.facets) throw new Error('The analysis host returned an invalid snapshot: missing facets.')
      const previousId = snapshot.value?.snapshotId
      snapshot.value = next
      running.value = next.run.status === 'running' || sharedState.value?.status === 'running'
      connectionError.value = undefined
      connectionStatus.value = 'connected'
      if (previousId !== next.snapshotId) {
        evidenceOffset.value = 0
        selectedFinding.value = undefined
        selectedSnippet.value = undefined
        clearAuditSelection()
      }
      await loadActiveView()
      return true
    } catch (error) {
      if (disposed || sequence !== snapshotSequence) return false
      connectionStatus.value = 'error'
      connectionError.value = errorMessage(error)
      return false
    }
  }

  async function loadActiveView() {
    if (options.route.value === 'findings') return loadFindings()
    if (options.route.value === 'coverage') return loadCoverage()
    if (options.route.value === 'rules') return loadRules()
    return loadAudit()
  }

  async function loadFindings() {
    if (!transport || !snapshot.value) return
    const sequence = ++viewSequence
    const snapshotId = snapshot.value.snapshotId
    viewLoading.value = true
    viewError.value = undefined
    try {
      const result = await transport.queryFindings({
        snapshotId,
        offset: findingOffset.value,
        limit: findingsLimit,
        ...(findingFilters.query.trim() ? { query: findingFilters.query.trim() } : {}),
        ...(findingFilters.severity === 'all' ? {} : { severity: findingFilters.severity }),
        ...(findingFilters.confidence === 'all' ? {} : { confidence: findingFilters.confidence }),
        ...(findingFilters.domain ? { domain: findingFilters.domain } : {}),
        ...(findingFilters.rule ? { rule: findingFilters.rule } : {}),
        ...(findingFilters.package ? { package: findingFilters.package } : {}),
        ...(findingFilters.source ? { source: findingFilters.source } : {}),
        includeSuggestions: findingFilters.includeSuggestions
      })
      if (disposed || sequence !== viewSequence || result.snapshotId !== snapshot.value?.snapshotId) return
      findings.value = result
      const selectedStillVisible = selectedFindingId.value && result.items.some(item => item.id === selectedFindingId.value)
      if (!selectedStillVisible) {
        if (result.items[0]) selectFinding(result.items[0].id)
        else clearFindingSelection()
      } else if (selectedFinding.value?.snapshotId !== result.snapshotId) {
        void loadFindingDetail(selectedFindingId.value!)
      }
    } catch (error) {
      if (disposed || sequence !== viewSequence) return
      viewError.value = errorMessage(error)
    } finally {
      if (sequence === viewSequence) viewLoading.value = false
    }
  }

  async function loadCoverage() {
    if (!transport || !snapshot.value) return
    const sequence = ++viewSequence
    const snapshotId = snapshot.value.snapshotId
    viewLoading.value = true
    viewError.value = undefined
    try {
      const result = await transport.getCoverage({
        snapshotId,
        offset: coverageOffset.value,
        limit: coverageLimit,
        ...(coverageFilters.query.trim() ? { query: coverageFilters.query.trim() } : {}),
        ...(coverageFilters.category === 'all' ? {} : { category: coverageFilters.category })
      })
      if (disposed || sequence !== viewSequence || result.snapshotId !== snapshot.value?.snapshotId) return
      coverage.value = result
    } catch (error) {
      if (disposed || sequence !== viewSequence) return
      viewError.value = errorMessage(error)
    } finally {
      if (sequence === viewSequence) viewLoading.value = false
    }
  }

  async function loadRules() {
    if (!transport || !snapshot.value) return
    const sequence = ++viewSequence
    const snapshotId = snapshot.value.snapshotId
    viewLoading.value = true
    viewError.value = undefined
    try {
      const result = await transport.queryRules({
        snapshotId,
        offset: rulesOffset.value,
        limit: rulesLimit,
        ...(ruleFilters.query.trim() ? { query: ruleFilters.query.trim() } : {}),
        ...(ruleFilters.status === 'all' ? {} : { status: ruleFilters.status }),
        ...(ruleFilters.pack ? { pack: ruleFilters.pack } : {})
      })
      if (disposed || sequence !== viewSequence || result.snapshotId !== snapshot.value?.snapshotId) return
      rules.value = result
    } catch (error) {
      if (disposed || sequence !== viewSequence) return
      viewError.value = errorMessage(error)
    } finally {
      if (sequence === viewSequence) viewLoading.value = false
    }
  }

  async function loadAudit() {
    if (!transport || !snapshot.value) return
    const sequence = ++viewSequence
    const snapshotId = snapshot.value.snapshotId
    viewLoading.value = true
    viewError.value = undefined
    try {
      const result = await transport.queryAudit({
        snapshotId,
        offset: auditOffset.value,
        limit: auditLimit,
        ...(auditFilters.query.trim() ? { query: auditFilters.query.trim() } : {}),
        ...(auditFilters.status === 'all' ? {} : { status: auditFilters.status }),
        ...(auditFilters.rule ? { rule: auditFilters.rule } : {})
      })
      if (disposed || sequence !== viewSequence || result.snapshotId !== snapshot.value?.snapshotId) return
      audit.value = result
      const selectedStillVisible = selectedAuditId.value && result.items.some(item => item.id === selectedAuditId.value)
      if (!selectedStillVisible) {
        if (result.items[0]) selectAudit(result.items[0].id)
        else clearAuditSelection()
      } else if (!selectedAudit.value) {
        void loadAuditDetail(selectedAuditId.value!)
      }
    } catch (error) {
      if (disposed || sequence !== viewSequence) return
      viewError.value = errorMessage(error)
    } finally {
      if (sequence === viewSequence) viewLoading.value = false
    }
  }

  function selectAudit(id: string) {
    if (selectedAuditId.value !== id) selectedAudit.value = undefined
    selectedAuditId.value = id
    auditDiagnosticOffset.value = 0
    void loadAuditDetail(id)
  }

  function clearAuditSelection() {
    auditDetailSequence++
    selectedAuditId.value = undefined
    selectedAudit.value = undefined
    auditDiagnosticOffset.value = 0
    auditDetailLoading.value = false
    auditDetailError.value = undefined
  }

  async function loadAuditDetail(id: string) {
    if (!transport || !snapshot.value) return
    const sequence = ++auditDetailSequence
    const snapshotId = snapshot.value.snapshotId
    auditDetailLoading.value = true
    auditDetailError.value = undefined
    try {
      const result = await transport.getAudit({
        snapshotId,
        id,
        diagnosticOffset: auditDiagnosticOffset.value,
        diagnosticLimit: auditDiagnosticLimit
      })
      if (
        disposed
        || sequence !== auditDetailSequence
        || snapshotId !== snapshot.value?.snapshotId
        || id !== selectedAuditId.value
      ) return
      selectedAudit.value = result
    } catch (error) {
      if (disposed || sequence !== auditDetailSequence) return
      auditDetailError.value = errorMessage(error)
    } finally {
      if (sequence === auditDetailSequence) auditDetailLoading.value = false
    }
  }

  function selectFinding(id: string) {
    selectedFindingId.value = id
    evidenceOffset.value = 0
    void loadFindingDetail(id)
  }

  function clearFindingSelection() {
    detailSequence++
    selectedFindingId.value = undefined
    selectedFinding.value = undefined
    selectedSnippet.value = undefined
    evidenceOffset.value = 0
    detailLoading.value = false
    detailError.value = undefined
  }

  async function loadFindingDetail(id: string, options: { loadSnippet?: boolean } = {}) {
    if (!transport || !snapshot.value) return
    const sequence = ++detailSequence
    const snapshotId = snapshot.value.snapshotId
    detailLoading.value = true
    detailError.value = undefined
    try {
      const [detail, snippetResult] = await Promise.allSettled([
        transport.getFinding({ snapshotId, id, evidenceOffset: evidenceOffset.value, evidenceLimit: 20 }),
        options.loadSnippet === false
          ? Promise.resolve(selectedSnippet.value)
          : transport.getSnippet({ snapshotId, id, contextLines: 5 })
      ])
      if (disposed || sequence !== detailSequence || snapshotId !== snapshot.value?.snapshotId || id !== selectedFindingId.value) return
      if (detail.status === 'rejected') throw detail.reason
      if (detail.value.snapshotId !== snapshotId) return
      selectedFinding.value = detail.value
      selectedSnippet.value = snippetResult.status === 'fulfilled' && snippetResult.value && snippetResult.value.snapshotId === snapshotId
        ? snippetResult.value
        : undefined
    } catch (error) {
      if (disposed || sequence !== detailSequence) return
      detailError.value = errorMessage(error)
      if (findings.value.items[0]?.id !== id) selectFinding(findings.value.items[0]!.id)
    } finally {
      if (sequence === detailSequence) detailLoading.value = false
    }
  }

  async function runAgain() {
    if (!transport) return
    runError.value = undefined
    running.value = true
    try {
      await transport.run(snapshot.value ? { snapshotId: snapshot.value.snapshotId } : undefined)
      // accepted:false means this client joined an already-running analysis.
      // Shared state remains authoritative for completion; refresh keeps the
      // last completed snapshot visible while the joined run is in flight.
      await refreshSnapshot()
    } catch (error) {
      runError.value = errorMessage(error)
      running.value = false
    }
  }

  async function openEditor(editor?: InspectorEditor) {
    if (!transport || !snapshot.value || !selectedFindingId.value) return false
    editorError.value = undefined
    try {
      await transport.openEditor({ snapshotId: snapshot.value.snapshotId, id: selectedFindingId.value, ...(editor ? { editor } : {}) })
      return true
    } catch (error) {
      editorError.value = errorMessage(error)
      return false
    }
  }

  async function exportReport(): Promise<ExportReportResult | undefined> {
    if (!transport || !snapshot.value) return
    exporting.value = true
    try {
      return await transport.exportReport({ snapshotId: snapshot.value.snapshotId, format: 'json' })
    } finally {
      exporting.value = false
    }
  }

  function setFindingPage(offset: number) {
    findingOffset.value = Math.max(0, offset)
    if (options.route.value === 'findings') void loadFindings()
  }
  function setEvidencePage(offset: number) {
    evidenceOffset.value = Math.max(0, offset)
    if (selectedFindingId.value) void loadFindingDetail(selectedFindingId.value, { loadSnippet: false })
  }
  function setCoveragePage(offset: number) { coverageOffset.value = Math.max(0, offset); void loadCoverage() }
  function setRulesPage(offset: number) { rulesOffset.value = Math.max(0, offset); void loadRules() }
  function setAuditPage(offset: number) { auditOffset.value = Math.max(0, offset); void loadAudit() }
  function setAuditDiagnosticPage(offset: number) {
    auditDiagnosticOffset.value = Math.max(0, offset)
    if (selectedAuditId.value) void loadAuditDetail(selectedAuditId.value)
  }

  function scheduleFilteredLoad(route: InspectorRoute) {
    clearTimeout(filterTimer)
    filterTimer = setTimeout(() => {
      if (route === 'findings') { findingOffset.value = 0; void loadFindings() }
      else if (route === 'coverage') { coverageOffset.value = 0; void loadCoverage() }
      else if (route === 'rules') { rulesOffset.value = 0; void loadRules() }
      else { auditOffset.value = 0; void loadAudit() }
    }, options.debounceMs ?? 180)
  }

  watch(options.route, () => { viewError.value = undefined; void loadActiveView() })
  watch(findingFilters, () => scheduleFilteredLoad('findings'))
  watch(coverageFilters, () => scheduleFilteredLoad('coverage'))
  watch(ruleFilters, () => scheduleFilteredLoad('rules'))
  watch(auditFilters, () => scheduleFilteredLoad('audit'))

  onScopeDispose(() => {
    disposed = true
    connectionSequence++
    snapshotSequence++
    viewSequence++
    detailSequence++
    auditDetailSequence++
    clearTimeout(filterTimer)
    unsubscribe?.()
    unsubscribeConnection?.()
    transport?.close()
  })

  return {
    connectionStatus: shallowReadonly(connectionStatus), connectionError: shallowReadonly(connectionError),
    snapshot: shallowReadonly(snapshot), sharedState: shallowReadonly(sharedState), stale, hasSnapshot, zeroFindingsIsClean,
    runError: shallowReadonly(runError), running: shallowReadonly(running), viewLoading: shallowReadonly(viewLoading), viewError: shallowReadonly(viewError),
    detailLoading: shallowReadonly(detailLoading), detailError: shallowReadonly(detailError), editorError: shallowReadonly(editorError), exporting: shallowReadonly(exporting),
    findings: shallowReadonly(findings), coverage: shallowReadonly(coverage), rules: shallowReadonly(rules), audit: shallowReadonly(audit),
    selectedFindingId: shallowReadonly(selectedFindingId), selectedFinding: shallowReadonly(selectedFinding), selectedSnippet: shallowReadonly(selectedSnippet), evidenceOffset: shallowReadonly(evidenceOffset),
    selectedAuditId: shallowReadonly(selectedAuditId), selectedAudit: shallowReadonly(selectedAudit), auditDiagnosticOffset: shallowReadonly(auditDiagnosticOffset),
    auditDetailLoading: shallowReadonly(auditDetailLoading), auditDetailError: shallowReadonly(auditDetailError),
    findingFilters, coverageFilters, ruleFilters, auditFilters,
    findingOffset: shallowReadonly(findingOffset), coverageOffset: shallowReadonly(coverageOffset), rulesOffset: shallowReadonly(rulesOffset), auditOffset: shallowReadonly(auditOffset),
    initialize, refreshSnapshot, loadActiveView, selectFinding, selectAudit, runAgain, openEditor, exportReport,
    setFindingPage, setEvidencePage, setCoveragePage, setRulesPage, setAuditPage, setAuditDiagnosticPage
  }
}

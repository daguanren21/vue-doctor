<script setup lang="ts">
import { computed, onMounted, onScopeDispose } from 'vue'
import { Icon } from '@iconify/vue'
import type { InspectorEditor } from '@vue-doctor/inspector-protocol'
import AuditView from './components/audit/AuditView.vue'
import CoverageView from './components/coverage/CoverageView.vue'
import EmptyState from './components/EmptyState.vue'
import FindingsView from './components/findings/FindingsView.vue'
import RulesView from './components/rules/RulesView.vue'
import WorkspaceHeader from './components/workspace/WorkspaceHeader.vue'
import WorkspaceNav from './components/workspace/WorkspaceNav.vue'
import { useFrameNavigation } from './composables/useFrameNavigation'
import { useInspectorEditor } from './composables/useInspectorEditor'
import { useInspectorLocale } from './composables/useInspectorLocale'
import { useInspectorRoute } from './composables/useInspectorRoute'
import { useInspectorTheme } from './composables/useInspectorTheme'
import { useInspectorWorkspace } from './composables/useInspectorWorkspace'
import { inspectorIcons } from './lib/icons'
import { inspectorButton } from './lib/variants'
import { createDevframeTransport } from './transport'

const root = document.getElementById('app') as HTMLElement
const frameId = root.dataset.devframeId ?? 'vue-doctor'
const connectionBase = root.dataset.connectionBase
const { current: route, navigate } = useInspectorRoute()
const { locale, messages: labels, setLocale } = useInspectorLocale()
const { theme, toggleTheme } = useInspectorTheme()
const { editor, setEditor } = useInspectorEditor()
const frameLabels = computed(() => ({ findings: labels.value.findings, coverage: labels.value.coverage, rules: labels.value.rules, audit: labels.value.audit }))
useFrameNavigation({ frameId, route, labels: frameLabels, navigate })

const workspace = useInspectorWorkspace({
  route,
  connect: () => createDevframeTransport(connectionBase ? { baseURL: connectionBase } : {})
})

function updateFindingFilters(patch: Partial<typeof workspace.findingFilters>) { Object.assign(workspace.findingFilters, patch) }
function updateCoverageFilters(patch: Partial<typeof workspace.coverageFilters>) { Object.assign(workspace.coverageFilters, patch) }
function updateRuleFilters(patch: Partial<typeof workspace.ruleFilters>) { Object.assign(workspace.ruleFilters, patch) }
function updateAuditFilters(patch: Partial<typeof workspace.auditFilters>) { Object.assign(workspace.auditFilters, patch) }
function updateEditor(value: InspectorEditor) { setEditor(value) }
function showRuleFindings(ruleCode: string) {
  Object.assign(workspace.findingFilters, {
    query: '', severity: 'all', confidence: 'all', domain: '', rule: ruleCode, package: '', source: '', includeSuggestions: true
  })
  workspace.setFindingPage(0)
  navigate('findings')
}

async function exportReport() {
  const result = await workspace.exportReport()
  if (!result) return
  const url = URL.createObjectURL(new Blob([result.content], { type: result.contentType }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${workspace.snapshot.value?.project.name ?? 'vue-doctor'}-${result.snapshotId.slice(5, 13)}.json`
  link.click()
  URL.revokeObjectURL(url)
}

function toggleLocale() { setLocale(locale.value === 'zh' ? 'en' : 'zh') }
function onGlobalKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target as HTMLElement | null
  if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
  if (event.key === '/') {
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')
    if (search) { event.preventDefault(); search.focus() }
  }
}

onMounted(() => { window.addEventListener('keydown', onGlobalKeydown); void workspace.initialize() })
onScopeDispose(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <div class="inspector-app">
    <WorkspaceHeader :snapshot="workspace.snapshot.value" :labels="labels" :locale="locale" :theme="theme" :running="workspace.running.value" :stale="workspace.stale.value" :exporting="workspace.exporting.value" @run="workspace.runAgain" @export="exportReport" @toggle-theme="toggleTheme" @toggle-locale="toggleLocale" />
    <WorkspaceNav :route="route" :snapshot="workspace.snapshot.value" :labels="labels" @navigate="navigate" />

    <div v-if="workspace.runError.value" class="state-banner state-banner--error" role="status"><Icon :icon="inspectorIcons.octagonAlert" class="size-3.5" /><strong>{{ labels.runFailed }}</strong><span>{{ workspace.runError.value }}</span></div>
    <div v-else-if="workspace.stale.value" class="state-banner state-banner--warning" role="status"><Icon :icon="inspectorIcons.clock" class="size-3.5" /><strong>{{ labels.staleReport }}</strong><span>{{ labels.staleReportHint }}</span></div>
    <button v-else-if="workspace.snapshot.value && workspace.snapshot.value.coverageStatus !== 'complete'" type="button" class="state-banner state-banner--warning state-banner--button" @click="navigate('coverage')"><Icon :icon="inspectorIcons.alert" class="size-3.5" /><strong>{{ labels.incompleteNotice }}</strong><span>{{ labels.reviewCoverage }} →</span></button>

    <main class="inspector-app__main">
      <EmptyState v-if="!workspace.hasSnapshot.value && workspace.connectionStatus.value === 'connecting'" variant="loading" :title="labels.loading" :description="labels.loadingHint" />
      <EmptyState v-else-if="!workspace.hasSnapshot.value && workspace.connectionStatus.value === 'error'" variant="error" :title="labels.connectionFailed" :description="`${labels.connectionFailedHint} ${workspace.connectionError.value ?? ''}`" :action-label="labels.reconnect" @action="workspace.initialize" />
      <template v-else-if="workspace.snapshot.value">
        <FindingsView v-if="route === 'findings'" :snapshot="workspace.snapshot.value" :filters="workspace.findingFilters" :page="workspace.findings.value" :selected-id="workspace.selectedFindingId.value" :selected="workspace.selectedFinding.value" :snippet="workspace.selectedSnippet.value" :loading="workspace.viewLoading.value" :error="workspace.viewError.value" :detail-loading="workspace.detailLoading.value" :detail-error="workspace.detailError.value" :editor-error="workspace.editorError.value" :editor="editor" :labels="labels" @filter="updateFindingFilters" @select="workspace.selectFinding" @page="workspace.setFindingPage" @evidence-page="workspace.setEvidencePage" @retry="workspace.loadActiveView" @open="workspace.openEditor(editor)" @update-editor="updateEditor" />
        <CoverageView v-else-if="route === 'coverage'" :snapshot="workspace.snapshot.value" :result="workspace.coverage.value" :filters="workspace.coverageFilters" :loading="workspace.viewLoading.value" :error="workspace.viewError.value" :labels="labels" @filter="updateCoverageFilters" @page="workspace.setCoveragePage" @retry="workspace.loadActiveView" />
        <RulesView v-else-if="route === 'rules'" :snapshot="workspace.snapshot.value" :page="workspace.rules.value" :filters="workspace.ruleFilters" :loading="workspace.viewLoading.value" :error="workspace.viewError.value" :labels="labels" @filter="updateRuleFilters" @page="workspace.setRulesPage" @retry="workspace.loadActiveView" @show-findings="showRuleFindings" />
        <AuditView v-else :page="workspace.audit.value" :selected-id="workspace.selectedAuditId.value" :selected="workspace.selectedAudit.value" :filters="workspace.auditFilters" :loading="workspace.viewLoading.value" :error="workspace.viewError.value" :detail-loading="workspace.auditDetailLoading.value" :detail-error="workspace.auditDetailError.value" :labels="labels" @filter="updateAuditFilters" @page="workspace.setAuditPage" @select="workspace.selectAudit" @diagnostic-page="workspace.setAuditDiagnosticPage" @retry="workspace.loadActiveView" />
      </template>
    </main>

    <footer class="inspector-footer">
      <span class="mono inspector-footer__path" :title="workspace.snapshot.value?.project.root">{{ workspace.snapshot.value?.project.root ?? labels.waitingProject }}</span>
      <span v-if="workspace.snapshot.value" class="num inspector-footer__facts">{{ workspace.snapshot.value.project.vueVersion ? `Vue ${workspace.snapshot.value.project.vueVersion}` : workspace.snapshot.value.project.vueFramework }}<template v-if="workspace.snapshot.value.project.viteVersion"> · Vite {{ workspace.snapshot.value.project.viteVersion }}</template> · {{ workspace.snapshot.value.counts.findings }} {{ labels.findingsCount }} · {{ workspace.snapshot.value.counts.suppressed }} {{ labels.suppressionAudit }}</span>
      <button v-if="workspace.connectionStatus.value === 'error' && workspace.hasSnapshot.value" type="button" :class="inspectorButton({ intent: 'danger', size: 'sm' })" @click="workspace.initialize"><Icon :icon="inspectorIcons.wifiOff" class="size-3" />{{ labels.reconnect }}</button>
    </footer>
  </div>
</template>

<style scoped>
.inspector-app { display: flex; min-width: 320px; height: 100dvh; min-height: 0; flex-direction: column; overflow: hidden; background: var(--doctor-bg); color: var(--doctor-text); animation: inspector-enter 180ms ease-out; }
.inspector-app__main { display: flex; min-width: 0; min-height: 0; flex: 1; overflow: hidden; }
.state-banner { display: flex; min-height: 40px; flex: none; align-items: center; gap: 8px; border: 0; border-bottom: 1px solid; padding: 8px 20px; text-align: left; font-size: 12px; }
.state-banner strong { font-weight: 500; }
.state-banner > svg { flex: none; }
.state-banner span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state-banner--warning { border-color: color-mix(in srgb, var(--doctor-warning-fg) 22%, transparent); background: color-mix(in srgb, var(--doctor-warning-bg) 65%, var(--doctor-surface)); color: var(--doctor-warning-fg); }
.state-banner--error { border-color: color-mix(in srgb, var(--doctor-error-fg) 32%, transparent); background: var(--doctor-error-bg); color: var(--doctor-error-fg); }
.state-banner--button { width: 100%; cursor: pointer; }
.state-banner--button span { flex: none; margin-left: auto; font-weight: 600; }
.inspector-footer { display: flex; height: 30px; flex: none; align-items: center; gap: 12px; border-top: 1px solid var(--doctor-border); background: var(--doctor-surface); padding: 0 16px; color: var(--doctor-muted); font-size: 11px; }
.inspector-footer__path { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inspector-footer__facts { min-width: max-content; }
.inspector-footer button { gap: 4px; min-height: 24px; }
@media (max-width: 720px) {
  .inspector-app__main { overflow: auto; }
  .state-banner { padding: 8px 12px; }
  .state-banner span { white-space: normal; }
  .inspector-footer__facts { display: none; }
}
</style>

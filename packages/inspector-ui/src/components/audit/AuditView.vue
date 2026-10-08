<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { InspectorAuditItem, InspectorPage } from '@vue-doctor/inspector-protocol'
import type { InspectorAuditFilters } from '../../composables/useInspectorWorkspace'
import type { InspectorMessages } from '../../i18n'
import { inspectorIcons } from '../../lib/icons'
import { auditStatusLabel } from '../../lib/status-labels'
import EmptyState from '../EmptyState.vue'
import PaginationBar from '../workspace/PaginationBar.vue'
import StatusBadge from '../workspace/StatusBadge.vue'

defineProps<{
  page: InspectorPage<InspectorAuditItem>
  selectedId?: string
  selected?: InspectorAuditItem
  filters: InspectorAuditFilters
  loading: boolean
  error?: string
  detailLoading: boolean
  detailError?: string
  labels: InspectorMessages
}>()
const emit = defineEmits<{
  filter: [patch: Partial<InspectorAuditFilters>]
  page: [offset: number]
  select: [id: string]
  diagnosticPage: [offset: number]
  retry: []
}>()
</script>

<template>
  <section class="audit-view">
    <header class="audit-view__header">
      <div><div class="audit-view__title"><Icon :icon="inspectorIcons.scrollText" class="size-4" /><h1>{{ labels.suppressionAudit }}</h1><span class="num">{{ page.total }}</span></div><p>{{ labels.auditIntro }}</p></div>
      <label class="audit-view__search"><Icon :icon="inspectorIcons.search" class="size-3.5" /><span class="sr-only">{{ labels.searchAudit }}</span><input type="search" :value="filters.query" :placeholder="labels.searchAudit" @input="emit('filter', { query: ($event.target as HTMLInputElement).value })" /></label>
      <label class="audit-view__status"><span class="sr-only">{{ labels.status }}</span><select :value="filters.status" @change="emit('filter', { status: ($event.target as HTMLSelectElement).value as InspectorAuditFilters['status'] })"><option value="all">{{ labels.checkAll }}</option><option value="applied">{{ labels.appliedDirective }}</option><option value="unused">{{ labels.unusedDirective }}</option><option value="invalid">{{ labels.invalidDirective }}</option></select></label>
    </header>
    <div class="audit-view__content">
      <div class="audit-view__list" role="listbox" :aria-label="labels.suppressionAudit">
        <EmptyState v-if="error && !page.items.length" variant="error" :title="labels.pageUnavailable" :description="error" :action-label="labels.retry" @action="emit('retry')" />
        <EmptyState v-else-if="!loading && page.total === 0" variant="filter" :title="labels.noAudit" :description="labels.suppressionHint" />
        <button v-for="item in page.items" :key="item.id" type="button" role="option" class="audit-row" :aria-selected="selectedId === item.id" @click="emit('select', item.id)">
          <div><StatusBadge :status="item.status" :label="auditStatusLabel(item.status, labels)" /><span class="num">{{ item.diagnosticTotal }} {{ labels.originalDiagnostics }}</span></div>
          <strong>{{ item.ruleCode ?? item.message ?? item.directive.text }}</strong>
          <code>{{ item.directive.file }}{{ item.directive.line ? `:${item.directive.line}` : '' }}</code>
          <span v-if="item.reason">{{ item.reason }}</span>
        </button>
      </div>
      <article v-if="selected" class="audit-detail" :aria-busy="detailLoading">
        <div class="audit-detail__top"><StatusBadge :status="selected.status" :label="auditStatusLabel(selected.status, labels)" /><code v-if="selected.ruleCode">{{ selected.ruleCode }}</code></div>
        <h2>{{ labels.directive }}</h2>
        <div class="audit-detail__directive"><code>{{ selected.directive.text }}</code><span>{{ selected.directive.file }}{{ selected.directive.line ? `:${selected.directive.line}` : '' }}{{ selected.directive.column ? `:${selected.directive.column}` : '' }}</span></div>
        <dl><dt>{{ labels.mode }}</dt><dd>{{ selected.directive.mode ?? '—' }}</dd><dt>{{ labels.suppressionReason }}</dt><dd>{{ selected.reason ?? '—' }}</dd><dt>{{ labels.status }}</dt><dd>{{ auditStatusLabel(selected.status, labels) }}</dd></dl>
        <section class="audit-detail__diagnostics">
          <h2>{{ labels.originalDiagnostics }} · {{ selected.diagnosticTotal }}</h2>
          <p v-if="detailError" class="audit-detail__error" role="status">{{ labels.detailUnavailable }} · {{ detailError }}</p>
          <article v-for="diagnostic in selected.diagnostics" :key="diagnostic.id"><StatusBadge :status="diagnostic.severity" /><p>{{ diagnostic.message }}</p><code v-if="diagnostic.file">{{ diagnostic.file }}{{ diagnostic.line ? `:${diagnostic.line}` : '' }}{{ diagnostic.column ? `:${diagnostic.column}` : '' }}</code></article>
          <PaginationBar :offset="selected.diagnosticOffset" :limit="selected.diagnosticLimit" :total="selected.diagnosticTotal" :labels="labels" @page="emit('diagnosticPage', $event)" />
        </section>
      </article>
      <EmptyState v-else class="audit-detail" :variant="detailLoading ? 'loading' : detailError ? 'error' : 'select'" :title="detailLoading ? labels.loadingDetails : detailError ? labels.detailUnavailable : labels.selectAudit" :description="detailError" />
    </div>
    <p v-if="error && page.items.length" class="audit-view__error">{{ labels.pageUnavailable }} · {{ error }}</p>
    <PaginationBar :offset="page.offset" :limit="page.limit" :total="page.total" :labels="labels" @page="emit('page', $event)" />
  </section>
</template>

<style scoped>
.audit-view { display: flex; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }
.audit-view__header { display: flex; flex: none; align-items: flex-end; gap: 10px; border-bottom: 1px solid var(--doctor-border); background: var(--doctor-surface); padding: 11px 14px; }.audit-view__header > div { min-width: 0; flex: 1; }
.audit-view__title { display: flex; align-items: center; gap: 8px; }.audit-view__title h1 { margin: 0; font-size: 14px; }.audit-view__title span { color: var(--doctor-faint); font-size: 10px; }.audit-view__header p { max-width: 52rem; margin: 4px 0 0; color: var(--doctor-muted); font-size: 11px; }
.audit-view__search { display: flex; width: min(25rem, 34vw); height: 30px; align-items: center; gap: 6px; border: 1px solid var(--doctor-border-strong); border-radius: 5px; background: var(--doctor-bg); padding: 0 8px; color: var(--doctor-faint); }.audit-view__search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--doctor-text); font-size: 11px; }.audit-view__status select { height: 30px; border: 1px solid var(--doctor-border-strong); border-radius: 4px; background: var(--doctor-panel); color: var(--doctor-text); font-size: 11px; }
.audit-view__content { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(300px, 5fr) minmax(360px, 6fr); overflow: hidden; }.audit-view__list { min-height: 0; overflow: auto; border-right: 1px solid var(--doctor-border); }
.audit-row { display: grid; width: 100%; gap: 5px; border: 0; border-bottom: 1px solid var(--doctor-border); border-left: 3px solid transparent; background: transparent; padding: 9px 12px; color: var(--doctor-text); cursor: pointer; text-align: left; }.audit-row:hover { background: var(--doctor-surface); }.audit-row[aria-selected='true'] { border-left-color: var(--doctor-accent); background: var(--doctor-accent-muted); }.audit-row > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--doctor-faint); font-size: 10px; }.audit-row strong { font-size: 12px; }.audit-row code { overflow-wrap: anywhere; color: var(--doctor-faint); font-size: 10px; }.audit-row > span { overflow: hidden; color: var(--doctor-muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.audit-detail { min-width: 0; overflow: auto; padding: 16px; }.audit-detail__top { display: flex; align-items: center; gap: 8px; }.audit-detail__top code { color: var(--doctor-faint); font-size: 10px; }.audit-detail h2 { margin: 16px 0 7px; font-size: 12px; }.audit-detail__directive { display: grid; gap: 5px; border: 1px solid var(--doctor-border); border-radius: 5px; background: var(--doctor-code); padding: 10px; }.audit-detail__directive code { overflow-wrap: anywhere; color: var(--doctor-text); }.audit-detail__directive span { overflow-wrap: anywhere; color: var(--doctor-faint); font-size: 10px; }.audit-detail dl { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 8px 12px; margin: 16px 0; font-size: 11px; }.audit-detail dt { color: var(--doctor-faint); }.audit-detail dd { margin: 0; overflow-wrap: anywhere; }.audit-detail__diagnostics { border-top: 1px solid var(--doctor-border); }.audit-detail__diagnostics article { border-bottom: 1px solid var(--doctor-border); padding: 9px 0; }.audit-detail__diagnostics p { margin: 6px 0; color: var(--doctor-muted); font-size: 11px; line-height: 17px; }.audit-detail__diagnostics code { color: var(--doctor-faint); font-size: 10px; }
.audit-detail__diagnostics .audit-detail__error { border-radius: 4px; background: var(--doctor-error-bg); padding: 7px 9px; color: var(--doctor-error-fg); }
.audit-view__error { margin: 0; background: var(--doctor-error-bg); padding: 5px 12px; color: var(--doctor-error-fg); font-size: 10px; }
@media (max-width: 760px) { .audit-view__header { align-items: stretch; flex-wrap: wrap; }.audit-view__header > div { flex-basis: 100%; }.audit-view__search { width: auto; flex: 1; }.audit-view__content { display: block; overflow: auto; }.audit-view__list { max-height: 50vh; border-right: 0; border-bottom: 1px solid var(--doctor-border); }.audit-detail { min-height: 45vh; } }
</style>

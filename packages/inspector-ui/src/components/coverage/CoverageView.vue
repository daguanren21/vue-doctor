<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { InspectorCoverageResult, InspectorSnapshot } from '@daguanren21/vue-doctor-inspector-protocol'
import type { InspectorCoverageFilters } from '../../composables/useInspectorWorkspace'
import type { InspectorMessages } from '../../i18n'
import { coverageCategoryLabel } from '../../lib/status-labels'
import { coverageSummaryTotal } from '../../lib/coverage'
import { inspectorIcons } from '../../lib/icons'
import EmptyState from '../EmptyState.vue'
import PaginationBar from '../workspace/PaginationBar.vue'
import StatusBadge from '../workspace/StatusBadge.vue'

defineProps<{
  snapshot: InspectorSnapshot
  result: InspectorCoverageResult
  filters: InspectorCoverageFilters
  loading: boolean
  error?: string
  labels: InspectorMessages
}>()
const emit = defineEmits<{
  filter: [patch: Partial<InspectorCoverageFilters>]
  page: [offset: number]
  retry: []
}>()
</script>

<template>
  <section class="coverage-view">
    <header class="coverage-view__header">
      <div>
        <div class="coverage-view__title"><Icon :icon="inspectorIcons.pieChart" class="size-4" /><h1>{{ labels.coverage }}</h1><StatusBadge :status="snapshot.coverageStatus" /></div>
        <p>{{ labels.coverageIntro }}</p>
      </div>
      <label class="coverage-view__search"><Icon :icon="inspectorIcons.search" class="size-3.5" /><span class="sr-only">{{ labels.searchCoverage }}</span><input type="search" :value="filters.query" :placeholder="labels.searchCoverage" @input="emit('filter', { query: ($event.target as HTMLInputElement).value })" /></label>
    </header>
    <nav class="coverage-view__facets" :aria-label="labels.coverage">
      <button type="button" :aria-pressed="filters.category === 'all'" @click="emit('filter', { category: 'all' })"><span>{{ labels.all }}</span><strong class="num">{{ coverageSummaryTotal(result.summary) }}</strong></button>
      <button v-for="entry in result.summary" :key="entry.category" type="button" :aria-pressed="filters.category === entry.category" @click="emit('filter', { category: entry.category })"><span>{{ coverageCategoryLabel(entry.category, labels) }}</span><strong class="num">{{ entry.count }}</strong></button>
    </nav>
    <div class="coverage-view__body">
      <EmptyState v-if="error && !result.items.length" variant="error" :title="labels.pageUnavailable" :description="error" :action-label="labels.retry" @action="emit('retry')" />
      <EmptyState v-else-if="!loading && result.total === 0" variant="filter" :title="labels.noCoverageItems" :description="labels.coverageIntro" />
      <div v-else class="coverage-table" role="list">
        <article v-for="item in result.items" :key="item.id" class="coverage-row" role="listitem">
          <div class="coverage-row__top"><StatusBadge :status="item.status" /><span>{{ coverageCategoryLabel(item.category, labels) }}</span><span v-if="item.count" class="num coverage-row__count">× {{ item.count }}</span></div>
          <h2>{{ item.title }}</h2><p>{{ item.message }}</p>
          <div class="coverage-row__facts"><code v-if="item.file">{{ item.file }}</code><code v-if="item.ruleCode">{{ item.ruleCode }}</code><code v-if="item.package">{{ item.package }}</code><span v-if="item.reasonCode">{{ item.reasonCode }}</span></div>
        </article>
      </div>
    </div>
    <p v-if="error && result.items.length" class="coverage-view__error">{{ labels.pageUnavailable }} · {{ error }}</p>
    <PaginationBar :offset="result.offset" :limit="result.limit" :total="result.total" :labels="labels" @page="emit('page', $event)" />
  </section>
</template>

<style scoped>
.coverage-view { display: flex; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }
.coverage-view__header { display: flex; flex: none; align-items: flex-end; gap: 20px; border-bottom: 1px solid var(--doctor-border); background: var(--doctor-surface); padding: 14px 16px; }
.coverage-view__header > div { min-width: 0; flex: 1; }
.coverage-view__title { display: flex; align-items: center; gap: 8px; }
.coverage-view__title h1 { margin: 0; font-size: 14px; }
.coverage-view__header p { max-width: 52rem; margin: 5px 0 0; color: var(--doctor-muted); font-size: 11px; line-height: 17px; }
.coverage-view__search { display: flex; width: min(28rem, 40vw); height: 30px; align-items: center; gap: 6px; border: 1px solid var(--doctor-border-strong); border-radius: 5px; background: var(--doctor-bg); padding: 0 8px; color: var(--doctor-faint); }
.coverage-view__search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--doctor-text); font-size: 12px; }
.coverage-view__facets { display: flex; flex: none; gap: 5px; overflow-x: auto; border-bottom: 1px solid var(--doctor-border); padding: 8px 12px; }
.coverage-view__facets button { display: inline-flex; min-width: max-content; align-items: center; gap: 7px; border: 1px solid var(--doctor-border); border-radius: 4px; background: var(--doctor-surface); padding: 5px 8px; color: var(--doctor-muted); cursor: pointer; font-size: 11px; }
.coverage-view__facets button[aria-pressed='true'] { border-color: var(--doctor-accent); background: var(--doctor-accent-muted); color: var(--doctor-text); }
.coverage-view__facets strong { color: var(--doctor-faint); font-size: 10px; }
.coverage-view__body { min-height: 0; flex: 1; overflow: auto; padding: 0 14px; }
.coverage-table { max-width: 100rem; margin: 0 auto; }
.coverage-row { display: grid; gap: 5px; border-bottom: 1px solid var(--doctor-border); padding: 12px 3px; }
.coverage-row__top { display: flex; align-items: center; gap: 8px; color: var(--doctor-faint); font-size: 10px; }
.coverage-row__count { margin-left: auto; }
.coverage-row h2 { margin: 0; font-size: 12px; }
.coverage-row p { margin: 0; overflow-wrap: anywhere; color: var(--doctor-muted); font-size: 11px; line-height: 17px; }
.coverage-row__facts { display: flex; flex-wrap: wrap; gap: 5px 12px; color: var(--doctor-faint); font-size: 10px; }
.coverage-row__facts code { overflow-wrap: anywhere; }
.coverage-view__error { margin: 0; background: var(--doctor-error-bg); padding: 5px 12px; color: var(--doctor-error-fg); font-size: 10px; }
@media (max-width: 720px) { .coverage-view__header { align-items: stretch; flex-direction: column; }.coverage-view__search { width: 100%; } }
</style>

<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { InspectorPage, InspectorRuleItem, InspectorSnapshot } from '@vue-doctor/inspector-protocol'
import type { InspectorRuleFilters } from '../../composables/useInspectorWorkspace'
import type { InspectorMessages } from '../../i18n'
import { inspectorIcons } from '../../lib/icons'
import { inspectorButton } from '../../lib/variants'
import { ruleStatusLabel } from '../../lib/status-labels'
import EmptyState from '../EmptyState.vue'
import PaginationBar from '../workspace/PaginationBar.vue'
import StatusBadge from '../workspace/StatusBadge.vue'

const props = defineProps<{
  snapshot: InspectorSnapshot
  page: InspectorPage<InspectorRuleItem>
  filters: InspectorRuleFilters
  loading: boolean
  error?: string
  labels: InspectorMessages
}>()
const emit = defineEmits<{ filter: [patch: Partial<InspectorRuleFilters>]; page: [offset: number]; retry: []; showFindings: [ruleCode: string] }>()
const selectedCode = shallowRef<string>()
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')
const selected = computed(() => props.page.items.find(item => item.code === selectedCode.value) ?? props.page.items[0])
watch(() => props.page.snapshotId, () => {
  if (selectedCode.value && !props.page.items.some(item => item.code === selectedCode.value)) selectedCode.value = undefined
})
const statuses = ['checked', 'partial', 'unavailable', 'runtime', 'manual', 'policy-pending', 'disabled', 'not-applicable', 'not-reported'] as const

function clearFilters() {
  emit('filter', { query: '', status: 'all', pack: '' })
  searchInput.value?.focus()
}

function moveSelection(event: KeyboardEvent, index: number) {
  let next: number
  if (event.key === 'ArrowDown') next = Math.min(props.page.items.length - 1, index + 1)
  else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = props.page.items.length - 1
  else return
  event.preventDefault()
  const item = props.page.items[next]
  if (!item) return
  selectedCode.value = item.code
  const list = (event.currentTarget as HTMLElement).closest('[role="listbox"]')
  list?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus()
}
</script>

<template>
  <section class="rules-view" :aria-busy="loading">
    <header class="rules-view__header">
      <div class="rules-view__intro">
        <div class="rules-view__title"><Icon :icon="inspectorIcons.listChecks" class="size-5" /><h1>{{ labels.rules }}</h1><span class="num">{{ page.total }}</span><span v-if="loading" class="rules-view__loading" role="status">{{ labels.refreshing }}</span></div>
        <p>{{ labels.ruleStatusHint }}</p>
      </div>
      <div class="rules-view__toolbar">
        <label class="rules-view__search"><Icon :icon="inspectorIcons.search" class="size-4" /><span class="sr-only">{{ labels.searchRules }}</span><input ref="searchInput" type="search" :value="filters.query" :placeholder="labels.searchRules" @input="emit('filter', { query: ($event.target as HTMLInputElement).value })" /><kbd aria-hidden="true">/</kbd></label>
        <label class="rules-view__status"><span>{{ labels.checkStatus }}</span><select :value="filters.status" @change="emit('filter', { status: ($event.target as HTMLSelectElement).value as InspectorRuleFilters['status'] })"><option value="all">{{ labels.checkAll }}</option><option v-for="status in statuses" :key="status" :value="status">{{ ruleStatusLabel(status, labels) }}</option></select></label>
        <button v-if="filters.query || filters.status !== 'all' || filters.pack" type="button" :class="inspectorButton({ intent: 'ghost' })" @click="clearFilters"><Icon :icon="inspectorIcons.close" class="size-3.5" />{{ labels.clearFilters }}</button>
      </div>
    </header>
    <div class="rules-view__content">
      <div class="rules-view__list" role="listbox" :aria-label="labels.rules">
        <EmptyState v-if="error && !page.items.length" variant="error" :title="labels.pageUnavailable" :description="error" :action-label="labels.retry" @action="emit('retry')" />
        <EmptyState v-else-if="!loading && page.total === 0" variant="filter" :title="labels.noRules" :action-label="labels.clearFilters" @action="clearFilters" />
        <button v-for="(item, index) in page.items" :key="item.code" type="button" role="option" class="rule-row" :aria-selected="selected?.code === item.code" :tabindex="selected?.code === item.code ? 0 : -1" @click="selectedCode = item.code" @keydown="moveSelection($event, index)">
          <div><StatusBadge :status="item.status" :label="ruleStatusLabel(item.status, labels)" /><span class="num">{{ item.findingCount }} {{ labels.findingsCount }}</span></div>
          <code>{{ item.code }}</code><span v-if="item.name !== item.code" class="rule-row__name">{{ item.name }}</span><span class="rule-row__pack">{{ item.pack }}</span>
        </button>
      </div>
      <article v-if="selected" class="rule-detail">
        <div class="rule-detail__top"><StatusBadge :status="selected.status" :label="ruleStatusLabel(selected.status, labels)" /><span v-if="selected.verification">{{ labels.verification }} · {{ selected.verification }}</span></div>
        <h2>{{ selected.name }}</h2><code class="rule-detail__code">{{ selected.code }}</code>
        <p v-if="selected.summary && selected.summary !== selected.name">{{ selected.summary }}</p>
        <dl>
          <dt>{{ labels.rulePack }}</dt><dd>{{ selected.pack }}</dd>
          <dt>{{ labels.findingCount }}</dt><dd class="num">{{ selected.findingCount }}</dd>
          <dt>{{ labels.severity }}</dt><dd>{{ selected.severity ?? '—' }}</dd>
          <dt>{{ labels.tags }}</dt><dd>{{ selected.tags.join(', ') || '—' }}</dd>
          <dt>{{ labels.standards }}</dt><dd>{{ selected.standards.join(', ') || '—' }}</dd>
        </dl>
        <section v-if="selected.skipReason" class="rule-detail__reason"><h3>{{ labels.skipReason }}</h3><p>{{ selected.skipReason }}</p></section>
        <button v-if="selected.findingCount > 0" type="button" :class="inspectorButton({ intent: 'active', size: 'sm' })" class="rule-detail__findings" @click="emit('showFindings', selected.code)">{{ labels.showRuleFindings }}</button>
        <p v-if="selected.status !== 'checked' && selected.status !== 'not-applicable'" class="rule-detail__warning"><Icon :icon="inspectorIcons.alert" class="size-3.5" />{{ labels.ruleStatusHint }}</p>
      </article>
      <EmptyState v-else class="rule-detail" variant="select" :title="labels.selectRule" />
    </div>
    <p v-if="error && page.items.length" class="rules-view__error">{{ labels.pageUnavailable }} · {{ error }}</p>
    <PaginationBar :offset="page.offset" :limit="page.limit" :total="page.total" :labels="labels" @page="emit('page', $event)" />
  </section>
</template>

<style scoped>
.rules-view { display: flex; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }
.rules-view__header { display: grid; flex: none; gap: 18px; border-bottom: 1px solid var(--doctor-border); background: var(--doctor-surface); padding: 24px; }
.rules-view__intro { min-width: 0; }
.rules-view__title { display: flex; align-items: center; gap: 10px; }
.rules-view__title h1 { margin: 0; font-size: 20px; font-weight: 600; }
.rules-view__title .num { border: 1px solid var(--doctor-border); border-radius: 5px; padding: 1px 7px; color: var(--doctor-muted); font-size: 12px; }
.rules-view__loading { margin-left: auto; color: var(--doctor-muted); font-size: 12px; }
.rules-view__header p { margin: 6px 0 0; color: var(--doctor-muted); font-size: 13px; }
.rules-view__toolbar { display: flex; align-items: center; gap: 16px; }
.rules-view__toolbar > button { flex: none; gap: 6px; }
.rules-view__search { display: flex; min-width: 0; height: 42px; flex: 1; align-items: center; gap: 10px; border: 1px solid var(--doctor-border-strong); border-radius: 7px; background: var(--doctor-bg); padding: 0 12px; color: var(--doctor-muted); }
.rules-view__search:focus-within { border-color: var(--doctor-accent-fg); box-shadow: 0 0 0 1px var(--doctor-accent-fg); }
.rules-view__search input { width: 100%; min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--doctor-text); font-size: 14px; }
.rules-view__search kbd { border: 1px solid var(--doctor-border); border-radius: 3px; padding: 0 5px; font-size: 12px; }
.rules-view__status { display: flex; align-items: center; gap: 8px; color: var(--doctor-muted); font-size: 12px; }
.rules-view__status select { height: 40px; max-width: 13rem; border: 1px solid var(--doctor-border-strong); border-radius: 6px; background: var(--doctor-surface); padding: 0 10px; color: var(--doctor-text); font-size: 13px; }
.rules-view__content { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(300px, 5fr) minmax(360px, 6fr); overflow: hidden; }
.rules-view__list { min-height: 0; overflow: auto; border-right: 1px solid var(--doctor-border); }
.rule-row { display: grid; width: 100%; gap: 7px; border: 0; border-bottom: 1px solid var(--doctor-border); border-left: 3px solid transparent; background: transparent; padding: 16px 20px; color: var(--doctor-text); cursor: pointer; text-align: left; transition: background-color 120ms; }
.rule-row:hover { background: var(--doctor-surface); }
.rule-row[aria-selected='true'] { border-left-color: var(--doctor-accent); background: var(--doctor-accent-muted); }
.rule-row > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--doctor-muted); font-size: 12px; }
.rule-row code { color: var(--doctor-text); font-size: 13px; overflow-wrap: anywhere; }
.rule-row__name { color: var(--doctor-muted); font-size: 13px; overflow-wrap: anywhere; }
.rule-row__pack { color: var(--doctor-faint); font-size: 11px; }
.rule-detail { min-width: 0; overflow: auto; background: var(--doctor-surface); padding: 28px; }
.rule-detail__top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; color: var(--doctor-muted); font-size: 12px; }
.rule-detail h2 { margin: 20px 0 8px; font-size: 20px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.rule-detail__code { color: var(--doctor-muted); font-size: 12px; overflow-wrap: anywhere; }
.rule-detail > p { margin: 18px 0; color: var(--doctor-muted); font-size: 14px; line-height: 1.65; }
.rule-detail dl { display: grid; grid-template-columns: 8rem minmax(0, 1fr); gap: 16px; margin: 26px 0; border-top: 1px solid var(--doctor-border); padding-top: 22px; font-size: 13px; }
.rule-detail dt { color: var(--doctor-muted); }
.rule-detail dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.rule-detail__reason { border-top: 1px solid var(--doctor-border); padding-top: 18px; }
.rule-detail__reason h3 { margin: 0; font-size: 13px; }
.rule-detail__reason p { color: var(--doctor-muted); font-size: 13px; line-height: 1.65; }
.rule-detail__findings { margin: 12px 0; }
.rule-detail__warning { display: flex; align-items: flex-start; gap: 8px; border: 1px solid color-mix(in srgb, var(--doctor-warning-fg) 30%, transparent); border-radius: 6px; background: var(--doctor-warning-bg); padding: 12px; color: var(--doctor-warning-fg) !important; font-size: 13px !important; }
.rules-view__error { margin: 0; background: var(--doctor-error-bg); padding: 8px 16px; color: var(--doctor-error-fg); font-size: 13px; }
@media (max-width: 760px) {
  .rules-view { overflow: auto; }
  .rules-view__header { gap: 14px; padding: 18px 16px; }
  .rules-view__toolbar { flex-wrap: wrap; gap: 12px; }
  .rules-view__search { flex-basis: 100%; }
  .rules-view__content { display: block; flex: none; overflow: visible; }
  .rules-view__list { max-height: 50vh; border-right: 0; border-bottom: 1px solid var(--doctor-border); }
  .rule-detail { min-height: 45vh; padding: 22px 16px; }
  .rule-row { padding: 14px 16px; }
}
</style>

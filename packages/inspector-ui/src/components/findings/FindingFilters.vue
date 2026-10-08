<script setup lang="ts">
import { computed, shallowRef, useTemplateRef } from 'vue'
import { Icon } from '@iconify/vue'
import type { InspectorSnapshot } from '@vue-doctor/inspector-protocol'
import type { InspectorFindingFilters } from '../../composables/useInspectorWorkspace'
import type { InspectorMessages } from '../../i18n'
import { inspectorIcons } from '../../lib/icons'
import { inspectorButton } from '../../lib/variants'
import InspectorSelect from '../workspace/InspectorSelect.vue'

const props = defineProps<{
  snapshot: InspectorSnapshot
  filters: InspectorFindingFilters
  labels: InspectorMessages
}>()
const emit = defineEmits<{ filter: [patch: Partial<InspectorFindingFilters>] }>()
const expanded = shallowRef(false)
const searchInput = useTemplateRef<HTMLInputElement>('searchInput')
const activeCount = computed(() => [
  props.filters.query, props.filters.severity !== 'all', props.filters.confidence !== 'all',
  props.filters.domain, props.filters.rule, props.filters.package, props.filters.source, props.filters.includeSuggestions
].filter(Boolean).length)

function clearFilters() {
  emit('filter', { query: '', severity: 'all', confidence: 'all', domain: '', rule: '', package: '', source: '', includeSuggestions: false })
  searchInput.value?.focus()
}
const confidenceOptions = computed(() => [
  { value: 'all', label: props.labels.all },
  { value: 'high', label: props.labels.confidenceHigh },
  { value: 'medium', label: props.labels.confidenceMedium },
  { value: 'low', label: props.labels.confidenceLow }
])
const ruleOptions = computed(() => [
  { value: '', label: props.labels.all, count: props.snapshot.counts.findings },
  ...props.snapshot.facets.rules.map(entry => ({ value: entry.value, label: entry.value, count: entry.count }))
])
const packageOptions = computed(() => [
  { value: '', label: props.labels.all, count: props.snapshot.counts.findings },
  ...props.snapshot.facets.packages.map(entry => ({ value: entry.value, label: entry.value, count: entry.count }))
])
</script>

<template>
  <aside class="finding-filters" :aria-label="labels.filters" :data-expanded="expanded">
    <header class="finding-filters__header">
      <h2>{{ labels.filters }}</h2>
      <button type="button" class="finding-filters__disclosure" :class="inspectorButton()" :aria-expanded="expanded" aria-controls="finding-filter-controls" @click="expanded = !expanded">
        <Icon :icon="inspectorIcons.filter" class="size-4" />{{ labels.filters }}<span v-if="activeCount" class="num">{{ activeCount }}</span>
        <Icon :icon="inspectorIcons.chevronDown" class="size-3.5 finding-filters__chevron" />
      </button>
      <button v-if="activeCount" type="button" :class="inspectorButton({ intent: 'ghost', size: 'sm' })" @click="clearFilters">{{ labels.clearFilters }}</button>
    </header>
    <label class="finding-filters__search">
      <Icon :icon="inspectorIcons.search" class="size-3.5" />
      <span class="sr-only">{{ labels.search }}</span>
      <input
        ref="searchInput"
        type="search"
        :value="filters.query"
        :placeholder="labels.searchPlaceholder"
        @input="emit('filter', { query: ($event.target as HTMLInputElement).value })"
      />
    </label>
    <div id="finding-filter-controls" class="finding-filters__controls">

    <section class="finding-filters__section">
      <h2>{{ labels.severity }}</h2>
      <button
        v-for="entry in [{ value: 'all', count: snapshot.counts.findings }, ...snapshot.facets.severities]"
        :key="entry.value"
        type="button"
        :aria-pressed="filters.severity === entry.value"
        @click="emit('filter', { severity: entry.value as InspectorFindingFilters['severity'] })"
      >
        <span>{{ entry.value === 'all' ? labels.all : entry.value === 'error' ? labels.errors : entry.value === 'warning' ? labels.warnings : labels.info }}</span>
        <span class="num">{{ entry.count }}</span>
      </button>
    </section>

    <section class="finding-filters__section">
      <h2>{{ labels.domain }}</h2>
      <button type="button" :aria-pressed="!filters.domain" @click="emit('filter', { domain: '' })">
        <span>{{ labels.all }}</span><span class="num">{{ snapshot.counts.findings }}</span>
      </button>
      <button
        v-for="entry in snapshot.facets.domains"
        :key="entry.value"
        type="button"
        :aria-pressed="filters.domain === entry.value"
        @click="emit('filter', { domain: entry.value })"
      >
        <span class="finding-filters__value">{{ entry.value }}</span><span class="num">{{ entry.count }}</span>
      </button>
    </section>

    <section class="finding-filters__section finding-filters__fields">
      <InspectorSelect :model-value="filters.confidence" :label="labels.confidenceLabel" :icon="inspectorIcons.shieldCheck" neutral-value="all" :options="confidenceOptions" @update:model-value="emit('filter', { confidence: $event as InspectorFindingFilters['confidence'] })" />
      <InspectorSelect :model-value="filters.rule" :label="labels.rule" :icon="inspectorIcons.rule" :options="ruleOptions" searchable :search-placeholder="labels.searchRules" :empty-label="labels.noSelectMatches" @update:model-value="emit('filter', { rule: $event })" />
      <InspectorSelect :model-value="filters.package" :label="labels.packageFilter" :icon="inspectorIcons.package" :options="packageOptions" searchable :search-placeholder="labels.searchPackages" :empty-label="labels.noSelectMatches" @update:model-value="emit('filter', { package: $event })" />
    </section>

    <label class="finding-filters__toggle">
      <input type="checkbox" :checked="filters.includeSuggestions" @change="emit('filter', { includeSuggestions: ($event.target as HTMLInputElement).checked })" />
      <span>{{ labels.showSuggestions }}</span>
    </label>
    </div>
  </aside>
</template>

<style scoped>
.finding-filters { min-width: 0; overflow: auto; border-right: 1px solid var(--doctor-border); background: var(--doctor-surface); padding: 16px; }
.finding-filters__header { display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: 4px; margin-bottom: 10px; }
.finding-filters__header h2 { margin: 0; font-size: 13px; font-weight: 600; }
.finding-filters__header > button { font-size: 12px; }
.finding-filters__disclosure { display: none; gap: 6px; }
.finding-filters__search { display: flex; height: 38px; align-items: center; gap: 8px; border: 1px solid var(--doctor-border-strong); border-radius: 6px; background: var(--doctor-bg); padding: 0 10px; color: var(--doctor-muted); }
.finding-filters__search:focus-within { border-color: var(--doctor-accent-fg); box-shadow: 0 0 0 1px var(--doctor-accent-fg); }
.finding-filters__search input { width: 100%; min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--doctor-text); font-size: 13px; }
.finding-filters__section { margin-top: 22px; }
.finding-filters__section h2 { margin: 0 8px 6px; color: var(--doctor-muted); font-size: 12px; font-weight: 600; }
.finding-filters__section > button { display: flex; width: 100%; min-height: 34px; align-items: center; justify-content: space-between; gap: 8px; border: 0; border-left: 2px solid transparent; border-radius: 4px; background: transparent; padding: 5px 8px; color: var(--doctor-muted); cursor: pointer; text-align: left; font-size: 13px; transition: background-color 150ms, color 150ms; }
.finding-filters__section > button:hover { background: var(--doctor-panel); color: var(--doctor-text); }
.finding-filters__section > button[aria-pressed='true'] { border-left-color: var(--doctor-accent); background: var(--doctor-accent-muted); color: var(--doctor-text); }
.finding-filters__section .num { font-size: 12px; }
.finding-filters__value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.finding-filters__fields { display: grid; gap: 14px; }
.finding-filters__toggle { display: flex; align-items: center; gap: 8px; margin-top: 20px; border-top: 1px solid var(--doctor-border); padding: 14px 0 0; color: var(--doctor-muted); font-size: 12px; }
.finding-filters__toggle input { width: 16px; height: 16px; accent-color: var(--doctor-accent-fg); }
@media (max-width: 1080px) {
  .finding-filters { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; border-right: 0; border-bottom: 1px solid var(--doctor-border); padding: 12px 16px; }
  .finding-filters__header { grid-column: 2; grid-row: 1; margin: 0; }
  .finding-filters__header h2 { display: none; }
  .finding-filters__disclosure { display: inline-flex; min-height: 40px; }
  .finding-filters__chevron { transition: transform 160ms ease-out; }
  .finding-filters[data-expanded='true'] .finding-filters__chevron { transform: rotate(180deg); }
  .finding-filters__search { grid-column: 1; grid-row: 1; }
  .finding-filters__controls { display: none; grid-column: 1 / -1; max-height: 50vh; overflow: auto; }
  .finding-filters[data-expanded='true'] .finding-filters__controls { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
  .finding-filters__section { margin: 0; }
  .finding-filters__toggle { grid-column: 1 / -1; margin: 0; }
}
@media (max-width: 600px) {
  .finding-filters { gap: 8px; padding: 12px; }
  .finding-filters[data-expanded='true'] .finding-filters__controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .finding-filters__fields { grid-column: 1 / -1; }
  .finding-filters__section > button { min-height: 40px; }
}
</style>

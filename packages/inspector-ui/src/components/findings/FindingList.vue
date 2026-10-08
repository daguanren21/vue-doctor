<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { InspectorFindingSummary, InspectorPage } from '@vue-doctor/inspector-protocol'
import type { InspectorMessages } from '../../i18n'
import { inspectorIcons } from '../../lib/icons'
import { severityBadge } from '../../lib/variants'
import EmptyState from '../EmptyState.vue'
import PaginationBar from '../workspace/PaginationBar.vue'

const props = defineProps<{
  page: InspectorPage<InspectorFindingSummary>
  selectedId?: string
  loading: boolean
  error?: string
  labels: InspectorMessages
  coverageComplete: boolean
  globalFindingCount: number
}>()
const emit = defineEmits<{ select: [id: string]; page: [offset: number]; retry: [] }>()

function severityIcon(severity: InspectorFindingSummary['severity']) {
  if (severity === 'error') return inspectorIcons.octagonAlert
  if (severity === 'warning') return inspectorIcons.alert
  return inspectorIcons.info
}

function moveSelection(event: KeyboardEvent, index: number, delta: number) {
  event.preventDefault()
  const next = Math.max(0, Math.min(props.page.items.length - 1, index + delta))
  const item = props.page.items[next]
  if (!item) return
  emit('select', item.id)
  const list = (event.currentTarget as HTMLElement).closest('[role="listbox"]')
  ;(list?.querySelectorAll<HTMLElement>('[role="option"]')[next])?.focus()
}
</script>

<template>
  <section class="finding-list" :aria-label="labels.findings">
    <header class="finding-list__header" aria-live="polite" aria-atomic="true">
      <h1>{{ labels.findings }}</h1>
      <span class="num">{{ page.total }}</span>
      <span v-if="loading" class="finding-list__loading">{{ labels.refreshing }}</span>
    </header>
    <div class="finding-list__body">
      <EmptyState
        v-if="error && page.items.length === 0"
        variant="error"
        :title="labels.pageUnavailable"
        :description="`${labels.pageUnavailableHint} ${error}`"
        :action-label="labels.retry"
        @action="emit('retry')"
      />
      <EmptyState
        v-else-if="!loading && page.total === 0"
        :variant="globalFindingCount > 0 ? 'filter' : coverageComplete ? 'clean' : 'incomplete'"
        :title="globalFindingCount > 0 ? labels.noMatches : coverageComplete ? labels.reportClean : labels.notClean"
        :description="globalFindingCount > 0 ? labels.noMatchesHint : coverageComplete ? labels.reportCleanHint : labels.notCleanHint"
      />
      <div v-else role="listbox" :aria-label="labels.findings">
        <button
          v-for="(item, index) in page.items"
          :key="item.id"
          type="button"
          role="option"
          class="finding-row"
          :data-severity="item.severity"
          :aria-selected="selectedId === item.id"
          :tabindex="selectedId === item.id || (!selectedId && index === 0) ? 0 : -1"
          @click="emit('select', item.id)"
          @keydown.arrow-down="moveSelection($event, index, 1)"
          @keydown.arrow-up="moveSelection($event, index, -1)"
        >
          <span class="finding-row__top">
            <span :class="severityBadge({ severity: item.severity })"><Icon :icon="severityIcon(item.severity)" class="size-3" />{{ item.severity }}</span>
            <code :title="item.ruleCode">{{ item.ruleCode }}</code>
            <span class="finding-row__confidence"><i :data-confidence="item.confidence" />{{ item.confidence }}</span>
          </span>
          <span class="finding-row__message">{{ item.message }}</span>
          <span class="finding-row__path mono" :title="item.file ?? item.source">{{ item.file ?? item.source }}{{ item.line ? `:${item.line}` : '' }}</span>
        </button>
      </div>
    </div>
    <p v-if="error && page.items.length" class="finding-list__inline-error" role="status">{{ labels.pageUnavailable }} · {{ error }}</p>
    <PaginationBar :offset="page.offset" :limit="page.limit" :total="page.total" :labels="labels" @page="emit('page', $event)" />
  </section>
</template>

<style scoped>
.finding-list { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; border-right: 1px solid var(--doctor-border); background: var(--doctor-bg); }
.finding-list__header { display: flex; min-height: 54px; flex: none; align-items: center; gap: 8px; border-bottom: 1px solid var(--doctor-border); padding: 10px 18px; }
.finding-list__header h1 { margin: 0; font-size: 14px; font-weight: 600; }
.finding-list__header > span { color: var(--doctor-muted); font-size: 12px; }
.finding-list__loading { margin-left: auto; }
.finding-list__body { min-height: 0; flex: 1; overflow: auto; }
.finding-row { position: relative; display: grid; width: 100%; gap: 7px; border: 0; border-bottom: 1px solid var(--doctor-border); border-left: 3px solid transparent; background: transparent; padding: 13px 15px; color: var(--doctor-text); cursor: pointer; text-align: left; transition: background-color 120ms; }
.finding-row:hover { background: var(--doctor-surface); }
.finding-row[aria-selected='true'] { border-left-color: var(--doctor-accent); background: var(--doctor-accent-muted); }
.finding-row__top { display: flex; min-width: 0; align-items: center; gap: 7px; }
.finding-row__top code { min-width: 0; overflow: hidden; color: var(--doctor-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.finding-row__confidence { display: inline-flex; margin-left: auto; align-items: center; gap: 4px; color: var(--doctor-faint); font-size: 11px; }
.finding-row__confidence i { width: 6px; height: 6px; border-radius: 50%; background: var(--doctor-faint); }
.finding-row__confidence i[data-confidence='high'] { background: var(--doctor-accent); }
.finding-row__confidence i[data-confidence='medium'] { background: var(--doctor-warning-fg); }
.finding-row__message { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.finding-row__path { overflow: hidden; color: var(--doctor-faint); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.finding-list__inline-error { margin: 0; border-top: 1px solid var(--doctor-error-fg); background: var(--doctor-error-bg); padding: 8px 16px; color: var(--doctor-error-fg); font-size: 12px; }
</style>

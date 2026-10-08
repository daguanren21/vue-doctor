<script setup lang="ts">
import type { InspectorEditor, InspectorFindingDetail, InspectorFindingSummary, InspectorPage, InspectorSnapshot, InspectorSnippet } from '@vue-doctor/inspector-protocol'
import type { InspectorFindingFilters } from '../../composables/useInspectorWorkspace'
import type { InspectorMessages } from '../../i18n'
import FindingDetail from './FindingDetail.vue'
import FindingFilters from './FindingFilters.vue'
import FindingList from './FindingList.vue'

defineProps<{
  snapshot: InspectorSnapshot
  filters: InspectorFindingFilters
  page: InspectorPage<InspectorFindingSummary>
  selectedId?: string
  selected?: InspectorFindingDetail
  snippet?: InspectorSnippet
  loading: boolean
  error?: string
  detailLoading: boolean
  detailError?: string
  editorError?: string
  editor: InspectorEditor
  labels: InspectorMessages
}>()
const emit = defineEmits<{
  filter: [patch: Partial<InspectorFindingFilters>]
  select: [id: string]
  page: [offset: number]
  retry: []
  open: []
  updateEditor: [editor: InspectorEditor]
  evidencePage: [offset: number]
}>()
</script>

<template>
  <div class="findings-view">
    <FindingFilters :snapshot="snapshot" :filters="filters" :labels="labels" @filter="emit('filter', $event)" />
    <FindingList
      :page="page"
      :selected-id="selectedId"
      :loading="loading"
      :error="error"
      :labels="labels"
      :coverage-complete="snapshot.coverageStatus === 'complete'"
      :global-finding-count="snapshot.counts.findings"
      @select="emit('select', $event)"
      @page="emit('page', $event)"
      @retry="emit('retry')"
    />
    <FindingDetail
      :finding="selected"
      :snippet="snippet"
      :selected-id="selectedId"
      :loading="detailLoading"
      :error="detailError"
      :editor-error="editorError"
      :editor="editor"
      :labels="labels"
      @open="emit('open')"
      @update-editor="emit('updateEditor', $event)"
      @evidence-page="emit('evidencePage', $event)"
    />
  </div>
</template>

<style scoped>
.findings-view { display: grid; min-width: 0; min-height: 0; flex: 1; grid-template-columns: 240px minmax(320px, 5fr) minmax(400px, 6fr); overflow: hidden; }
@media (max-width: 1080px) {
  .findings-view { grid-template-columns: minmax(290px, 1fr) minmax(340px, 1.1fr); grid-template-rows: auto minmax(0, 1fr); }
  .findings-view > :first-child { grid-column: 1 / -1; }
}
@media (max-width: 720px) {
  .findings-view { display: block; overflow: auto; }
  .findings-view > :nth-child(2) { height: 52vh; min-height: 22rem; border-right: 0; border-bottom: 1px solid var(--doctor-border); }
  .findings-view > :nth-child(3) { min-height: 55vh; }
}
</style>

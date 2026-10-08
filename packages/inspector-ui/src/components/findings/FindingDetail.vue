<script setup lang="ts">
import { computed, shallowRef, useId, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { INSPECTOR_EDITORS, isInspectorEditor } from '@vue-doctor/inspector-protocol'
import type {
  InspectorEditor,
  InspectorFindingDetail,
  InspectorSnippet
} from '@vue-doctor/inspector-protocol'
import type { InspectorMessages } from '../../i18n'
import { inspectorIcons } from '../../lib/icons'
import { inspectorButton, severityBadge } from '../../lib/variants'
import EmptyState from '../EmptyState.vue'
import PaginationBar from '../workspace/PaginationBar.vue'
import InspectorSelect from '../workspace/InspectorSelect.vue'

const props = defineProps<{
  finding?: InspectorFindingDetail
  snippet?: InspectorSnippet
  selectedId?: string
  loading: boolean
  error?: string
  editorError?: string
  editor: InspectorEditor
  labels: InspectorMessages
}>()
const emit = defineEmits<{
  open: []
  updateEditor: [editor: InspectorEditor]
  evidencePage: [offset: number]
}>()

type DetailTab = 'evidence' | 'source' | 'fixes' | 'rule'
const tab = shallowRef<DetailTab>('evidence')
const tabId = useId()
const editorLabels: Record<InspectorEditor, string> = { vscode: 'VS Code', cursor: 'Cursor', webstorm: 'WebStorm' }
const editors = INSPECTOR_EDITORS.map(value => ({ value, label: editorLabels[value] }))
const tabs = computed(() => [
  { id: 'evidence' as const, label: props.labels.evidence, count: props.finding?.evidenceTotal ?? 0 },
  { id: 'source' as const, label: props.labels.sourceCode },
  { id: 'fixes' as const, label: props.labels.fixes, count: props.finding?.suggestions.length ?? 0 },
  { id: 'rule' as const, label: props.labels.ruleContext }
])
const snippetLines = computed(() => props.snippet?.content.split(/\r?\n/).map((text, index) => ({
  number: props.snippet!.startLine + index,
  text
})) ?? [])

watch(() => props.selectedId, () => { tab.value = 'evidence' })

function navigateTabs(event: KeyboardEvent) {
  const current = tabs.value.findIndex(entry => entry.id === tab.value)
  let next: number
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.value.length
  else if (event.key === 'ArrowLeft') next = (current + tabs.value.length - 1) % tabs.value.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = tabs.value.length - 1
  else return
  event.preventDefault()
  tab.value = tabs.value[next]!.id
  const tabList = (event.currentTarget as HTMLElement).parentElement
  tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
}

function selectEditor(value: string) {
  if (isInspectorEditor(value)) emit('updateEditor', value)
}
</script>

<template>
  <aside class="finding-detail" :aria-label="labels.evidence">
    <EmptyState
      v-if="!selectedId"
      variant="select"
      :title="labels.selectFindingTitle"
      :description="labels.selectFindingHint"
    />
    <div v-else-if="loading && !finding" class="finding-detail__loading" role="status">
      <Icon :icon="inspectorIcons.refresh" class="size-4 animate-spin" />
      {{ labels.loadingDetails }}
    </div>
    <EmptyState
      v-else-if="error && !finding"
      variant="error"
      :title="labels.detailUnavailable"
      :description="error"
    />
    <template v-else-if="finding">
      <header class="finding-detail__header">
        <div class="finding-detail__badges">
          <span :class="severityBadge({ severity: finding.severity })">{{ finding.severity }}</span>
          <code>{{ finding.ruleCode }}</code>
          <span class="finding-detail__confidence"><i :data-confidence="finding.confidence" />{{ finding.confidence }} {{ labels.confidence }}</span>
        </div>
        <h2>{{ finding.message }}</h2>
        <p v-if="finding.file" class="mono finding-detail__location">{{ finding.file }}{{ finding.line ? `:${finding.line}` : '' }}{{ finding.column ? `:${finding.column}` : '' }}</p>
        <div class="finding-detail__actions">
          <InspectorSelect
            class="finding-detail__editor"
            :model-value="editor"
            :label="labels.openIn"
            :options="editors"
            :icon="inspectorIcons.braces"
            hide-label
            :highlight-selection="false"
            @update:model-value="selectEditor"
          />
          <button type="button" :class="inspectorButton({ intent: 'active', size: 'md' })" :disabled="!finding.file" @click="emit('open')">
            <Icon :icon="inspectorIcons.externalLink" class="size-3.5" />{{ labels.openSource }}
          </button>
        </div>
        <p v-if="editorError" class="finding-detail__error" role="status">{{ editorError }}</p>
      </header>

      <div class="finding-detail__tabs" role="tablist" :aria-label="labels.details">
        <button
          v-for="entry in tabs"
          :key="entry.id"
          type="button"
          role="tab"
          :aria-selected="tab === entry.id"
          :id="`${tabId}-${entry.id}`"
          :aria-controls="`${tabId}-panel`"
          :tabindex="tab === entry.id ? 0 : -1"
          @keydown="navigateTabs"
          @click="tab = entry.id"
        >
          {{ entry.label }} <span v-if="entry.count !== undefined" class="num">{{ entry.count }}</span>
        </button>
      </div>

      <div :id="`${tabId}-panel`" class="finding-detail__body" role="tabpanel" :aria-labelledby="`${tabId}-${tab}`" tabindex="0">
        <section v-if="tab === 'evidence'" class="finding-detail__section">
          <p v-if="finding.evidence.length === 0" class="finding-detail__muted">{{ labels.noEvidence }}</p>
          <article v-for="(item, index) in finding.evidence" :key="`${item.kind}:${index}`" class="evidence-item">
            <div><span class="evidence-item__kind">{{ item.kind }}</span><code v-if="item.file">{{ item.file }}{{ item.line ? `:${item.line}` : '' }}</code></div>
            <p v-if="item.message">{{ item.message }}</p>
            <p v-if="item.git" class="evidence-item__git"><Icon :icon="inspectorIcons.gitCommit" class="size-3" />{{ item.git.commit.slice(0, 8) }} · {{ item.git.authorName }}<span v-if="item.git.summary"> · {{ item.git.summary }}</span></p>
          </article>
          <PaginationBar
            :offset="finding.evidenceOffset"
            :limit="finding.evidenceLimit"
            :total="finding.evidenceTotal"
            :labels="labels"
            @page="emit('evidencePage', $event)"
          />
        </section>

        <section v-else-if="tab === 'source'" class="finding-detail__section">
          <p v-if="!snippet" class="finding-detail__muted">{{ labels.noSnippet }}</p>
          <div v-else class="code-block" :aria-label="labels.sourceSnippet">
            <div v-for="line in snippetLines" :key="line.number" class="code-line" :class="line.number === snippet.highlightLine && 'code-line--hit'">
              <span class="code-line__number">{{ line.number }}</span><code>{{ line.text || ' ' }}</code>
            </div>
          </div>
        </section>

        <section v-else-if="tab === 'fixes'" class="finding-detail__section">
          <p v-if="finding.suggestions.length === 0" class="finding-detail__muted">{{ labels.noSuggestions }}</p>
          <article v-for="(suggestion, index) in finding.suggestions" :key="index" class="suggestion-item">
            <h3>{{ suggestion.title }}</h3><p v-if="suggestion.description">{{ suggestion.description }}</p>
          </article>
          <div v-if="finding.edits.length" class="finding-detail__edits">
            <h3>{{ labels.editPreview }}</h3>
            <article v-for="(edit, index) in finding.edits" :key="index"><code>{{ edit.file }}:{{ edit.start.line }}</code><pre>{{ edit.newText }}</pre></article>
          </div>
        </section>

        <section v-else class="finding-detail__section">
          <dl class="definition-list">
            <dt>{{ labels.rule }}</dt><dd><code>{{ finding.ruleCode }}</code></dd>
            <dt>{{ labels.rulePack }}</dt><dd>{{ finding.rulePack ?? '—' }}</dd>
            <dt>{{ labels.domain }}</dt><dd>{{ finding.domain ?? '—' }}</dd>
            <dt>{{ labels.source }}</dt><dd><code>{{ finding.source }}</code></dd>
            <dt>{{ labels.tags }}</dt><dd>{{ finding.tags.join(', ') || '—' }}</dd>
          </dl>
        </section>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.finding-detail { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; background: var(--doctor-surface); }
.finding-detail__loading { display: flex; min-height: 12rem; align-items: center; justify-content: center; gap: 8px; color: var(--doctor-muted); }
.finding-detail__header { position: relative; flex: none; border-bottom: 1px solid var(--doctor-border); padding: 22px; }
.finding-detail__badges { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--doctor-muted); font-size: 12px; }
.finding-detail__badges code { overflow-wrap: anywhere; }
.finding-detail__confidence { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.finding-detail__confidence i { width: 6px; height: 6px; border-radius: 50%; background: var(--doctor-faint); }
.finding-detail__confidence i[data-confidence='high'] { background: var(--doctor-accent); }
.finding-detail__confidence i[data-confidence='medium'] { background: var(--doctor-warning-fg); }
.finding-detail__header h2 { margin: 14px 0 10px; font-size: 18px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.finding-detail__location { margin: 0; overflow-wrap: anywhere; color: var(--doctor-muted); font-size: 12px; }
.finding-detail__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
.finding-detail__editor { width: 136px; }
.finding-detail__actions > button { gap: 5px; }
.finding-detail__error { margin: 10px 0 0; color: var(--doctor-error-fg); font-size: 13px; }
.finding-detail__tabs { display: flex; height: 44px; flex: none; gap: 4px; overflow-x: auto; border-bottom: 1px solid var(--doctor-border); padding: 0 12px; }
.finding-detail__tabs button { min-width: max-content; border: 0; border-bottom: 2px solid transparent; background: transparent; padding: 0 10px; color: var(--doctor-muted); cursor: pointer; font-size: 13px; transition: color 120ms, background-color 120ms; }
.finding-detail__tabs button[aria-selected='true'] { border-bottom-color: var(--doctor-accent); color: var(--doctor-text); }
.finding-detail__tabs .num { margin-left: 3px; color: var(--doctor-faint); }
.finding-detail__body { min-height: 0; flex: 1; overflow: auto; animation: inspector-enter 160ms ease-out; }
.finding-detail__section { padding: 22px; }
.finding-detail__muted { color: var(--doctor-muted); font-size: 13px; }
.evidence-item, .suggestion-item { border-bottom: 1px solid var(--doctor-border); padding: 18px 0; overflow-wrap: anywhere; }
.evidence-item:first-child, .suggestion-item:first-child { padding-top: 0; }
.evidence-item > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.evidence-item__kind { color: var(--doctor-accent-fg); font-size: 12px; font-weight: 600; }
.evidence-item code { color: var(--doctor-faint); font-size: 12px; }
.evidence-item p, .suggestion-item p { margin: 8px 0 0; color: var(--doctor-text); font-size: 13px; line-height: 1.65; }
.evidence-item__git { display: flex; align-items: center; gap: 4px; }
.suggestion-item h3, .finding-detail__edits h3 { margin: 0; font-size: 14px; }
.finding-detail__edits { margin-top: 16px; }
.finding-detail__edits article { margin-top: 8px; }
.finding-detail__edits pre { max-width: 100%; overflow: auto; border: 1px solid var(--doctor-border); border-radius: 6px; background: var(--doctor-code); padding: 12px; font-size: 12px; white-space: pre; }
.code-block { min-width: 0; overflow: auto; border: 1px solid var(--doctor-border); border-radius: 6px; background: var(--doctor-code); padding: 10px 0; }
.code-line { display: flex; min-width: max-content; min-height: 23px; font-size: 12px; line-height: 23px; }
.code-line--hit { background: color-mix(in srgb, var(--doctor-warning-fg) 13%, transparent); color: var(--doctor-warning-fg); }
.code-line__number { width: 46px; flex: none; padding-right: 10px; color: var(--doctor-faint); text-align: right; user-select: none; }
.code-line code { padding-right: 12px; white-space: pre; }
.definition-list { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 14px 16px; margin: 0; font-size: 13px; }
.definition-list dt { color: var(--doctor-faint); }
.definition-list dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .finding-detail__header, .finding-detail__section { padding: 18px 16px; }
}
</style>

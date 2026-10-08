<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import type { Diagnostic, DoctorReport } from '@vue-doctor/core'
import EmptyState from './EmptyState.vue'
import {
  confidenceDotClass,
  findLibraryCoverage,
  formatLocation,
  knowledgeClass,
  knowledgeLabel,
  packageLabelFromDiagnostic,
  packageVersionFromMessage,
  primarySourceLocation,
  relativePath,
  severityBadgeClass,
  type EvidenceTab
} from '../lib/evidence'
import {
  primaryHitLocation,
  snippetEndpointFromOpen,
  syntheticSnippet,
  type SnippetPayload
} from '../lib/snippet'
import { inspectorIcons } from '../lib/icons'
import { cn } from '../lib/utils'
import { inspectorButton } from '../lib/variants'
import type { EditorName } from '../composables/useInspectorEditor'
import { categoryForDiagnostic } from '../lib/categories'
import { domainLabel } from '../lib/domains'
import type { InspectorLocale, inspectorMessages } from '../i18n'

const props = defineProps<{
  selected: Diagnostic | null
  report: DoctorReport | null
  labels: (typeof inspectorMessages)[InspectorLocale] & {
    evidence: string
    suggestedFix: string
    rule: string
    confidence: string
    openIn: string
    openFile: string
    editorUnavailable: string
    consumer: string
    noSourceFile: string
    package: string
    declaredVersion: string
    contractProvenance: string
    noContractSources: string
    evidenceLocations: string
    gitAttribution: string
    gitCommit: string
    gitUncommitted: string
    sourceSnippet: string
    noAutomaticFix: string
    copy: string
    severity: string
    whyThisFired: string
    relatedCoverage: string
    selectFindingTitle: string
    selectFindingHint: string
    previous: string
    next: string
  }
  editor: EditorName
  editorOptions: EditorName[]
  opening: boolean
  editorError?: string
  projectRoot?: string
  snippetEndpoint?: string
}>()

const emit = defineEmits<{
  openFile: [file: string, line?: number, column?: number]
  'update:editor': [value: EditorName]
  tag: [value: string]
}>()

const tab = ref<EvidenceTab>('evidence')
const editorMenuOpen = ref(false)
const evidencePage = ref(0)
const visibleEvidence = computed(() => props.selected?.evidence.slice(evidencePage.value * 20, (evidencePage.value + 1) * 20) ?? [])
const snippet = ref<SnippetPayload | null>(null)
const snippetLoading = ref(false)
let snippetSequence = 0
let snippetController: AbortController | undefined
onScopeDispose(() => { snippetSequence++; snippetController?.abort() })

const packageName = computed(() => props.selected ? packageLabelFromDiagnostic(props.selected) : null)
const packageVersion = computed(() =>
  props.selected ? packageVersionFromMessage(props.selected, packageName.value) : undefined
)
const library = computed(() => findLibraryCoverage(props.report, packageName.value))
const consumer = computed(() => props.selected ? primarySourceLocation(props.selected) : undefined)
const consumerPath = computed(() => relativePath(consumer.value?.file, props.projectRoot))
const consumerGit = computed(() => consumer.value?.git)
const evidenceCount = computed(() => props.selected?.evidence.length ?? 0)
const fixCount = computed(() => props.selected?.fixes?.length ?? 0)
const hitSeverity = computed(() => props.selected?.severity ?? 'info')
const ruleDefinition = computed(() => {
  if (!props.selected) return undefined
  for (const pack of props.report?.rulePacks ?? []) {
    const rule = pack.rules.find((item) => item.code === props.selected!.code)
    if (rule) return rule
  }
  return undefined
})

const dimensionEntries = computed(() => {
  if (!library.value) return []
  return (['props', 'events', 'models', 'slots'] as const).map((key) => ({
    key,
    value: library.value!.dimensions[key]
  }))
})

const resolvedSnippetEndpoint = computed(() => {
  if (props.snippetEndpoint) return props.snippetEndpoint
  const open = (document.getElementById('app') as HTMLElement | null)?.dataset.openEditorEndpoint
  return open ? snippetEndpointFromOpen(open) : 'api/snippet'
})

watch(() => props.selected, (item) => {
  tab.value = 'evidence'
  editorMenuOpen.value = false
  evidencePage.value = 0
  void loadSnippet(item)
}, { immediate: true })

async function loadSnippet(item: Diagnostic | null) {
  const sequence = ++snippetSequence
  snippetController?.abort()
  snippetController = new AbortController()
  snippetLoading.value = false
  snippet.value = null
  if (!item) return

  const hit = primaryHitLocation(item)
  const fallback = syntheticSnippet(item)
  snippet.value = fallback
  if (!hit?.file || hit.line === undefined) return

  snippetLoading.value = true
  try {
    const url = new URL(resolvedSnippetEndpoint.value, window.location.href)
    url.searchParams.set('file', hit.file)
    url.searchParams.set('line', String(hit.line))
    if (hit.column !== undefined) url.searchParams.set('column', String(hit.column))
    url.searchParams.set('context', '2')
    const response = await fetch(url, { cache: 'no-store', signal: snippetController.signal })
    if (!response.ok) return
    const payload = await response.json() as SnippetPayload
    if (sequence === snippetSequence && payload?.lines?.length) snippet.value = payload
  } catch {
    // Keep synthetic fallback when host has no snippet endpoint.
  } finally {
    if (sequence === snippetSequence) snippetLoading.value = false
  }
}

function openConsumer() {
  const location = consumer.value
  if (!location?.file) return
  emit('openFile', location.file, location.line, location.column)
}

function openEvidence(file?: string, line?: number, column?: number) {
  if (!file) return
  emit('openFile', file, line, column)
}

function chooseEditor(value: EditorName) {
  emit('update:editor', value)
  editorMenuOpen.value = false
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    // Clipboard may be unavailable in some host contexts; ignore quietly.
  }
}

function lineToneClass(kind: string | undefined, severity: Diagnostic['severity']) {
  if (kind === 'hit') {
    if (severity === 'error') return 'bg-[color-mix(in_srgb,var(--doctor-error-fg)_16%,transparent)] text-[var(--doctor-error-fg)]'
    if (severity === 'warning') return 'bg-[color-mix(in_srgb,var(--doctor-warning-fg)_16%,transparent)] text-[var(--doctor-warning-fg)]'
    return 'bg-[color-mix(in_srgb,var(--doctor-info-fg)_16%,transparent)] text-[var(--doctor-info-fg)]'
  }
  if (kind === 'suggested') return 'bg-[color-mix(in_srgb,var(--doctor-accent)_12%,transparent)] text-[var(--doctor-accent-fg)]'
  return 'text-[var(--doctor-text)]'
}

function gutterMarker(kind: string | undefined) {
  if (kind === 'hit') return '▸'
  if (kind === 'suggested') return '+'
  return ''
}

function shortCommit(commit: string) {
  return commit.slice(0, 8)
}

function formatGitDate(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
</script>

<template>
  <aside class="flex min-h-0 flex-col overflow-hidden bg-[var(--doctor-surface)]">
    <template v-if="selected">
      <div class="shrink-0 border-b border-[var(--doctor-border)] px-4 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                :class="severityBadgeClass(selected.severity)"
              >
                {{ selected.severity }}
              </span>
              <code class="font-mono text-xs text-[var(--doctor-muted)]">{{ selected.code }}</code>
              <span
                v-if="selected.confidence"
                class="inline-flex items-center gap-1 text-[11px] text-[var(--doctor-muted)]"
              >
                <span class="size-1.5 rounded-full" :class="confidenceDotClass(selected.confidence)" />
                {{ selected.confidence }} {{ labels.confidence }}
              </span>
            </div>
            <h2 class="mt-2 text-base font-semibold leading-5">{{ selected.message }}</h2>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-2">
            <div class="flex items-center gap-2">
              <div class="relative">
                <button
                  type="button"
                  class="flex min-h-8 items-center gap-1 rounded border border-[var(--doctor-border)] bg-[var(--doctor-panel)] px-2 text-xs text-[var(--doctor-muted)] hover:text-[var(--doctor-text)]"
                  :aria-label="labels.openIn"
                  @click="editorMenuOpen = !editorMenuOpen"
                >
                  {{ editor }}
                  <Icon :icon="inspectorIcons.chevronDown" class="size-3" />
                </button>
                <div
                  v-if="editorMenuOpen"
                  class="absolute right-0 z-20 mt-1 w-36 rounded border border-[var(--doctor-border)] bg-[var(--doctor-panel)] p-1 shadow-xl"
                >
                  <button
                    v-for="item in editorOptions"
                    :key="item"
                    type="button"
                    class="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--doctor-surface)]"
                    @click="chooseEditor(item)"
                  >
                    {{ item }}
                    <Icon v-if="editor === item" :icon="inspectorIcons.check" class="size-3 text-emerald-400" />
                  </button>
                </div>
              </div>
              <button
                type="button"
                :class="cn(inspectorButton({ intent: 'active', size: 'sm' }), 'gap-1')"
                :disabled="opening || !consumer?.file"
                @click="openConsumer"
              >
                <Icon :icon="inspectorIcons.externalLink" class="size-3.5" />
                {{ labels.openFile }}
              </button>
            </div>
            <p v-if="editorError" class="max-w-72 text-right text-xs text-red-300">
              {{ editorError }}
            </p>
          </div>
        </div>
      </div>

      <div
        class="flex shrink-0 border-b border-[var(--doctor-border)] text-xs text-[var(--doctor-muted)]"
        role="tablist"
        :aria-label="labels.evidence"
      >
        <button
          type="button"
          role="tab"
          class="min-h-8 border-b-2 px-3 py-2 transition-colors"
          :class="tab === 'evidence'
            ? 'border-[var(--doctor-accent)] text-[var(--doctor-text)]'
            : 'border-transparent hover:text-[var(--doctor-text)]'"
          :aria-selected="tab === 'evidence'"
          @click="tab = 'evidence'"
        >
          {{ labels.evidence }}
          <span class="ml-1 tabular-nums text-[var(--doctor-muted)]">({{ evidenceCount }})</span>
        </button>
        <button
          type="button"
          role="tab"
          class="min-h-8 border-b-2 px-3 py-2 transition-colors"
          :class="tab === 'fix'
            ? 'border-[var(--doctor-accent)] text-[var(--doctor-text)]'
            : 'border-transparent hover:text-[var(--doctor-text)]'"
          :aria-selected="tab === 'fix'"
          @click="tab = 'fix'"
        >
          {{ labels.suggestedFix }}
          <span class="ml-1 tabular-nums text-[var(--doctor-muted)]">({{ fixCount }})</span>
        </button>
        <button
          type="button"
          role="tab"
          class="min-h-8 border-b-2 px-3 py-2 transition-colors"
          :class="tab === 'rule'
            ? 'border-[var(--doctor-accent)] text-[var(--doctor-text)]'
            : 'border-transparent hover:text-[var(--doctor-text)]'"
          :aria-selected="tab === 'rule'"
          @click="tab = 'rule'"
        >
          {{ labels.rule }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto p-4">
        <div v-if="tab === 'evidence'" class="space-y-5">
          <section>
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.consumer }}
            </h3>
            <button
              v-if="consumer?.file"
              type="button"
              class="mt-2 flex w-full items-start gap-2 rounded border border-[var(--doctor-border)] bg-[var(--doctor-panel)]/40 px-3 py-2 text-left hover:bg-[var(--doctor-panel)]"
              @click="openConsumer"
            >
              <Icon :icon="inspectorIcons.file" class="mt-0.5 size-4 shrink-0 text-[var(--doctor-accent)]" />
              <span class="min-w-0 break-all font-mono text-xs leading-5">
                {{ formatLocation(consumerPath, consumer.line, consumer.column) }}
              </span>
            </button>
            <p v-else class="mt-2 text-xs text-[var(--doctor-muted)]">{{ labels.noSourceFile }}</p>
          </section>

          <section v-if="consumerGit">
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.gitAttribution }}
            </h3>
            <div class="mt-2 rounded border border-[var(--doctor-border)] bg-[var(--doctor-panel)]/40 px-3 py-2">
              <div class="flex items-center gap-2">
                <Icon :icon="inspectorIcons.gitCommit" class="size-4 shrink-0 text-[var(--doctor-accent)]" />
                <span class="text-xs font-medium">{{ consumerGit.authorName }}</span>
                <code class="rounded bg-[var(--doctor-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--doctor-muted)]">
                  {{ consumerGit.uncommitted ? labels.gitUncommitted : `${labels.gitCommit} ${shortCommit(consumerGit.commit)}` }}
                </code>
              </div>
              <p v-if="consumerGit.summary" class="mt-1 text-xs text-[var(--doctor-text)]">
                {{ consumerGit.summary }}
              </p>
              <time
                v-if="formatGitDate(consumerGit.authoredAt)"
                :datetime="consumerGit.authoredAt"
                class="mt-1 block text-[11px] text-[var(--doctor-muted)]"
              >
                {{ formatGitDate(consumerGit.authoredAt) }}
              </time>
            </div>
          </section>

          <section v-if="packageName">
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.package }}
            </h3>
            <div class="mt-2 rounded border border-[var(--doctor-border)] bg-[var(--doctor-panel)]/40 px-3 py-2">
              <div class="flex items-center gap-2">
                <Icon :icon="inspectorIcons.package" class="size-4 text-[var(--doctor-accent)]" />
                <code class="font-mono text-xs">
                  {{ packageName }}{{ packageVersion ? `@${packageVersion}` : library?.package.installedVersion ? `@${library.package.installedVersion}` : '' }}
                </code>
              </div>
              <p
                v-if="library?.package.declaredVersion"
                class="mt-1 font-mono text-[11px] text-[var(--doctor-muted)]"
              >
                {{ labels.declaredVersion }} {{ library.package.declaredVersion }}
              </p>
            </div>
          </section>

          <section v-if="library">
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.contractProvenance }}
            </h3>
            <div class="mt-2 space-y-2 rounded border border-[var(--doctor-border)] bg-[var(--doctor-panel)]/40 px-3 py-2">
              <div
                v-for="source in library.contractSources"
                :key="`${source.source}:${source.file ?? ''}`"
                class="font-mono text-[11px] text-[var(--doctor-muted)]"
              >
                {{ source.source }}{{ source.file ? ` · ${relativePath(source.file, projectRoot)}` : '' }}
              </div>
              <p v-if="library.contractSources.length === 0" class="text-xs text-[var(--doctor-muted)]">
                {{ labels.noContractSources }}
              </p>
              <div class="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-[var(--doctor-border)] pt-2 text-[11px]">
                <div
                  v-for="entry in dimensionEntries"
                  :key="entry.key"
                  class="flex items-center justify-between gap-2"
                >
                  <span class="text-[var(--doctor-muted)]">{{ entry.key }}</span>
                  <span class="font-mono" :class="knowledgeClass(entry.value)">
                    {{ knowledgeLabel(entry.value) }}
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section v-if="snippet">
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.sourceSnippet }}
            </h3>
            <div class="mt-2 overflow-hidden rounded border border-[var(--doctor-border)] bg-[var(--doctor-code)]">
              <div class="border-b border-[var(--doctor-border)] px-3 py-1.5 font-mono text-[11px] text-[var(--doctor-faint)]">
                {{ relativePath(snippet.file, projectRoot) }}{{ snippet.line ? `:${snippet.line}` : '' }}
                <span v-if="snippetLoading" class="ml-2 text-[var(--doctor-muted)]">…</span>
              </div>
              <div class="overflow-x-auto py-1 font-mono text-[12px] leading-[17px]">
                <div
                  v-for="(line, index) in snippet.lines"
                  :key="`${line.number}:${index}`"
                  class="grid grid-cols-[18px_42px_1fr] items-start gap-1 px-2"
                  :class="lineToneClass(line.kind, hitSeverity)"
                >
                  <span class="select-none text-center text-[11px] opacity-80">{{ gutterMarker(line.kind) }}</span>
                  <span class="select-none text-right text-[var(--doctor-faint)] opacity-80">{{ line.number }}</span>
                  <code class="min-w-0 whitespace-pre">{{ line.text }}</code>
                </div>
              </div>
            </div>
          </section>

          <section>
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.evidenceLocations }}
            </h3>
            <ul v-if="selected.evidence.length > 0" class="mt-2 space-y-1.5">
              <li
                v-for="(entry, index) in visibleEvidence"
                :key="evidencePage * 20 + index"
              >
                <button
                  type="button"
                  class="flex w-full items-start gap-2 rounded border border-[var(--doctor-border)] bg-[var(--doctor-bg)] px-3 py-2 text-left hover:bg-[var(--doctor-panel)] disabled:cursor-default disabled:opacity-80"
                  :disabled="!entry.file"
                  @click="openEvidence(entry.file, entry.line, entry.column)"
                >
                  <span class="mt-0.5 shrink-0 rounded bg-[var(--doctor-panel)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--doctor-muted)]">
                    {{ entry.kind }}
                  </span>
                  <span class="min-w-0">
                    <span class="block break-all font-mono text-xs leading-5">
                      {{ entry.file
                        ? formatLocation(relativePath(entry.file, projectRoot), entry.line, entry.column)
                        : labels.noSourceFile }}
                    </span>
                    <span v-if="entry.message" class="mt-0.5 block text-[11px] text-[var(--doctor-muted)]">
                      {{ entry.message }}
                    </span>
                  </span>
                </button>
              </li>
            </ul>
            <p v-else class="mt-2 text-xs text-[var(--doctor-muted)]">—</p>
            <div v-if="evidenceCount > 20" class="mt-3 flex items-center gap-3">
              <button type="button" :class="inspectorButton({ size: 'sm' })" :disabled="evidencePage === 0" @click="evidencePage--">{{ labels.previous }}</button>
              <span class="text-xs tabular-nums">{{ evidencePage + 1 }} / {{ Math.ceil(evidenceCount / 20) }}</span>
              <button type="button" :class="inspectorButton({ size: 'sm' })" :disabled="(evidencePage + 1) * 20 >= evidenceCount" @click="evidencePage++">{{ labels.next }}</button>
            </div>
          </section>
        </div>

        <div v-else-if="tab === 'fix'">
          <p class="mb-3 text-xs text-[var(--doctor-muted)]">{{ labels.suggestionOnly }}</p>
          <ul v-if="(selected.fixes ?? []).length > 0" class="space-y-2">
            <li
              v-for="(fix, index) in selected.fixes"
              :key="`${fix.title}:${index}`"
              class="rounded border border-[var(--doctor-border)] bg-[var(--doctor-panel)]/40 p-3"
            >
              <div class="flex items-start justify-between gap-2">
                <strong class="text-sm">{{ index + 1 }}. {{ fix.title }}</strong>
                <button
                  v-if="fix.description"
                  type="button"
                  class="grid size-7 place-items-center rounded text-[var(--doctor-muted)] hover:bg-[var(--doctor-panel)] hover:text-[var(--doctor-text)]"
                  :aria-label="labels.copy"
                  :title="labels.copy"
                  @click="copyText(fix.description)"
                >
                  <Icon :icon="inspectorIcons.copy" class="size-3.5" />
                </button>
              </div>
              <p v-if="fix.description" class="mt-1 text-xs leading-5 text-[var(--doctor-muted)]">
                {{ fix.description }}
              </p>
            </li>
          </ul>
          <p v-else class="text-xs text-[var(--doctor-muted)]">{{ labels.noAutomaticFix }}</p>
          <section v-if="selected.edits?.length" class="mt-5">
            <h3 class="text-xs font-semibold">{{ labels.editPreview }}</h3>
            <div v-for="(edit, index) in selected.edits" :key="index" class="mt-2 border-l-2 border-[var(--doctor-border)] pl-3">
              <code class="block break-all text-xs text-[var(--doctor-muted)]">{{ formatLocation(relativePath(edit.file, projectRoot), edit.start.line, edit.start.column) }} → {{ edit.end.line }}:{{ edit.end.column }}</code>
              <pre class="mt-1 whitespace-pre-wrap break-words text-xs">{{ edit.newText }}</pre>
            </div>
          </section>
        </div>

        <div v-else class="space-y-4">
          <section>
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.rule }}
            </h3>
            <div class="mt-2 flex items-center gap-2">
              <code class="rounded border border-[var(--doctor-border)] bg-[var(--doctor-panel)] px-2 py-1 font-mono text-xs">
                {{ selected.code }}
              </code>
              <button
                type="button"
                class="grid size-7 place-items-center rounded text-[var(--doctor-muted)] hover:bg-[var(--doctor-panel)] hover:text-[var(--doctor-text)]"
                :aria-label="labels.copy"
                :title="labels.copy"
                @click="copyText(selected.code)"
              >
                <Icon :icon="inspectorIcons.copy" class="size-3.5" />
              </button>
            </div>
            <template v-if="ruleDefinition">
              <p class="mt-2 text-sm font-medium">{{ ruleDefinition.title }}</p>
              <p class="mt-1 break-words text-sm leading-6 text-[var(--doctor-muted)]">{{ ruleDefinition.description }}</p>
            </template>
            <p class="mt-3 text-xs text-[var(--doctor-muted)]">{{ labels.category }}: {{ domainLabel(categoryForDiagnostic(selected), labels) }}</p>
            <button v-if="selected.rulePack" type="button" class="mt-2 text-xs text-[var(--doctor-accent-fg)] underline underline-offset-2" @click="emit('tag', selected.rulePack)">{{ labels.rulePack }}: {{ selected.rulePack }}</button>
            <div v-if="selected.tags?.length" class="mt-3 flex flex-wrap items-center gap-1.5" :aria-label="labels.tags">
              <button v-for="tag in selected.tags" :key="tag" type="button" :class="inspectorButton({ size: 'sm' })" @click="emit('tag', tag)">{{ tag }}</button>
            </div>
          </section>
          <section>
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.severity }}
            </h3>
            <p class="mt-2 text-sm capitalize">{{ selected.severity }}</p>
          </section>
          <section v-if="selected.confidence">
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.confidence }}
            </h3>
            <p class="mt-2 flex items-center gap-2 text-sm capitalize">
              <span class="size-2 rounded-full" :class="confidenceDotClass(selected.confidence)" />
              {{ selected.confidence }}
            </p>
          </section>
          <section>
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.whyThisFired }}
            </h3>
            <p class="mt-2 text-sm leading-6 text-[var(--doctor-muted)]">{{ selected.message }}</p>
          </section>
          <section v-if="library?.problems?.length">
            <h3 class="text-[10px] font-semibold uppercase tracking-wide text-[var(--doctor-muted)]">
              {{ labels.relatedCoverage }}
            </h3>
            <ul class="mt-2 space-y-2">
              <li
                v-for="problem in library.problems"
                :key="problem.code + problem.message"
                class="rounded border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-100"
              >
                <strong class="font-mono">{{ problem.code }}</strong>
                <p class="mt-1 text-amber-100/80">{{ problem.message }}</p>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </template>

    <EmptyState
      v-else
      compact
      variant="select"
      :title="labels.selectFindingTitle"
      :description="labels.selectFindingHint"
    />
  </aside>
</template>

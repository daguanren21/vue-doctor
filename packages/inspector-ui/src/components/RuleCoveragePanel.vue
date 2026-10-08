<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DoctorReport, DoctorRuleCheck } from '@vue-doctor/core'
import type { InspectorLocale, inspectorMessages } from '../i18n'
import { inspectorButton } from '../lib/variants'
import DomainCoveragePanel from './DomainCoveragePanel.vue'
import { domainLabel } from '../lib/domains'
import { inspectorCheckRows } from '../lib/checks'
import RunDetailsPanel from './RunDetailsPanel.vue'

type Status = DoctorRuleCheck['status'] | 'unreported'
const props = defineProps<{ report: DoctorReport | null; labels: (typeof inspectorMessages)[InspectorLocale]; query: string }>()
const emit = defineEmits<{ findings: [code: string] }>()
const status = ref<Status | ''>('')
const selectedCode = ref('')
const evidencePage = ref(0)
const statuses = computed<Record<Status, string>>(() => ({
  checked: props.labels.checkChecked,
  partial: props.labels.checkPartial,
  'not-applicable': props.labels.checkNotApplicable,
  unavailable: props.labels.checkUnavailable,
  manual: props.labels.checkManual,
  runtime: props.labels.checkRuntime,
  'policy-pending': props.labels.checkPolicyPending,
  disabled: props.labels.checkDisabled,
  unreported: props.labels.checkUnreported
}))
const rows = computed(() => inspectorCheckRows(props.report))
const counts = computed(() => {
  const result = new Map<Status, number>()
  for (const row of rows.value) result.set(row.status, (result.get(row.status) ?? 0) + 1)
  return result
})
const visible = computed(() => {
  const query = props.query.trim().toLowerCase()
  return rows.value.filter((row) => (!status.value || row.status === status.value)
    && (!query || [row.pack, row.rule.domain, row.rule.tags?.join(' '), row.rule.code, row.rule.title, row.rule.description, row.rule.category, row.rule.standards?.join(' '), row.check?.reason].join(' ').toLowerCase().includes(query)))
})
const selected = computed(() => visible.value.find((row) => row.rule.code === selectedCode.value) ?? visible.value[0])
const skippedByCode = computed(() => {
  const map = new Map<string, NonNullable<DoctorReport['skippedChecks']>>()
  for (const skipped of props.report?.skippedChecks ?? []) {
    const items = map.get(skipped.ruleCode)
    if (items) items.push(skipped)
    else map.set(skipped.ruleCode, [skipped])
  }
  return map
})
const skipped = computed(() => selected.value ? skippedByCode.value.get(selected.value.rule.code) ?? [] : [])
const evidence = computed(() => skipped.value.slice(evidencePage.value * 20, (evidencePage.value + 1) * 20))
const findingCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const finding of props.report?.diagnostics ?? []) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1)
  return counts
})
watch(() => selected.value?.rule.code, () => { evidencePage.value = 0 })
watch(() => props.report, () => { evidencePage.value = 0 })
</script>

<template>
  <section class="col-span-2 flex min-h-0 min-w-0 flex-col overflow-hidden max-[1023px]:min-h-[80vh]" :aria-label="labels.ruleCoverage">
    <header class="max-h-[60vh] shrink-0 space-y-2 overflow-auto border-b border-[var(--doctor-border)] px-4 py-3">
      <h1 class="text-sm font-semibold">{{ labels.ruleCoverage }}</h1>
      <p class="text-xs leading-5 text-[var(--doctor-muted)]">{{ labels.ruleCoverageHint }}</p>
      <div class="flex flex-wrap items-center gap-3 text-xs">
        <span>{{ labels.source }}: {{ report?.coverage.source.status ?? '—' }}</span>
        <span v-for="library in report?.coverage.componentLibraries" :key="library.package.canonicalName" class="break-all">
          {{ library.package.canonicalName }}: {{ library.status }}
        </span>
      </div>
      <DomainCoveragePanel :coverage="report?.domainCoverage" :labels="labels" />
      <RunDetailsPanel :report="report" :labels="labels" />
      <details v-if="report?.coverage.source.discoveryIssues?.length" class="text-xs">
        <summary class="cursor-pointer font-semibold">{{ labels.discoveryIssues }} · {{ report.coverage.source.discoveryIssues.length }}</summary>
        <p v-for="issue in report.coverage.source.discoveryIssues" :key="`${issue.kind}:${issue.path}`" class="mt-1 break-words text-[var(--doctor-muted)]">{{ issue.path }} · {{ issue.message }}</p>
      </details>
      <label class="flex flex-wrap items-center gap-2 text-xs">
        <span>{{ labels.checkStatus }}</span>
        <select v-model="status" class="max-w-full rounded border border-[var(--doctor-border)] bg-[var(--doctor-panel)] px-2 py-1.5 text-[var(--doctor-text)]">
          <option value="">{{ labels.checkAll }} · {{ rows.length }}</option>
          <option v-for="(label, value) in statuses" :key="value" :value="value">{{ label }} · {{ counts.get(value) ?? 0 }}</option>
        </select>
      </label>
    </header>
    <div v-if="rows.length === 0" class="overflow-auto p-4 text-xs leading-5 text-[var(--doctor-muted)]">
      <p>{{ labels.noRuleCoverage }}</p>
      <p v-for="(skip, index) in report?.skippedChecks" :key="index" class="mt-3 break-words">{{ skip.ruleCode }} · {{ skip.file }} · {{ skip.evidence.map(item => item.message).join('; ') }}</p>
    </div>
    <div v-else class="grid min-h-0 flex-1 grid-cols-2 max-[900px]:grid-cols-1 max-[900px]:overflow-auto">
      <div class="min-h-0 overflow-auto border-r border-[var(--doctor-border)] max-[900px]:max-h-[45vh] max-[900px]:border-b max-[900px]:border-r-0">
        <p v-if="visible.length === 0" class="p-4 text-xs text-[var(--doctor-muted)]">{{ labels.noCoverageMatches }}</p>
        <button
          v-for="row in visible"
          :key="row.rule.code"
          type="button"
          class="block w-full border-b border-l-2 border-b-[var(--doctor-border)] px-4 py-3 text-left hover:bg-[var(--doctor-panel)]"
          :class="selected?.rule.code === row.rule.code ? 'border-l-[var(--doctor-accent)] bg-[var(--doctor-accent-muted)]' : 'border-l-transparent'"
          :aria-pressed="selected?.rule.code === row.rule.code"
          @click="selectedCode = row.rule.code"
        >
          <span class="block text-xs font-medium leading-5">{{ row.rule.title }}</span>
          <code class="mt-1 block break-all text-[11px] text-[var(--doctor-faint)]">{{ row.rule.code }}</code>
          <span class="mt-1 block text-xs text-[var(--doctor-muted)]">{{ statuses[row.status] }} · {{ findingCounts.get(row.rule.code) ?? 0 }} {{ labels.findingsCount }}</span>
        </button>
      </div>
      <article v-if="selected" class="min-h-0 overflow-auto p-4 text-xs leading-6 max-[900px]:min-h-[35vh]">
        <h2 class="text-sm font-semibold">{{ selected.rule.title }}</h2>
        <code class="mt-2 block break-all text-[var(--doctor-faint)]">{{ selected.rule.code }}</code>
        <p class="mt-3 font-medium">{{ statuses[selected.status] }}</p>
        <p class="mt-2 text-[var(--doctor-muted)]">{{ labels.rulePack }}: {{ selected.pack }} · {{ labels.category }}: {{ domainLabel(selected.rule.domain ?? 'unclassified', labels) }}</p>
        <p v-if="selected.rule.tags?.length" class="mt-1 break-words text-[var(--doctor-muted)]">{{ labels.tags }}: {{ selected.rule.tags.join(', ') }}</p>
        <p v-if="selected.rule.standards?.length" class="mt-2 break-words text-[var(--doctor-muted)]">{{ labels.standards }}: {{ selected.rule.standards.join(', ') }}</p>
        <p class="mt-3 break-words">{{ selected.rule.description }}</p>
        <template v-if="selected.check?.reason && selected.check.reason !== selected.rule.description">
          <h3 class="mt-5 text-xs font-semibold">{{ labels.prerequisite }}</h3>
          <p class="mt-2 break-words text-[var(--doctor-muted)]">{{ selected.check.reason }}</p>
        </template>
        <button v-if="findingCounts.get(selected.rule.code)" type="button" :class="[inspectorButton({ size: 'sm' }), 'mt-4']" @click="emit('findings', selected.rule.code)">{{ labels.showRuleFindings }}</button>
        <section v-if="skipped.length" class="mt-5">
          <h3 class="font-semibold">{{ labels.evidence }} · {{ skipped.length }}</h3>
          <ul class="mt-2 space-y-3">
            <li v-for="(item, index) in evidence" :key="index" class="break-words rounded border border-[var(--doctor-border)] p-2">
              <code v-if="item.file" class="block break-all text-[var(--doctor-faint)]">{{ item.file }}</code>
              <p v-for="(location, locationIndex) in item.evidence" :key="locationIndex">{{ location.line ? `${location.line}: ` : '' }}{{ location.message }}</p>
            </li>
          </ul>
          <div v-if="skipped.length > 20" class="mt-3 flex items-center gap-3">
            <button type="button" :class="inspectorButton({ size: 'sm' })" :disabled="evidencePage === 0" @click="evidencePage--">{{ labels.previous }}</button>
            <span>{{ evidencePage + 1 }} / {{ Math.ceil(skipped.length / 20) }}</span>
            <button type="button" :class="inspectorButton({ size: 'sm' })" :disabled="(evidencePage + 1) * 20 >= skipped.length" @click="evidencePage++">{{ labels.next }}</button>
          </div>
        </section>
      </article>
    </div>
  </section>
</template>

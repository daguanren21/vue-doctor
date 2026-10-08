<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DoctorReport } from '@vue-doctor/core'
import type { InspectorLocale, inspectorMessages } from '../i18n'
import { formatLocation, relativePath } from '../lib/evidence'
import { inspectorButton } from '../lib/variants'

const props = defineProps<{ report: DoctorReport | null; labels: (typeof inspectorMessages)[InspectorLocale] }>()
const page = ref(0)
const audit = computed(() => props.report?.suppressionAudit ?? [])
const visibleAudit = computed(() => audit.value.slice(page.value * 20, (page.value + 1) * 20))
const appliedCount = computed(() => new Set(audit.value
  .filter(item => item.status === 'applied')
  .flatMap(item => item.diagnostics.map(finding => finding.id))).size)
const statuses = computed(() => ({ applied: props.labels.suppressionApplied, unused: props.labels.suppressionUnused, invalid: props.labels.suppressionInvalid }))
watch(() => props.report, () => { page.value = 0 })
</script>

<template>
  <div class="space-y-2 text-xs leading-5">
    <details v-if="report?.run || report?.projectContext">
      <summary class="cursor-pointer font-semibold">{{ labels.runDetails }}</summary>
      <div v-if="report.run" class="mt-2 space-y-1">
        <p>{{ labels.runTarget }}: {{ report.run.target.mode }} · {{ report.run.target.files.length }} {{ labels.runFiles }} · {{ report.run.status }}</p>
        <p v-if="report.run.target.scopes.length" class="mono break-all text-[var(--doctor-muted)]">{{ report.run.target.scopes.join(', ') }}</p>
        <details v-if="report.run.target.files.length">
          <summary class="cursor-pointer">{{ labels.source }}</summary>
          <ul class="mono mt-1 max-h-40 overflow-auto text-[var(--doctor-muted)]">
            <li v-for="file in report.run.target.files" :key="file" class="break-all">{{ file }}</li>
          </ul>
        </details>
      </div>
      <div v-if="report.projectContext" class="mt-2 space-y-1">
        <p>{{ report.projectContext.packages.length }} {{ labels.runPackages }} · {{ report.projectContext.applications.length }} {{ labels.runApplications }}</p>
        <p v-for="item in report.projectContext.packages" :key="item.root" class="mono break-all text-[var(--doctor-muted)]">{{ relativePath(item.root, report.project.root) || '.' }} · Vue {{ item.inventory.vue?.installedVersion ?? item.inventory.vue?.declaredVersion ?? '—' }}</p>
        <p v-for="app in report.projectContext.applications" :key="app.id" class="mono break-all text-[var(--doctor-muted)]">{{ relativePath(app.entryFile, report.project.root) }} · {{ app.framework }} · {{ app.plugins.map(plugin => plugin.package.packageName).join(', ') }}</p>
      </div>
    </details>
    <details v-if="report?.coverage.source.contextIssues?.length">
      <summary class="cursor-pointer font-semibold">{{ labels.contextIssues }} · {{ report.coverage.source.contextIssues.length }}</summary>
      <p v-for="(issue, index) in report.coverage.source.contextIssues" :key="index" class="mt-1 break-words text-[var(--doctor-muted)]">{{ relativePath(issue.file, report.project.root) }} · {{ issue.message }}</p>
    </details>
    <details v-if="audit.length">
      <summary class="cursor-pointer font-semibold">{{ labels.suppressionAudit }} · {{ appliedCount }} / {{ audit.length }}</summary>
      <p class="mt-2 text-[var(--doctor-muted)]">{{ labels.suppressionHint }}</p>
      <ol class="mt-2 space-y-3">
        <li v-for="(item, index) in visibleAudit" :key="index" class="border-l-2 border-[var(--doctor-border)] pl-3">
          <p class="font-medium">{{ statuses[item.status] }} · {{ item.ruleCode ?? '—' }}</p>
          <code class="block break-all text-[var(--doctor-muted)]">{{ formatLocation(relativePath(item.directive.location.file, report?.project.root), item.directive.location.start?.line, item.directive.location.start?.column) }}</code>
          <p v-if="item.reason" class="break-words">{{ labels.suppressionReason }}: {{ item.reason }}</p>
          <p v-if="item.message" class="break-words text-[var(--doctor-muted)]">{{ item.message }}</p>
          <details>
            <summary class="cursor-pointer">{{ labels.evidence }} · {{ item.diagnostics.length }}</summary>
            <code class="block whitespace-pre-wrap break-all">{{ item.directive.text }}</code>
            <div v-for="(finding, findingIndex) in item.diagnostics" :key="`${finding.id}:${findingIndex}`" class="mt-2">
              <p class="break-words">{{ finding.code }} · {{ finding.message }}</p>
              <p v-if="finding.primaryLocation" class="mono break-all text-[var(--doctor-muted)]">{{ formatLocation(relativePath(finding.primaryLocation.file, report?.project.root), finding.primaryLocation.start?.line, finding.primaryLocation.start?.column) }}</p>
              <code class="block break-all text-[var(--doctor-faint)]">{{ finding.id }}</code>
            </div>
          </details>
        </li>
      </ol>
      <nav v-if="audit.length > 20" :aria-label="labels.suppressionAudit" class="mt-3 flex items-center gap-3">
        <button type="button" :class="inspectorButton({ size: 'sm' })" :disabled="page === 0" @click="page--">{{ labels.previous }}</button>
        <span>{{ page + 1 }} / {{ Math.ceil(audit.length / 20) }}</span>
        <button type="button" :class="inspectorButton({ size: 'sm' })" :disabled="(page + 1) * 20 >= audit.length" @click="page++">{{ labels.next }}</button>
      </nav>
    </details>
  </div>
</template>

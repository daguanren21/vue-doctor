<script setup lang="ts">
import { computed } from 'vue'
import type { DoctorDomainCoverage } from '@vue-doctor/core'
import type { InspectorLocale, inspectorMessages } from '../i18n'
import { domainLabel, domainStatusLabel } from '../lib/domains'

const props = defineProps<{
  coverage?: readonly DoctorDomainCoverage[]
  labels: (typeof inspectorMessages)[InspectorLocale]
}>()
const rows = computed(() => props.coverage?.filter(row => row.domain !== 'unclassified' || row.ruleCount || row.diagnosticCount) ?? [])
</script>

<template>
  <details v-if="rows.length" open class="text-xs">
    <summary class="cursor-pointer py-1 font-semibold">{{ labels.domainCoverage }}</summary>
    <p class="my-1 leading-5 text-[var(--doctor-muted)]">{{ labels.domainCoverageHint }}</p>
    <div class="overflow-x-auto">
      <table class="w-full text-left text-[11px]">
        <thead class="text-[var(--doctor-faint)]">
          <tr>
            <th scope="col" class="py-1 pr-3 font-medium">{{ labels.category }}</th>
            <th scope="col" class="py-1 pr-3 font-medium">{{ labels.checkStatus }}</th>
            <th scope="col" class="py-1 pr-3 font-medium">{{ labels.domainRules }}</th>
            <th scope="col" class="py-1 pr-3 font-medium">{{ labels.findings }}</th>
            <th scope="col" class="py-1 font-medium">{{ labels.domainPending }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.domain" class="border-t border-[var(--doctor-border)]">
            <th scope="row" class="py-1 pr-3 font-medium">{{ domainLabel(row.domain, labels) }}</th>
            <td class="py-1 pr-3 text-[var(--doctor-muted)]">{{ domainStatusLabel(row.status, labels) }}</td>
            <td class="num py-1 pr-3">{{ row.ruleCount }}</td>
            <td class="num py-1 pr-3">{{ row.diagnosticCount }}</td>
            <td class="num py-1">{{ row.pendingCheckCount }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </details>
</template>

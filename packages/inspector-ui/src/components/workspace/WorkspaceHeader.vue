<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { InspectorSnapshot } from '@vue-doctor/inspector-protocol'
import type { InspectorMessages, InspectorLocale } from '../../i18n'
import type { InspectorTheme } from '../../composables/useInspectorTheme'
import { inspectorIcons } from '../../lib/icons'
import { inspectorButton } from '../../lib/variants'
import DoctorMark from '../DoctorMark.vue'
import StatusBadge from './StatusBadge.vue'

defineProps<{
  snapshot?: InspectorSnapshot
  labels: InspectorMessages
  locale: InspectorLocale
  theme: InspectorTheme
  running: boolean
  stale: boolean
  exporting: boolean
}>()
const emit = defineEmits<{
  run: []
  export: []
  toggleTheme: []
  toggleLocale: []
}>()
</script>

<template>
  <header class="workspace-header">
    <div class="workspace-header__brand">
      <DoctorMark :size="28" :label="labels.title" />
      <div class="workspace-header__identity">
        <span class="workspace-header__title">{{ labels.title }} <span class="workspace-header__inspector">{{ labels.inspector }}</span></span>
        <span class="workspace-header__project" :title="snapshot?.project.name">{{ snapshot?.project.name ?? labels.waitingProject }}</span>
      </div>
    </div>

    <div v-if="snapshot" class="workspace-header__meta" aria-live="polite">
      <span class="workspace-header__dot" :class="running && 'workspace-header__dot--running'" />
      <span>{{ running ? labels.refreshing : labels.ready }}</span>
      <StatusBadge :status="snapshot.coverageStatus" :label="`${labels.coverage}: ${snapshot.coverageStatus}`" />
      <span v-if="stale" class="workspace-header__stale">{{ labels.staleReport }}</span>
    </div>

    <div class="workspace-header__actions">
      <button type="button" :class="inspectorButton({ intent: 'ghost', size: 'sm' })" :aria-label="labels.exportReport" :disabled="exporting || !snapshot" @click="emit('export')">
        <Icon :icon="inspectorIcons.download" class="size-3.5" />
        <span class="workspace-header__action-label">{{ exporting ? labels.exporting : labels.exportReport }}</span>
      </button>
      <button type="button" :class="inspectorButton({ intent: 'active', size: 'sm' })" :aria-label="labels.runAgain" :disabled="running || !snapshot" @click="emit('run')">
        <Icon :icon="inspectorIcons.refresh" class="size-3.5" :class="running && 'animate-spin'" />
        <span class="workspace-header__action-label">{{ labels.runAgain }}</span>
      </button>
      <button type="button" :class="inspectorButton({ intent: 'ghost', size: 'icon' })" :aria-label="labels.language" @click="emit('toggleLocale')">
        <span class="text-xs font-semibold">{{ locale === 'zh' ? '中' : 'EN' }}</span>
      </button>
      <button type="button" :class="inspectorButton({ intent: 'ghost', size: 'icon' })" :aria-label="labels.themeToggle" @click="emit('toggleTheme')">
        <Icon :icon="theme === 'dark' ? inspectorIcons.moon : inspectorIcons.sun" class="size-3.5" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.workspace-header {
  display: flex;
  min-height: 68px;
  flex: none;
  align-items: center;
  gap: 24px;
  border-bottom: 1px solid var(--doctor-border);
  background: var(--doctor-surface);
  padding: 10px 20px;
}
.workspace-header__brand { display: flex; min-width: 0; align-items: center; gap: 10px; }
.workspace-header__identity { display: grid; min-width: 0; gap: 1px; }
.workspace-header__title { color: var(--doctor-muted); font-size: 12px; font-weight: 600; }
.workspace-header__inspector { margin-left: 4px; color: var(--doctor-faint); font-weight: 400; }
.workspace-header__project { max-width: 22rem; overflow: hidden; font-size: 16px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.workspace-header__meta { display: flex; min-width: 0; align-items: center; gap: 8px; color: var(--doctor-muted); font-size: 12px; }
.workspace-header__dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--doctor-accent); }
.workspace-header__dot--running { background: var(--doctor-warning-fg); }
.workspace-header__stale { overflow: hidden; color: var(--doctor-warning-fg); text-overflow: ellipsis; white-space: nowrap; }
.workspace-header__actions { display: flex; margin-left: auto; align-items: center; gap: 3px; }
.workspace-header__actions button { gap: 6px; }
@media (max-width: 980px) {
  .workspace-header__meta { display: none; }
}
@media (max-width: 760px) {
  .workspace-header { min-height: 64px; gap: 8px; padding: 8px 12px; }
  .workspace-header__inspector, .workspace-header__action-label { display: none; }
  .workspace-header__project { max-width: 10rem; font-size: 14px; }
  .workspace-header__actions button { min-width: 40px; min-height: 40px; }
}
</style>

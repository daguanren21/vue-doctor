<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { InspectorSnapshot, InspectorWorkspaceRoute } from '@vue-doctor/inspector-protocol'
import type { InspectorMessages } from '../../i18n'
import { inspectorWorkspaceViews } from '../../lib/icons'

defineProps<{
  route: InspectorWorkspaceRoute
  snapshot?: InspectorSnapshot
  labels: InspectorMessages
}>()
const emit = defineEmits<{ navigate: [route: InspectorWorkspaceRoute] }>()

</script>

<template>
  <nav class="workspace-nav" :aria-label="labels.navigation">
    <button
      v-for="entry in inspectorWorkspaceViews"
      :key="entry.id"
      type="button"
      class="workspace-nav__item"
      :class="route === entry.id && 'workspace-nav__item--active'"
      :aria-current="route === entry.id ? 'page' : undefined"
      @click="emit('navigate', entry.id)"
    >
      <Icon :icon="entry.icon" class="size-3.5" />
      <span>{{ labels[entry.id] }}</span>
      <span v-if="entry.id === 'findings'" class="num workspace-nav__count">{{ snapshot?.counts.findings ?? '—' }}</span>
      <span v-else-if="entry.id === 'audit'" class="num workspace-nav__count">{{ snapshot?.counts.suppressed ?? '—' }}</span>
    </button>
  </nav>
</template>

<style scoped>
.workspace-nav {
  display: flex;
  min-height: 46px;
  flex: none;
  align-items: stretch;
  gap: 8px;
  overflow-x: auto;
  border-bottom: 1px solid var(--doctor-border);
  background: var(--doctor-surface);
  padding: 0 20px;
}
.workspace-nav__item {
  position: relative;
  display: inline-flex;
  min-width: max-content;
  align-items: center;
  gap: 6px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  padding: 0 12px;
  color: var(--doctor-muted);
  cursor: pointer;
  font-size: 13px;
  transition: background-color 150ms, color 150ms;
}
.workspace-nav__item:hover { background: var(--doctor-panel); color: var(--doctor-text); }
.workspace-nav__item--active { border-bottom-color: var(--doctor-accent); background: var(--doctor-accent-muted); color: var(--doctor-accent-fg); }
.workspace-nav__count { min-width: 20px; border-radius: 4px; background: var(--doctor-panel); padding: 0 5px; color: var(--doctor-muted); font-size: 11px; }
@media (max-width: 760px) {
  .workspace-nav { gap: 0; padding: 0 8px; }
  .workspace-nav__item { flex: 1; justify-content: center; gap: 5px; padding: 0 8px; }
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { inspectorIcons } from '../../lib/icons'

const props = defineProps<{
  status: string
  label?: string
}>()

const tone = computed(() => {
  if (['error', 'blocked', 'invalid'].includes(props.status)) return 'danger'
  if (['warning', 'partial', 'runtime', 'manual', 'policy-pending', 'unavailable', 'unused', 'not-covered', 'not-reported'].includes(props.status)) return 'warning'
  if (['complete', 'checked', 'applied'].includes(props.status)) return 'success'
  return 'neutral'
})
const icon = computed(() => {
  if (tone.value === 'danger') return inspectorIcons.octagonAlert
  if (tone.value === 'warning') return inspectorIcons.alert
  if (tone.value === 'success') return inspectorIcons.check
  return inspectorIcons.circleDashed
})
</script>

<template>
  <span class="status-badge" :data-tone="tone">
    <Icon :icon="icon" class="size-3" />
    <span>{{ label ?? status }}</span>
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-flex;
  min-height: 20px;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--doctor-border-strong);
  border-radius: 4px;
  padding: 1px 6px;
  color: var(--doctor-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}
.status-badge[data-tone='danger'] { border-color: color-mix(in srgb, var(--doctor-error-fg) 35%, transparent); background: var(--doctor-error-bg); color: var(--doctor-error-fg); }
.status-badge[data-tone='warning'] { border-color: color-mix(in srgb, var(--doctor-warning-fg) 35%, transparent); background: var(--doctor-warning-bg); color: var(--doctor-warning-fg); }
.status-badge[data-tone='success'] { border-color: color-mix(in srgb, var(--doctor-accent) 38%, transparent); background: var(--doctor-accent-muted); color: var(--doctor-accent-fg); }
</style>

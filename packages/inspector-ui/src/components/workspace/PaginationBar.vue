<script setup lang="ts">
import type { InspectorMessages } from '../../i18n'
import { inspectorButton } from '../../lib/variants'

const props = defineProps<{
  offset: number
  limit: number
  total: number
  labels: InspectorMessages
}>()
const emit = defineEmits<{ page: [offset: number] }>()
</script>

<template>
  <nav v-if="total > limit" class="pagination" :aria-label="labels.currentPage">
    <button
      type="button"
      :class="inspectorButton({ size: 'sm' })"
      :disabled="offset === 0"
      @click="emit('page', Math.max(0, offset - limit))"
    >
      {{ labels.previous }}
    </button>
    <span class="num" :aria-label="labels.resultRange">
      {{ offset + 1 }}–{{ Math.min(offset + limit, total) }} / {{ total }}
    </span>
    <button
      type="button"
      :class="inspectorButton({ size: 'sm' })"
      :disabled="offset + limit >= total"
      @click="emit('page', offset + limit)"
    >
      {{ labels.next }}
    </button>
  </nav>
</template>

<style scoped>
.pagination {
  display: flex;
  min-height: 48px;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--doctor-border);
  padding: 6px 12px;
  color: var(--doctor-muted);
  font-size: 12px;
}
</style>

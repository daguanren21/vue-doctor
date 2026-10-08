<script setup lang="ts">
import { computed, useId } from 'vue'
import { Icon } from '@iconify/vue'
import { inspectorButton } from '../lib/variants'

export type EmptyStateVariant = 'select' | 'clean' | 'filter' | 'incomplete' | 'error' | 'loading'

const props = withDefaults(defineProps<{
  variant?: EmptyStateVariant
  title: string
  description?: string
  actionLabel?: string
  compact?: boolean
}>(), {
  variant: 'select',
  compact: false
})

const emit = defineEmits<{
  action: []
}>()
const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
const glowId = `emptyGlow-${uid}`
const panelId = `emptyPanel-${uid}`
const haloId = `emptyHalo-${uid}`

const illustrationLabel = computed(() => {
  switch (props.variant) {
    case 'clean':
      return 'Clean analysis illustration'
    case 'filter':
      return 'Filtered findings illustration'
    case 'incomplete':
      return 'Incomplete coverage illustration'
    case 'error':
      return 'Report error illustration'
    case 'loading':
      return 'Loading report illustration'
    default:
      return 'Select finding illustration'
  }
})
</script>

<template>
  <div
    class="empty-state"
    :class="compact ? 'empty-state--compact' : 'empty-state--full'"
    role="status"
  >
    <div class="empty-state__art" aria-hidden="true">
      <svg
        class="empty-state__svg"
        viewBox="0 0 160 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        :aria-label="illustrationLabel"
      >
        <defs>
          <linearGradient :id="glowId" x1="28" y1="18" x2="132" y2="104" gradientUnits="userSpaceOnUse">
            <stop stop-color="#42d392" stop-opacity="0.28" />
            <stop offset="1" stop-color="#42d392" stop-opacity="0.04" />
          </linearGradient>
          <linearGradient :id="panelId" x1="42" y1="24" x2="118" y2="98" gradientUnits="userSpaceOnUse">
            <stop stop-color="#232833" />
            <stop offset="1" stop-color="#171b22" />
          </linearGradient>
          <radialGradient :id="haloId" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(80 58) rotate(90) scale(46 58)">
            <stop stop-color="#42d392" stop-opacity="0.18" />
            <stop offset="1" stop-color="#42d392" stop-opacity="0" />
          </radialGradient>
        </defs>

        <ellipse cx="80" cy="98" rx="42" ry="8" fill="#0b0d11" opacity="0.55" />
        <circle cx="80" cy="58" r="48" :fill="`url(#${haloId})`" />
        <rect x="36" y="22" width="88" height="72" rx="14" :fill="`url(#${glowId})`" />
        <rect x="42" y="28" width="76" height="60" rx="12" :fill="`url(#${panelId})`" stroke="#303743" />
        <path d="M54 42h36M54 52h28M54 62h32" stroke="#3a4250" stroke-width="3" stroke-linecap="round" />

        <!-- select: scan cursor -->
        <g v-if="variant === 'select'">
          <rect x="68" y="40" width="24" height="24" rx="6" stroke="#42d392" stroke-width="2" stroke-dasharray="4 3" opacity="0.9" />
          <path d="M94 66l10 10" stroke="#42d392" stroke-width="3" stroke-linecap="round" />
          <circle cx="90" cy="62" r="10" stroke="#42d392" stroke-width="2.5" />
          <path d="M72 40v-4M88 40v-4M72 64v4M88 64v4M68 44h-4M68 56h-4M92 44h4M92 56h4" stroke="#42d392" stroke-width="2" stroke-linecap="round" opacity="0.7" />
        </g>

        <!-- clean: check badge -->
        <g v-else-if="variant === 'clean'">
          <circle cx="98" cy="70" r="16" fill="#123528" stroke="#42d392" stroke-width="2" />
          <path d="M91 70.5l4.5 4.5 9-10" stroke="#42d392" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M54 42h28M54 52h20" stroke="#3f8f6b" stroke-width="3" stroke-linecap="round" opacity="0.55" />
        </g>

        <!-- filter: funnel + empty result -->
        <g v-else-if="variant === 'filter'">
          <path d="M58 38h44l-14 16v14l-16 8V54L58 38z" fill="#1a2a24" stroke="#42d392" stroke-width="2" stroke-linejoin="round" />
          <circle cx="104" cy="74" r="12" fill="#171b22" stroke="#95a0ad" stroke-width="2" />
          <path d="M99 74h10M104 69v10" stroke="#95a0ad" stroke-width="2" stroke-linecap="round" transform="rotate(45 104 74)" />
        </g>

        <!-- incomplete: partial ring -->
        <g v-else-if="variant === 'incomplete'">
          <circle cx="98" cy="70" r="16" stroke="#3a4250" stroke-width="4" />
          <path d="M98 54a16 16 0 0 1 16 16" stroke="#e7b955" stroke-width="4" stroke-linecap="round" />
          <path d="M98 64v8M98 78.5h.01" stroke="#e7b955" stroke-width="2.5" stroke-linecap="round" />
        </g>

        <!-- error: alert -->
        <g v-else-if="variant === 'error'">
          <path d="M98 52l14 26H84l14-26z" fill="#3a1719" stroke="#ef6b73" stroke-width="2" stroke-linejoin="round" />
          <path d="M98 62v8M98 76.5h.01" stroke="#ef6b73" stroke-width="2.5" stroke-linecap="round" />
        </g>

        <!-- loading: orbit -->
        <g v-else-if="variant === 'loading'" class="empty-state__loading">
          <circle cx="98" cy="70" r="14" stroke="#303743" stroke-width="3" />
          <path d="M98 56a14 14 0 0 1 14 14" stroke="#42d392" stroke-width="3" stroke-linecap="round" />
          <circle cx="112" cy="70" r="2.5" fill="#42d392" />
        </g>
      </svg>
    </div>

    <div class="empty-state__copy">
      <h3 class="empty-state__title">{{ title }}</h3>
      <p v-if="description" class="empty-state__description">{{ description }}</p>
      <button
        v-if="actionLabel"
        type="button"
        :class="inspectorButton({ intent: variant === 'error' ? 'danger' : 'active', size: 'sm' })"
        class="empty-state__action"
        @click="emit('action')"
      >
        <Icon v-if="variant === 'filter'" icon="lucide:list-filter" class="size-3.5" />
        <Icon v-else-if="variant === 'error' || variant === 'loading'" icon="lucide:refresh-cw" class="size-3.5" />
        <Icon v-else-if="variant === 'incomplete'" icon="lucide:scan-search" class="size-3.5" />
        <span>{{ actionLabel }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 14px;
  width: 100%;
  min-height: 100%;
  margin: 0 auto;
  padding: 28px 20px;
  text-align: center;
  color: var(--doctor-muted);
}

.empty-state--compact {
  min-height: 12rem;
  padding: 20px 16px;
  gap: 10px;
}

.empty-state--full {
  min-height: min(100%, 22rem);
}

.empty-state__art {
  display: grid;
  place-items: center;
  width: min(100%, 11rem);
}

.empty-state__svg {
  width: 100%;
  height: auto;
  max-width: 10.5rem;
  filter: drop-shadow(0 10px 24px rgb(0 0 0 / 0.28));
}

.empty-state__copy {
  display: grid;
  gap: 6px;
  max-width: 18rem;
}

.empty-state__title {
  margin: 0;
  color: var(--doctor-text);
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.35;
}

.empty-state__description {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--doctor-muted);
}

.empty-state__action {
  justify-self: center;
  gap: 0.35rem;
  margin-top: 8px;
  min-width: 7.5rem;
}

.empty-state__loading {
  transform-origin: 98px 70px;
  animation: empty-orbit 1.1s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .empty-state__loading {
    animation: none;
  }
}

@keyframes empty-orbit {
  to {
    transform: rotate(360deg);
  }
}
</style>

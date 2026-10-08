<script setup lang="ts">
withDefaults(defineProps<{
  size?: number | string
  label?: string
}>(), {
  size: 20,
  label: 'Vue Doctor'
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    fill="none"
    role="img"
    :aria-label="label"
    class="shrink-0 text-[var(--doctor-accent)]"
  >
    <title>{{ label }}</title>
    <path
      d="M9.5 9.5 L16 23.5 L22.5 9.5"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M12 15 H20"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      opacity="0.9"
    />
    <circle cx="16" cy="15" r="1.85" fill="currentColor" />
  </svg>
</template>

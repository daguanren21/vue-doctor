<script setup lang="ts">
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { Icon } from '@iconify/vue'
import {
  ComboboxAnchor, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxItemIndicator,
  ComboboxPortal, ComboboxRoot, ComboboxTrigger, ComboboxViewport,
  SelectContent, SelectItem, SelectItemIndicator, SelectItemText, SelectPortal,
  SelectRoot, SelectTrigger, SelectViewport
} from 'reka-ui'
import { inspectorIcons } from '../../lib/icons'

export interface InspectorSelectOption {
  value: string
  label: string
  count?: number
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  options: InspectorSelectOption[]
  icon?: string
  neutralValue?: string
  searchable?: boolean
  searchPlaceholder?: string
  emptyLabel?: string
  disabled?: boolean
  hideLabel?: boolean
  highlightSelection?: boolean
}>(), { neutralValue: '', searchable: false, disabled: false, hideLabel: false, highlightSelection: true })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const id = useId()
const control = useTemplateRef<HTMLDivElement>('control')
const open = shallowRef(false)
const query = shallowRef('')
const selected = computed(() => props.options.find(option => option.value === props.modelValue)
  ?? { value: props.modelValue, label: props.modelValue })
const active = computed(() => props.highlightSelection && props.modelValue !== props.neutralValue)
const matches = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return term ? props.options.filter(option => `${option.label} ${option.value}`.toLocaleLowerCase().includes(term)) : props.options
})

function select(option: InspectorSelectOption) {
  emit('update:modelValue', option.value)
}

function openWithArrow(event: KeyboardEvent) {
  if (!open.value) (event.currentTarget as HTMLButtonElement).click()
}

watch(open, (isOpen, _previous, onCleanup) => {
  query.value = ''
  if (!isOpen || !control.value) return
  const dismissIfHidden = () => {
    if (!control.value?.getClientRects().length) open.value = false
  }
  // Only observe an open control; portal content must close when its trigger is hidden.
  const observer = new ResizeObserver(dismissIfHidden)
  observer.observe(control.value)
  window.addEventListener('resize', dismissIfHidden)
  onCleanup(() => {
    observer.disconnect()
    window.removeEventListener('resize', dismissIfHidden)
  })
})
</script>

<template>
  <div ref="control" class="inspector-select">
    <label :id="`${id}-label`" :for="id" :class="hideLabel ? 'sr-only' : 'inspector-select__label'">{{ label }}</label>
    <ComboboxRoot
      v-if="searchable"
      v-model:open="open"
      :model-value="selected"
      :disabled="disabled"
      by="value"
      ignore-filter
      @update:model-value="select"
    >
      <ComboboxAnchor as-child>
        <ComboboxTrigger
          :id="id"
          class="inspector-select__trigger"
          :data-doctor-select="label"
          :data-active="active"
          :aria-label="undefined"
          :aria-labelledby="`${id}-label ${id}-value`"
          :title="selected.label"
          tabindex="0"
          @keydown.down.up.prevent="openWithArrow"
        >
          <Icon v-if="icon" :icon="icon" class="inspector-select__icon" aria-hidden="true" />
          <span :id="`${id}-value`" class="inspector-select__value">{{ selected.label }}</span>
          <span v-if="active && selected.count !== undefined" class="inspector-select__count num">{{ selected.count }}</span>
          <Icon :icon="inspectorIcons.chevronDown" class="inspector-select__chevron" aria-hidden="true" />
        </ComboboxTrigger>
      </ComboboxAnchor>
      <ComboboxPortal>
        <ComboboxContent position="popper" align="start" :side-offset="5" :collision-padding="8" class="inspector-select__content inspector-select__content--searchable">
          <div class="inspector-select__search">
            <Icon :icon="inspectorIcons.search" class="inspector-select__icon" aria-hidden="true" />
            <ComboboxInput v-model="query" :display-value="() => ''" :aria-label="searchPlaceholder" :placeholder="searchPlaceholder" class="inspector-select__input" />
          </div>
          <ComboboxViewport class="inspector-select__viewport">
            <div v-if="!matches.length" role="status" class="inspector-select__empty">{{ emptyLabel }}</div>
            <ComboboxItem v-for="option in matches" :key="option.value" :value="option" :disabled="option.disabled" :text-value="option.label" :data-neutral="option.value === neutralValue" class="inspector-select__option">
              <span class="inspector-select__option-label">{{ option.label }}</span>
              <span v-if="option.count !== undefined" class="inspector-select__option-count num">{{ option.count }}</span>
              <span class="inspector-select__indicator"><ComboboxItemIndicator><Icon :icon="inspectorIcons.check" aria-hidden="true" /></ComboboxItemIndicator></span>
            </ComboboxItem>
          </ComboboxViewport>
        </ComboboxContent>
      </ComboboxPortal>
    </ComboboxRoot>
    <SelectRoot v-else v-model:open="open" :model-value="selected" :disabled="disabled" by="value" @update:model-value="select">
      <SelectTrigger :id="id" class="inspector-select__trigger" :data-doctor-select="label" :data-active="active" :aria-labelledby="`${id}-label`" :title="selected.label">
        <Icon v-if="icon" :icon="icon" class="inspector-select__icon" aria-hidden="true" />
        <span class="inspector-select__value">{{ selected.label }}</span>
        <Icon :icon="inspectorIcons.chevronDown" class="inspector-select__chevron" aria-hidden="true" />
      </SelectTrigger>
      <SelectPortal>
        <SelectContent position="popper" align="start" :side-offset="5" :collision-padding="8" class="inspector-select__content">
          <SelectViewport class="inspector-select__viewport">
            <SelectItem v-for="option in options" :key="option.value" :value="option" :disabled="option.disabled" :data-neutral="option.value === neutralValue" class="inspector-select__option">
              <SelectItemText class="inspector-select__option-label">{{ option.label }}</SelectItemText>
              <span class="inspector-select__indicator"><SelectItemIndicator><Icon :icon="inspectorIcons.check" aria-hidden="true" /></SelectItemIndicator></span>
            </SelectItem>
          </SelectViewport>
        </SelectContent>
      </SelectPortal>
    </SelectRoot>
  </div>
</template>

<style scoped>
.inspector-select { min-width: 0; }
.inspector-select__label { display: block; margin: 0 1px 6px; color: var(--doctor-muted); font-size: 12px; font-weight: 500; }
.inspector-select__trigger { display: flex; width: 100%; min-width: 0; height: 36px; align-items: center; gap: 8px; border: 1px solid var(--doctor-border-strong); border-radius: 6px; background: var(--doctor-bg); padding: 0 10px; color: var(--doctor-text); cursor: pointer; text-align: left; font-size: 13px; }
.inspector-select__trigger:hover { border-color: var(--doctor-muted); background: var(--doctor-panel); }
.inspector-select__trigger[data-active='true'] { border-color: color-mix(in srgb, var(--doctor-accent) 50%, var(--doctor-border)); background: var(--doctor-accent-muted); }
.inspector-select__trigger:focus-visible, .inspector-select__trigger[data-state='open'] { border-color: var(--doctor-accent-fg); outline: 2px solid var(--doctor-accent-fg); outline-offset: 2px; }
.inspector-select__trigger:disabled { opacity: .5; cursor: not-allowed; }
.inspector-select__value { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inspector-select__icon { width: 14px; height: 14px; flex: none; color: var(--doctor-muted); }
.inspector-select__count { flex: none; color: var(--doctor-accent-fg); font-size: 11px; }
.inspector-select__chevron { width: 12px; height: 12px; flex: none; color: var(--doctor-muted); transition: transform 150ms ease-out; }
.inspector-select__trigger[data-state='open'] .inspector-select__chevron { transform: rotate(180deg); }
:global(.inspector-select__content) { z-index: 50; width: var(--reka-select-trigger-width); max-width: calc(100vw - 16px); max-height: var(--reka-select-content-available-height); overflow: hidden; border: 1px solid var(--doctor-border-strong); border-radius: 7px; background: var(--doctor-overlay); box-shadow: var(--doctor-shadow-overlay); color: var(--doctor-text); }
:global(.inspector-select__content--searchable) { width: max(var(--reka-combobox-trigger-width), 320px); max-height: var(--reka-combobox-content-available-height); }
.inspector-select__search { display: flex; flex: none; align-items: center; gap: 7px; margin: 5px 5px 0; border: 1px solid var(--doctor-border-strong); border-radius: 4px; background: var(--doctor-bg); padding: 0 8px; }
.inspector-select__search:focus-within { border-color: var(--doctor-accent-fg); }
.inspector-select__input { min-width: 0; width: 100%; height: 36px; border: 0; outline: 0 !important; background: transparent; color: var(--doctor-text); font-size: 13px; }
.inspector-select__input::placeholder { color: var(--doctor-muted); }
:global(.inspector-select__viewport) { min-height: 0; max-height: 280px; overflow: auto; overscroll-behavior: contain; padding: 5px; }
.inspector-select__option { display: flex; min-height: 36px; align-items: center; gap: 10px; border-radius: 4px; padding: 8px 10px; outline: 0; cursor: pointer; font-size: 13px; line-height: 19px; }
.inspector-select__option[data-highlighted] { background: var(--doctor-panel); }
.inspector-select__option[data-state='checked'] { background: var(--doctor-accent-muted); color: var(--doctor-accent-fg); }
.inspector-select__option[data-neutral='true'] { margin-bottom: 4px; border-bottom: 1px solid var(--doctor-border-strong); border-radius: 4px 4px 0 0; padding-bottom: 9px; }
.inspector-select__option[data-disabled] { opacity: .5; cursor: not-allowed; }
.inspector-select__option-label { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.inspector-select__option-count { flex: none; color: var(--doctor-muted); font-size: 11px; }
.inspector-select__indicator { width: 14px; height: 14px; flex: none; color: var(--doctor-accent-fg); }
.inspector-select__indicator svg { width: 14px; height: 14px; }
.inspector-select__empty { padding: 16px 10px; color: var(--doctor-muted); font-size: 12px; }
@media (pointer: coarse) {
  .inspector-select__trigger { min-height: 40px; }
}
</style>

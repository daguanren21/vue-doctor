import { computed, ref } from 'vue'
import { defaultInspectorLocale, inspectorMessages, type InspectorLocale } from '../i18n'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type DocumentLike = { documentElement: Pick<HTMLElement, 'lang'> }


export interface InspectorLocaleOptions {
  language?: string
  storage?: StorageLike
  document?: DocumentLike
}

export function useInspectorLocale(options: InspectorLocaleOptions = {}) {
  const storage = options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  const document = options.document ?? (typeof globalThis.document === 'undefined' ? undefined : globalThis.document)
  const persisted = storage?.getItem('vue-doctor:locale')
  const locale = ref<InspectorLocale>(persisted === 'zh' || persisted === 'en' ? persisted : defaultInspectorLocale(options.language ?? (typeof navigator === 'undefined' ? undefined : navigator.language)))
  const messages = computed(() => inspectorMessages[locale.value])

  function setLocale(value: InspectorLocale) {
    locale.value = value
    storage?.setItem('vue-doctor:locale', value)
    if (document) document.documentElement.lang = value
  }

  if (document) document.documentElement.lang = locale.value

  return { locale, messages, setLocale }
}

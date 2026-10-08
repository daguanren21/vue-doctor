import { onMounted, ref } from 'vue'

export type InspectorTheme = 'dark' | 'light'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function useInspectorTheme(options: {
  storage?: StorageLike
  document?: Document
  matchMedia?: (query: string) => MediaQueryList
} = {}) {
  const storage = options.storage
    ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  const documentRef = options.document
    ?? (typeof globalThis.document === 'undefined' ? undefined : globalThis.document)
  const matchMedia = options.matchMedia
    ?? (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia.bind(globalThis) : undefined)

  const persisted = storage?.getItem('vue-doctor:theme')
  const initial: InspectorTheme = persisted === 'light' || persisted === 'dark'
    ? persisted
    : matchMedia?.('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark'

  const theme = ref<InspectorTheme>(initial)

  function apply(value: InspectorTheme) {
    theme.value = value
    storage?.setItem('vue-doctor:theme', value)
    documentRef?.documentElement.setAttribute('data-theme', value)
  }

  function toggleTheme() {
    apply(theme.value === 'dark' ? 'light' : 'dark')
  }

  onMounted(() => apply(theme.value))
  if (documentRef) documentRef.documentElement.setAttribute('data-theme', theme.value)

  return { theme, setTheme: apply, toggleTheme }
}

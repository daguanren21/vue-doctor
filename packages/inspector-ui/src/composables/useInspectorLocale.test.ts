import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useInspectorLocale } from './useInspectorLocale'

describe('useInspectorLocale', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('uses persisted locale before browser language and updates document language', () => {
    const storage = new Map([['vue-doctor:locale', 'en']])
    const document = { documentElement: { lang: '' } }

    const state = useInspectorLocale({
      language: 'zh-CN',
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value)
      },
      document
    })

    expect(state.locale.value).toBe('en')
    state.setLocale('zh')
    expect(state.locale.value).toBe('zh')
    expect(storage.get('vue-doctor:locale')).toBe('zh')
    expect(document.documentElement.lang).toBe('zh')
    expect(state.messages.value.openFile).toBe('在编辑器中打开')
  })

  test('falls back to Chinese browser language when no locale is persisted', () => {
    const state = useInspectorLocale({ language: 'zh-Hant' })
    expect(state.locale.value).toBe('zh')
  })
})

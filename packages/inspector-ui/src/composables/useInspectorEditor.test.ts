import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useInspectorEditor } from './useInspectorEditor'

describe('useInspectorEditor', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test.each(['vscode', 'cursor', 'webstorm'] as const)('persists %s and posts the source location', async (editor) => {
    const storage = new Map<string, string>()
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const state = useInspectorEditor('/api/open', {
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value)
      },
      fetcher
    })

    state.setEditor(editor)
    expect(storage.get('vue-doctor:editor')).toBe(editor)
    const restored = useInspectorEditor('/api/open', {
      storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
      fetcher
    })
    expect(restored.editor.value).toBe(editor)
    await expect(state.openFile('/project/src/App.vue', 12, 4)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledWith('/api/open', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ editor, file: '/project/src/App.vue', line: 12, column: 4 })
    }))
    expect(state.error.value).toBeUndefined()
  })

  test.each(['sublime', 'system', 'unknown'])('falls back from the saved unsupported editor %s', saved => {
    const state = useInspectorEditor('/api/open', {
      storage: { getItem: () => saved, setItem: vi.fn() },
      fetcher: vi.fn()
    })
    expect(state.editor.value).toBe('vscode')
  })

  test('returns a localized-ready error when the host rejects the request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'editor unavailable' }), { status: 500 }))
    const state = useInspectorEditor('/api/open', { fetcher })

    await expect(state.openFile('/project/src/App.vue')).resolves.toBe(false)
    expect(state.error.value).toBe('editor unavailable')
  })
})

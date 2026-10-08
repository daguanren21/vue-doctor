import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const bootstrapUrl = new URL('../../public/hub-bootstrap.js', import.meta.url).href
const { default: bootstrap } = await import(bootstrapUrl) as {
  default(context: {
    clientType: string
    docks: {
      selectedId: string | null
      entries: Array<{ id: string; url?: string }>
      switchEntry(id: string): Promise<unknown>
      getStateById?(id: string): { domElements: { iframe: { contentWindow: object } } }
      register?(entry: { id: string; visibility: string }): unknown
    }
  }): void
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

test('reload opens the real entry when the persisted virtual tab has not been announced', async () => {
  const switchEntry = vi.fn(async () => true)
  bootstrap({ clientType: 'standalone', docks: { selectedId: 'vue-doctor:coverage', entries: [{ id: 'vue-doctor' }], switchEntry } })
  // The Hub waits for script setup before activating an iframe; activation must be deferred.
  expect(switchEntry).not.toHaveBeenCalled()
  await vi.runAllTimersAsync()
  expect(switchEntry).toHaveBeenCalledExactlyOnceWith('vue-doctor')
})

test('keeps a valid existing selection', async () => {
  const switchEntry = vi.fn(async () => true)
  bootstrap({ clientType: 'standalone', docks: { selectedId: '~settings', entries: [{ id: 'vue-doctor' }, { id: '~settings' }], switchEntry } })
  await vi.runAllTimersAsync()
  expect(switchEntry).not.toHaveBeenCalled()
})

test('embedded hosts keep control of their initial selection', async () => {
  const switchEntry = vi.fn(async () => true)
  bootstrap({ clientType: 'embedded', docks: { selectedId: null, entries: [{ id: 'vue-doctor' }], switchEntry } })
  await vi.runAllTimersAsync()
  expect(switchEntry).not.toHaveBeenCalled()
})

test('keeps the launch entry on a settings reload until trusted replacement tabs exist', async () => {
  let onMessage: ((event: MessageEvent) => void) | undefined
  const frameWindow = {}
  vi.stubGlobal('window', {
    location: { href: 'https://hub.example/vue-doctor/' },
    addEventListener: (_type: string, listener: typeof onMessage) => { onMessage = listener },
    removeEventListener: () => { onMessage = undefined }
  })
  const register = vi.fn()
  const switchEntry = vi.fn(async () => true)
  const entries = [{ id: 'vue-doctor', url: '/vue-doctor/vue-doctor/' }, { id: '~settings' }]
  bootstrap({ clientType: 'standalone', docks: {
    selectedId: '~settings', entries, switchEntry, register,
    getStateById: () => ({ domElements: { iframe: { contentWindow: frameWindow } } })
  } })
  await vi.runAllTimersAsync()
  expect(switchEntry).not.toHaveBeenCalled()
  expect(register).not.toHaveBeenCalled()

  const data = { channel: 'devframe:frame-nav', v: 1, frameId: 'vue-doctor', from: 'frame', type: 'ready',
    tabs: ['findings', 'coverage', 'rules', 'audit'].map(id => ({ id })) }
  onMessage?.({ origin: 'https://other.example', source: frameWindow, data } as unknown as MessageEvent)
  expect(register).not.toHaveBeenCalled()
  onMessage?.({ origin: 'https://hub.example', source: {}, data } as unknown as MessageEvent)
  expect(register).not.toHaveBeenCalled()
  onMessage?.({ origin: 'https://hub.example', source: frameWindow, data } as unknown as MessageEvent)
  // A frame can announce ready before the Hub has registered its virtual tabs.
  await vi.runAllTimersAsync()
  expect(register).not.toHaveBeenCalled()
  expect(onMessage).toBeDefined()
  entries.push(...data.tabs.map(tab => ({ id: `vue-doctor:${tab.id}` })))
  onMessage?.({ origin: 'https://hub.example', source: frameWindow, data: { ...data, type: 'manifest' } } as unknown as MessageEvent)
  await vi.runAllTimersAsync()
  expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'vue-doctor', visibility: 'false' }))
  expect(onMessage).toBeUndefined()
})

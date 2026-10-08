import { computed, effectScope, nextTick, ref } from 'vue'
import { expect, test, vi } from 'vitest'
import { useFrameNavigation } from './useFrameNavigation'

test('uses the published frame-nav envelope and follows host navigation', async () => {
  let onMessage: ((event: MessageEvent) => void) | undefined
  const postMessage = vi.fn()
  const parent = { postMessage }
  const windowRef = {
    parent,
    location: { hash: '' },
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { onMessage = listener },
    removeEventListener: () => { onMessage = undefined }
  }
  const route = ref<'findings' | 'coverage' | 'rules' | 'audit'>('findings')
  const navigate = vi.fn((next: typeof route.value) => { route.value = next })
  const scope = effectScope()
  scope.run(() => useFrameNavigation({
    frameId: 'vue-doctor',
    route,
    labels: computed(() => ({ findings: 'Findings', coverage: 'Coverage', rules: 'Rules', audit: 'Audit' })),
    navigate,
    window: windowRef as unknown as Pick<Window, 'parent' | 'location' | 'addEventListener' | 'removeEventListener'>,
    document: { referrer: 'https://hub.example/devtools' }
  }))

  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    channel: 'devframe:frame-nav', v: 1, frameId: 'vue-doctor', from: 'frame', type: 'ready', current: 'findings'
  }), 'https://hub.example')
  const ready = postMessage.mock.calls[0]![0]
  expect(ready.tabs.map((tab: { id: string }) => tab.id)).toEqual(['findings', 'coverage', 'rules', 'audit'])

  onMessage?.({
    origin: 'https://hub.example',
    source: parent,
    data: { channel: 'devframe:frame-nav', v: 1, frameId: 'vue-doctor', from: 'host', type: 'navigate', tabId: 'coverage', navTarget: { path: '/coverage' } }
  } as unknown as MessageEvent)
  await nextTick()
  expect(navigate).toHaveBeenCalledWith('coverage')
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'navigated', tabId: 'coverage', navTarget: { path: '/coverage' } }), 'https://hub.example')
  scope.stop()
})

import { onScopeDispose, watch, type Ref } from 'vue'
import type { FrameNavFrameMessage, FrameNavHostMessage, FrameTab } from '@devframes/hub/client'
import type { InspectorRoute } from './useInspectorRoute'
import { inspectorWorkspaceViews } from '../lib/icons'

const frameNavChannel = 'devframe:frame-nav'
const frameNavVersion = 1

type FrameWindow = Pick<Window, 'parent' | 'location' | 'addEventListener' | 'removeEventListener'>

type FramePayload =
  | { type: 'ready' | 'manifest'; tabs: FrameTab[]; current?: string }
  | { type: 'navigated'; tabId?: string; navTarget?: { path: string; query?: Record<string, string> } }

function parentOrigin(documentRef: Pick<Document, 'referrer'> | undefined): string | undefined {
  if (!documentRef?.referrer) return undefined
  try {
    return new URL(documentRef.referrer).origin
  } catch {
    return undefined
  }
}

export function useFrameNavigation(options: {
  frameId: string
  route: Readonly<Ref<InspectorRoute>>
  labels: Readonly<Ref<Record<InspectorRoute, string>>>
  navigate: (route: InspectorRoute) => void
  window?: FrameWindow
  document?: Pick<Document, 'referrer'>
}) {
  const windowRef = options.window ?? (typeof window === 'undefined' ? undefined : window)
  const documentRef = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const origin = parentOrigin(documentRef)
  const embedded = Boolean(windowRef && origin && windowRef.parent !== windowRef)

  function tabs(): FrameTab[] {
    return inspectorWorkspaceViews.map(({ id, icon }, order) => ({
      id,
      title: options.labels.value[id],
      icon,
      navTarget: { path: `/${id}` },
      order
    }))
  }

  function post(payload: FramePayload) {
    if (!embedded || !origin || !windowRef) return
    const message = {
      channel: frameNavChannel,
      v: frameNavVersion,
      frameId: options.frameId,
      from: 'frame',
      ...payload
    } as FrameNavFrameMessage
    windowRef.parent.postMessage(message, origin)
  }

  function onMessage(event: MessageEvent) {
    if (!embedded || event.origin !== origin || event.source !== windowRef?.parent) return
    const message = event.data as FrameNavHostMessage | undefined
    if (
      !message
      || message.channel !== frameNavChannel
      || message.v !== frameNavVersion
      || message.frameId !== options.frameId
      || message.from !== 'host'
    ) return

    if (message.type === 'hello') {
      post({ type: 'ready', tabs: tabs(), current: options.route.value })
      post({ type: 'manifest', tabs: tabs(), current: options.route.value })
      return
    }
    if (message.type === 'navigate') {
      const route = message.tabId
      if (route === 'findings' || route === 'coverage' || route === 'rules' || route === 'audit') {
        options.navigate(route)
      }
    }
  }

  if (embedded && windowRef) {
    windowRef.addEventListener('message', onMessage)
    post({ type: 'ready', tabs: tabs(), current: options.route.value })
  }

  const stopRoute = watch(options.route, (route) => {
    post({ type: 'navigated', tabId: route, navTarget: { path: `/${route}` } })
  })
  const stopLabels = watch(options.labels, () => {
    post({ type: 'manifest', tabs: tabs(), current: options.route.value })
  })

  onScopeDispose(() => {
    stopRoute()
    stopLabels()
    windowRef?.removeEventListener('message', onMessage)
  })

  return { embedded }
}

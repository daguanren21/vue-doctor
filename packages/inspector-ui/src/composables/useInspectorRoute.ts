import { onScopeDispose, readonly, shallowRef } from 'vue'

export const inspectorRoutes = ['findings', 'coverage', 'rules', 'audit'] as const
export type InspectorRoute = (typeof inspectorRoutes)[number]

function routeFromHash(hash: string): InspectorRoute {
  const value = hash.replace(/^#\/?/, '').split(/[?&]/, 1)[0]
  return inspectorRoutes.includes(value as InspectorRoute) ? value as InspectorRoute : 'findings'
}

export function useInspectorRoute(options: {
  window?: Pick<Window, 'location' | 'addEventListener' | 'removeEventListener'>
} = {}) {
  const windowRef = options.window ?? (typeof window === 'undefined' ? undefined : window)
  const current = shallowRef<InspectorRoute>(routeFromHash(windowRef?.location.hash ?? ''))

  function syncFromHash() {
    current.value = routeFromHash(windowRef?.location.hash ?? '')
  }

  function navigate(route: InspectorRoute) {
    if (!inspectorRoutes.includes(route)) return
    current.value = route
    if (windowRef && routeFromHash(windowRef.location.hash) !== route) {
      windowRef.location.hash = `/${route}`
    }
  }

  windowRef?.addEventListener('hashchange', syncFromHash)
  onScopeDispose(() => windowRef?.removeEventListener('hashchange', syncFromHash))

  return { current: readonly(current), navigate }
}

import { ref } from 'vue'

export function useInspectorNavigation() {
  const expanded = ref(new Set(['overview', 'category', 'severity']))
  const sidebarCollapsed = ref(false)
  const filtersOpen = ref(false)
  function toggle(id: string) {
    const next = new Set(expanded.value)
    next.has(id) ? next.delete(id) : next.add(id)
    expanded.value = next
  }
  return { expanded, sidebarCollapsed, filtersOpen, toggle }
}

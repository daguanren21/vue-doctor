import { computed, getCurrentScope, onScopeDispose, readonly, ref } from 'vue'
import type { DoctorReport } from '@vue-doctor/core'
import { getDoctorReportSchemaVersion, isSupportedDoctorReport } from '@vue-doctor/core/report-schema'

export function useInspectorReport(endpoint = 'api/report.json', request: typeof fetch = fetch) {
  const report = ref<DoctorReport | null>(null)
  const loading = ref(true)
  const error = ref<string>()
  const incomplete = computed(() => report.value?.coverage.status !== 'complete')
  const statusLabel = computed(() => loading.value ? 'Loading report' : error.value ? 'Report unavailable' : incomplete.value ? `Coverage ${report.value?.coverage.status}` : 'Analysis complete')
  let sequence = 0
  let controller: AbortController | undefined
  if (getCurrentScope()) onScopeDispose(() => { sequence++; controller?.abort() })

  async function loadReport() {
    const current = ++sequence
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = undefined
    try {
      const response = await request(endpoint, { cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error(`Report request failed (${response.status})`)
      const value: unknown = await response.json()
      if (!isSupportedDoctorReport(value)) {
        throw new Error(getDoctorReportSchemaVersion(value) === undefined
          ? 'Unsupported Doctor report schema version.'
          : 'Invalid Doctor report data.')
      }
      if (current === sequence) report.value = value
    } catch (cause) {
      if (current !== sequence) return
      report.value = null
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (current === sequence) loading.value = false
    }
  }

  return { report, loading: readonly(loading), error: readonly(error), incomplete, statusLabel, loadReport }
}

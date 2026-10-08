import type { DoctorReport, DoctorRunOptions } from '@vue-doctor/core'
import type { VueDoctorViteServices } from './vite.js'

export interface HostDoctorAnalysisSession {
  run(): Promise<DoctorReport>
  invalidate(pathOrPaths?: string | readonly string[]): void
  close(): Promise<void>
}

export function createHostDoctorSession(services: VueDoctorViteServices, options: DoctorRunOptions): HostDoctorAnalysisSession {
  if (services.createAnalysisSession) return services.createAnalysisSession(options)
  // Preserve custom runDoctor service injection while still sharing concurrent requests.
  let generation = 0
  let closed = false
  let closing: Promise<void> | undefined
  const pending = new Map<number, Promise<DoctorReport>>()
  return {
    run() {
      if (closed) return Promise.reject(new Error('Doctor analysis session is closed.'))
      const existing = pending.get(generation)
      if (existing) return existing
      const current = generation
      const promise = Promise.resolve().then(() => services.runDoctor(options)).finally(() => {
        if (pending.get(current) === promise) pending.delete(current)
      })
      pending.set(current, promise)
      return promise
    },
    invalidate() { generation++ },
    close() {
      if (closing) return closing
      closed = true
      closing = Promise.allSettled([...pending.values()]).then(() => { pending.clear() })
      return closing
    }
  }
}

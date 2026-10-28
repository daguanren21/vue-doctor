import type { DoctorConfig, DoctorRunOptions } from '@daguanren21/vue-doctor-core'

export type VueDoctorRunMode = 'serve' | 'build' | 'both'

export interface VueDoctorViteOptions {
  run?: VueDoctorRunMode
  mode?: 'warn'
  inspector?: boolean
  scope?: DoctorRunOptions['scope']
  config?: DoctorConfig
}

export type VueDoctorUnpluginOptions = VueDoctorViteOptions

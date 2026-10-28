import type { Plugin } from 'vite'
import { vueDoctorVite } from '@daguanren21/vue-doctor-unplugin'
import type { VueDoctorViteOptions } from './plugin.js'

export type { VueDoctorRunMode, VueDoctorViteOptions } from './plugin.js'

export function vueDoctor(options: VueDoctorViteOptions = {}): Plugin {
  return vueDoctorVite(options)
}

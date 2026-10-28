import type { Plugin as VitePlugin } from 'vite'
import { vueDoctorVite } from '@daguanren21/vue-doctor-unplugin'
import type { VueDoctorViteOptions } from '@daguanren21/vue-doctor-unplugin/options'

export type { VueDoctorRunMode, VueDoctorViteOptions } from '@daguanren21/vue-doctor-unplugin/options'

export const vueDoctor: (options?: VueDoctorViteOptions) => VitePlugin = vueDoctorVite

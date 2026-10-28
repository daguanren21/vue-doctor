import type { Plugin as EsbuildPlugin } from 'esbuild'
import { vueDoctorEsbuild } from '@daguanren21/vue-doctor-unplugin'
import type { VueDoctorUnpluginOptions as VueDoctorEsbuildOptions } from '@daguanren21/vue-doctor-unplugin/options'

export type { VueDoctorEsbuildOptions }

export const vueDoctor: (options?: VueDoctorEsbuildOptions) => EsbuildPlugin = vueDoctorEsbuild
export { vueDoctor as default }

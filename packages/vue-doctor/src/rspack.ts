import type { RspackPluginInstance } from '@rspack/core'
import { vueDoctorRspack } from '@daguanren21/vue-doctor-unplugin'
import type { VueDoctorUnpluginOptions as VueDoctorRspackOptions } from '@daguanren21/vue-doctor-unplugin/options'

export type { VueDoctorRspackOptions }

export const vueDoctor: (options?: VueDoctorRspackOptions) => RspackPluginInstance = vueDoctorRspack
export { vueDoctor as default }

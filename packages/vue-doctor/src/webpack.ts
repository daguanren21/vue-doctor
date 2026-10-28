import type { WebpackPluginInstance } from 'webpack'
import { vueDoctorWebpack } from '@daguanren21/vue-doctor-unplugin'
import type { VueDoctorUnpluginOptions as VueDoctorWebpackOptions } from '@daguanren21/vue-doctor-unplugin/options'

export type { VueDoctorWebpackOptions }

export const vueDoctor: (options?: VueDoctorWebpackOptions) => WebpackPluginInstance = vueDoctorWebpack
export { vueDoctor as default }

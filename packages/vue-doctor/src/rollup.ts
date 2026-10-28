import type { Plugin as RollupPlugin } from 'rollup'
import { vueDoctorRollup } from '@daguanren21/vue-doctor-unplugin'
import type { VueDoctorUnpluginOptions as VueDoctorRollupOptions } from '@daguanren21/vue-doctor-unplugin/options'

export type { VueDoctorRollupOptions }

export const vueDoctor: (options?: VueDoctorRollupOptions) => RollupPlugin = vueDoctorRollup
export { vueDoctor as default }

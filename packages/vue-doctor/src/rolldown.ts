import type { Plugin as RolldownPlugin } from 'rolldown'
import { vueDoctorRolldown } from '@daguanren21/vue-doctor-unplugin'
import type { VueDoctorUnpluginOptions as VueDoctorRolldownOptions } from '@daguanren21/vue-doctor-unplugin/options'

export type { VueDoctorRolldownOptions }

export const vueDoctor: (options?: VueDoctorRolldownOptions) => RolldownPlugin = vueDoctorRolldown
export { vueDoctor as default }
